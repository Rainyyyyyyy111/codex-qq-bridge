#!/usr/bin/env python3
"""Private, local dispatcher interface. All output and evidence input use JSON."""
import argparse
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

from trigger import StalePage, TriggerQueue

STATE = Path(os.environ.get("QQ_BRIDGE_STATE", Path.home() / "Library/Application Support/CodexQQBridge"))
ROUTE = os.environ.get("QQ_BRIDGE_ROUTE", "mac")


def bridge_call(name, args):
    adapter = os.environ.get("QQ_MENTION_ADAPTER")
    if adapter:
        result = subprocess.run([os.environ["QQ_MENTION_NODE"], adapter, os.environ["QQ_MENTION_DATA"], "rpc", name],
                                input=json.dumps(args), capture_output=True, encoding="utf-8", timeout=40)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "Group listener unavailable")
        return json.loads(result.stdout)
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(30)
        sock.connect("bridge.sock")
        sock.sendall(json.dumps({"name": name, "args": args}, ensure_ascii=False).encode() + b"\n")
        with sock.makefile("rb") as stream:
            reply = json.load(stream)
    if "error" in reply:
        raise RuntimeError(reply["error"])
    return reply["value"]


def history(after=None, source_id=None):
    args = {} if after is None else {"after": str(after)}
    if source_id is not None:
        args["id"] = source_id
    return bridge_call("trigger_page", args)


def check_scope(page, queue):
    if (page["group"], page["owner"], page["account"]) != (queue.group, queue.owner, queue.account):
        raise ValueError("Live QQ identity changed")


def run(args):
    live = history()
    path = Path("tasks.sqlite3")
    if args.action != "arm" and not path.is_file():
        raise ValueError("Task dispatcher requires local enablement (arm)")
    q = TriggerQueue(path, live["group"], live["owner"], live["account"], ROUTE,
                     live["account"], int(live["top"]), allow_init=args.action == "arm")
    try:
        cursor = q.db.execute("SELECT cursor FROM scope").fetchone()[0]
        if args.action == "replay":
            if args.seq < 1 or args.seq > int(live["top"]):
                raise ValueError("Sequence outside current group history")
            page = history(args.seq - 1)
            check_scope(page, q)
            matches = [r for r in page["rows"] if r["msgId"] == args.msg_id and int(r["msgSeq"]) == args.seq]
            if len(matches) != 1:
                raise ValueError("Native sequence and message ID did not match")
            # Explicit local one-message replay. Identity, route and uniqueness still apply.
            q.observe(matches[0], replay=True)
            if not q.db.execute("SELECT 1 FROM tasks WHERE msg_id=?", (args.msg_id,)).fetchone():
                raise ValueError("Message failed the authenticated plain-text route check")
        if args.action in ("claim", "sync"):
            while cursor < int(live["top"]):
                page = history(cursor)
                check_scope(page, q)
                if not page["rows"]:
                    raise ValueError("History unavailable; retaining cursor")
                try:
                    q.page(cursor, page["rows"])
                except StalePage:
                    cursor = q.db.execute("SELECT cursor FROM scope").fetchone()[0]
                    continue
                cursor = int(page["rows"][-1]["msgSeq"])
            if args.action == "claim":
                return q.claim() or q.recovery()
        if args.action == "created":
            receipt = json.load(sys.stdin)
            q.created(args.msg_id, host=receipt.get("hostId"), thread_id=receipt.get("threadId"),
                      client_id=receipt.get("clientThreadId"), resolves=receipt.get("resolves"))
        if args.action == "verified":
            evidence = json.load(sys.stdin)
            q.verified(args.msg_id, evidence["hostId"], evidence["threadId"], evidence["firstPrompt"])
        rows = q.db.execute("""SELECT t.msg_id,t.seq,t.state,t.host,t.thread_id,t.client_id,t.origin,t.reply_state,
            m.action,m.root_id,m.source_id,m.turn_id,m.reply_seq,c.intent,c.delivery,c.ack_state,c.activity
            FROM tasks t LEFT JOIN mention_turns m USING(msg_id) LEFT JOIN group_chat c USING(msg_id)
            ORDER BY seq DESC LIMIT 25""")
        return {"group": q.group, "account": q.account, "owner": q.owner, "armedAfter": q.enabled_after,
                "cursor": cursor, "top": live["top"], "recent": [dict(zip(
                    ("msgId", "seq", "state", "hostId", "threadId", "clientThreadId", "origin", "replyState",
                     "action", "rootMsgId", "sourceMsgId", "turnId", "replySeq", "chatIntent", "workDelivery", "ackState", "activity"), row)) for row in rows]}
    finally:
        q.db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("arm", "sync", "status", "claim"):
        sub.add_parser(name)
    for name in ("created", "verified", "replay"):
        subparser = sub.add_parser(name)
        subparser.add_argument("msg_id")
        if name == "replay":
            subparser.add_argument("seq", type=int)
    args = parser.parse_args()
    marker = Path(__file__).with_name("installed-profile")
    if marker.is_file() and marker.read_text().strip() != os.environ.get("QQ_BRIDGE_PROFILE", "default"):
        sys.exit("Use the installed bridge trigger command to select the correct profile")
    os.umask(0o077)
    os.chdir(STATE)
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except (OSError, ValueError, RuntimeError) as err:
        sys.exit(str(err))
