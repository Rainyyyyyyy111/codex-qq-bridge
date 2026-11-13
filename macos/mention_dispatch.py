"""Dispatch verified group conversations independently of persistent local work threads."""
import hashlib
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import shutil
import select
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager

from mention_routing import ASK, plan, stored
from group_chat import WORK, prepare_chat, desk_row
from trigger import TriggerQueue
from triggerctl import ROUTE, STATE, bridge_call, history

CODEX = Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")
WAKE = STATE / "mention-wake"
REVIEW = STATE / "mention-review"
MARKER = re.compile(r"([1-9][0-9]*)_(-?[1-9][0-9]*)")


def codex_cli():
    return os.environ.get("QQ_MENTION_CODEX") or (CODEX if CODEX.is_file() else shutil.which("codex"))


class RpcRejected(RuntimeError):
    pass


class AppServer:
    def __enter__(self):
        cli = codex_cli()
        if not cli:
            raise FileNotFoundError("Codex CLI not found")
        profile = os.environ.get("QQ_BRIDGE_PROFILE", "default")
        bridge = "qq-bridge" if profile == "default" else "qq-bridge-" + profile
        self.proc = subprocess.Popen(
            [str(cli), "-c", f'mcp_servers.{bridge}={{command="codex",enabled=false}}', "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.incoming = Queue()
        self.completed = {}
        self.activity = None
        self.serial = 0
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.call("initialize", {"clientInfo": {"name": "qq_mention", "title": "QQ Mention", "version": "1.0"},
                                     "capabilities": {"experimentalApi": True}})
            self.send({"method": "initialized"})
        except BaseException:
            self.close()
            raise
        return self

    def _read(self):
        try:
            for line in self.proc.stdout:
                msg = json.loads(line)
                if "id" in msg or msg.get("method") in ("turn/completed","item/started","item/completed"):
                    self.incoming.put(msg)
        finally:
            self.incoming.put(None)

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def next(self, deadline):
        try:
            msg = self.incoming.get(timeout=max(0, deadline - time.monotonic()))
        except Empty:
            raise TimeoutError("Codex App Server response timeout") from None
        if msg is None:
            raise ConnectionError("Codex App Server closed its connection")
        if msg.get("method") == "turn/completed":
            turn = msg["params"]["turn"]
            self.completed[turn["id"]] = turn["status"]
        elif msg.get("method") in ("item/started", "item/completed"):
            if self.activity:
                self.activity(msg)
        elif "method" in msg and "id" in msg:
            # This unattended client has no human approval or interactive input channel.
            self.send({"id": msg["id"], "error": {"code": -32601, "message": "Interactive request unavailable"}})
        else:
            return msg

    def call(self, method, params):
        self.serial += 1
        self.send({"id": self.serial, "method": method, "params": params})
        deadline = time.monotonic() + 60
        while True:
            msg = self.next(deadline)
            if msg and msg.get("id") == self.serial:
                if "error" in msg:
                    raise RpcRejected(f"{method}: {msg['error'].get('message', 'RPC failed')}")
                return msg["result"]

    def wait_turn(self, turn_id, poll=None):
        while turn_id not in self.completed:
            # Quiet long-running jobs are allowed to finish.
            try:
                if poll:
                    poll()
                self.next(time.monotonic() + (0.35 if poll else 600))
            except TimeoutError:
                if self.proc.poll() is not None:
                    raise
        return self.completed.pop(turn_id)

    def close(self):
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdout.close()

    def __exit__(self, *exc):
        self.close()


def first_prompt(server, thread_id, title):
    cursor = None
    while True:
        page = server.call("thread/list", {"searchTerm": title, "limit": 100, "cursor": cursor,
                                           "sourceKinds": ["appServer", "vscode", "cli"], "modelProviders": []})
        if any(t["id"] == thread_id for t in page["data"]):
            break
        cursor = page.get("nextCursor")
        if not cursor:
            return None
    thread = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})["thread"]
    if thread["id"] != thread_id:
        raise ValueError("Codex thread identity mismatch")
    for turn in thread["turns"]:
        for item in turn["items"]:
            if item["type"] == "userMessage":
                content = item["content"]
                if len(content) == 1 and content[0]["type"] == "text":
                    return content[0]["text"]
                raise ValueError("Unexpected first user input")
    return None


def verify(server, q, key, thread_id):
    for delay in (0, 0.25, 0.5, 1, 2, 4):
        if delay:
            time.sleep(delay)
        prompt = first_prompt(server, thread_id, "QQ-" + q.route.upper() + "-" + key)
        if prompt is not None:
            q.verified(key, "local", thread_id, prompt)
            return
    raise RuntimeError("Codex history has no matching first user message yet")


def role_prompt(route):
    device = "Windows" if route == "win" else "Mac"
    return (
        f"你在 {device} 端处理绑定 QQ 群中人类控制者点名的工作。每一轮用户消息对应一次点名。"
        "续聊沿用本对话和原任务目录。另开任务使用独立目录，若桥接附有参考稿，只将其当作材料。"
        "只把本机实际核对过的情况写成事实。每轮最终答复会作为纯文本发回原群，"
        "只写适合全群公开的内容。不要自行发信、呼叫其他账号或操作桥接队列、arm、replay。"
    )


def read_thread(server, thread_id):
    thread = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})["thread"]
    if thread["id"] != thread_id:
        raise ValueError("Codex thread identity mismatch")
    return thread


def user_text(turn):
    user = next((item for item in turn["items"] if item["type"] == "userMessage"), None)
    if user is None:
        return None
    content = user["content"]
    if len(content) != 1 or content[0].get("type") != "text":
        raise ValueError("Unexpected QQ turn input")
    return content[0]["text"]


def final_answer(server, thread_id, expected_prompt, turn_id=None):
    thread = read_thread(server, thread_id)
    for turn in thread["turns"]:
        if turn_id and turn.get("id") != turn_id:
            continue
        prompt = user_text(turn)
        if prompt is None:
            continue
        if prompt != expected_prompt:
            raise ValueError("Turn input differs from the controller mention")
        if turn["status"] in ("failed", "interrupted"):
            raise ValueError("Turn ended without a deliverable final answer")
        if turn["status"] == "inProgress":
            raise ThreadBusy()
        if turn["status"] != "completed":
            break
        for item in reversed(turn["items"]):
            if item["type"] == "agentMessage" and item.get("phase") == "final_answer" and item["text"].strip():
                return item["text"]
        last = turn["items"][-1]
        if last["type"] == "agentMessage" and last.get("phase") is None and last["text"].strip():
            return last["text"]
        break
    raise RuntimeError("Turn has no completed final answer yet")


class ThreadBusy(Exception):
    """Yield the worker slot while an earlier turn owns this thread."""


def prior_material(server, q, task):
    src = stored(q, task["source_id"])
    if src["published"] is not None:
        return src["published"]
    # Published by the previous bridge: only its first verified turn was sent.
    if src["action"] is None and src["state"] == "dispatched" and src["thread_id"]:
        answer = final_answer(server, src["thread_id"], src["body"])
        # Old receipts lack the text. Only carry a prefix guaranteed to fit in the old group reply.
        if len(answer.encode("utf-16-le")) <= 7600:
            return answer
        return answer.encode("utf-16-le")[:7400].decode("utf-16-le", errors="ignore") + "…（原群终答节选）"
    raise ValueError("Published source text unavailable")


def steer_pending(server, q, root_id, thread_id, turn_id):
    row = q.db.execute("""SELECT c.msg_id,t.body FROM group_chat c JOIN tasks t USING(msg_id)
        JOIN mention_turns m USING(msg_id) WHERE m.root_id=? AND c.delivery='queued'
        ORDER BY t.seq LIMIT 1""", (root_id,)).fetchone()
    if not row:
        return
    key, body = row
    q.db.execute("UPDATE group_chat SET delivery='sending',work_turn=? WHERE msg_id=?", (turn_id,key))
    client_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"qq:{q.account}/{q.group}/{key}"))
    try:
        reply = server.call("turn/steer", {"threadId":thread_id,"expectedTurnId":turn_id,
                            "clientUserMessageId":client_id, "input":[{"type":"text","text":body,"text_elements":[]}]})
        if reply.get("turnId") != turn_id:
            raise ValueError("Work turn changed")
    except RpcRejected:
        # An explicit rejection did not apply this input. Run it as the next normal turn.
        q.db.execute("UPDATE group_chat SET delivery='next' WHERE msg_id=?", (key,))
        return
    except (OSError, RuntimeError, ValueError):
        q.db.execute("UPDATE group_chat SET delivery='uncertain' WHERE msg_id=?", (key,))
        return
    with q.transaction():
        q.db.execute("UPDATE group_chat SET delivery='accepted' WHERE msg_id=?", (key,))
        q.db.execute("UPDATE tasks SET state='dispatched',host='local',thread_id=?,reply_state='steered' WHERE msg_id=?",
                     (thread_id,key))
        q.db.execute("UPDATE mention_turns SET turn_id=? WHERE msg_id=?", (turn_id,key))


def reconcile_steer(q, task, turn_id):
    owner = q.db.execute("SELECT thread_id FROM tasks JOIN mention_turns USING(msg_id) WHERE turn_id=? AND thread_id IS NOT NULL LIMIT 1",
                         (turn_id,)).fetchone()
    if not owner:
        return False
    key = task["msg_id"]
    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, f"qq:{q.account}/{q.group}/{key}"))
    with AppServer() as server:
        turns = read_thread(server, owner[0])["turns"]
    found = any(item.get("type")=="userMessage" and item.get("id")==expected
                for turn in turns if turn.get("id")==turn_id for item in turn["items"])
    if found:
        with q.transaction():
            q.db.execute("UPDATE group_chat SET delivery='accepted' WHERE msg_id=?", (key,))
            q.db.execute("UPDATE tasks SET state='dispatched',host='local',thread_id=?,reply_state='steered' WHERE msg_id=?",
                         (owner[0],key))
            q.db.execute("UPDATE mention_turns SET turn_id=? WHERE msg_id=?", (turn_id,key))
    return found


ACTIVITY = {"commandExecution":"运行本机命令", "fileChange":"处理文件修改", "webSearch":"检索资料",
            "mcpToolCall":"调用工具", "collabAgentToolCall":"协调子任务"}


def dispatch(server, q, key, cwd):
    task = stored(q, key)
    if task["state"] != "pending":
        return
    if task["action"] is None:
        task = plan(q, key, {})  # Direct callers handling a plain mention.
    instructions = role_prompt(q.route)
    options = {"cwd": str(cwd), "sandbox": "workspace-write", "approvalPolicy": "never",
               "developerInstructions": instructions}
    prompt = task["body"]
    if task["clarification_id"]:
        original = stored(q, task["clarification_id"])
        prompt += "\n\n控制者先前待确认的要求：\n" + original["body"]
    if task["action"] == "fork":
        src = stored(q, task["source_id"])
        reference = prior_material(server, q, task)
        # Keep quoted text at user priority, out of developerInstructions. One user
        # message preserves turn attribution and can be verified exactly on recovery.
        prompt += "\n\n参考资料（群任务 #" + str(src["seq"]) + " 的已发布终稿）：\n" + reference
    if task["action"] == "resume":
        root = stored(q, task["root_id"])
        thread_id = root["thread_id"]
        if not thread_id:
            raise ValueError("Original chat has no verified thread ID")
        thread = read_thread(server, thread_id)
        first = next((t for t in thread["turns"] if any(i["type"]=="userMessage" for i in t["items"])), None)
        if first is None or user_text(first) != (root["submitted"] or root["body"]):
            raise ValueError("Original QQ task does not match this thread")
        if any(t["status"] == "inProgress" for t in thread["turns"]):
            raise ThreadBusy()
        resumed = server.call("thread/resume", {"threadId": thread_id, **options})["thread"]
        if resumed["id"] != thread_id:
            raise ValueError("Resumed a different Codex thread")
    claim = q.claim(only_id=key, group_reply=True)
    if not claim:
        return
    if task["action"] != "resume":
        created = server.call("thread/start", {**options, "ephemeral": False})
        thread_id = created["thread"]["id"]
    q.created(key, host="local", thread_id=thread_id)
    # Commit the submitted text before the non-idempotent request. Never replay a
    # turn/start whose acknowledgement was lost.
    previous = thread["turns"][-1]["id"] if task["action"] == "resume" and thread["turns"] else ""
    q.db.execute("UPDATE mention_turns SET submitted=?,previous_turn=? WHERE msg_id=?", (prompt, previous, key))
    result = server.call("turn/start", {"threadId": thread_id,
        "input": [{"type": "text", "text": prompt, "text_elements": []}]})
    turn_id = result["turn"]["id"]
    q.db.execute("UPDATE mention_turns SET turn_id=? WHERE msg_id=?", (turn_id, key))
    if task["action"] != "resume":
        server.call("thread/name/set", {"threadId": thread_id, "name": claim[1]["title"]})
    def record_activity(event):
        params = event.get("params", {})
        label = ACTIVITY.get(params.get("item", {}).get("type"))
        if label and params.get("turnId") == turn_id:
            q.db.execute("UPDATE group_chat SET activity=? WHERE msg_id=?",
                         (label + ("已结束" if event["method"]=="item/completed" else "已开始"),key))
    server.activity = record_activity
    try:
        status = server.wait_turn(turn_id, lambda: steer_pending(server,q,task["root_id"],thread_id,turn_id))
    finally:
        server.activity = None
    if status != "completed":
        raise ValueError("QQ work turn ended: " + str(status))
    print(f"turn {status} msg={key} thread={thread_id} turn={turn_id}", flush=True)


def send_group(q, task, answer, ack=False):
    key = task["msg_id"]
    args = {"seq":str(task["seq"]), "id":key, "group":q.group, "owner":q.owner, "account":q.account,
            "text":answer[:4001]}
    if ack:
        args["kind"] = "ack"
    elif task["action"] in ("chat","clarify"):
        args["kind"] = "chat"
    receipt = bridge_call("reply_to_mention", args)
    prefix = "mention-ack-" if ack else "mention-reply-"
    if receipt.get("requestId") != prefix + key or receipt.get("groupCode") != q.group:
        raise ValueError("QQ reply receipt identity mismatch")
    return receipt


def publish(q, task, answer):
    key = task["msg_id"]
    receipt = send_group(q, task, answer)
    status = receipt.get("state")
    if status not in ("accepted", "confirmed", "observed_in_group", "unknown"):
        raise ValueError("Unexpected QQ reply receipt")
    with q.transaction():
        if task["action"] in ("clarify","chat"):
            q.db.execute("UPDATE tasks SET state=? WHERE msg_id=?",
                         ("clarified" if task["action"]=="clarify" else "answered", key))
        q.db.execute("UPDATE tasks SET reply_state=? WHERE msg_id=?", (status, key))
        q.db.execute("UPDATE mention_turns SET reply_id=?,reply_seq=?,published=? WHERE msg_id=?",
                     (receipt.get("messageId"), receipt.get("messageSeq"), receipt.get("publishedText"), key))
    print(f"QQ reply {status} source={task['seq']} message={receipt.get('messageId', '-')}", flush=True)
    if status == "unknown":
        raise ValueError("QQ delivery outcome unknown; retained native receipt for review")


def recover_turn(server, q, task):
    if not task["submitted"] or task["previous_turn"] is None:
        raise ValueError("Turn submission outcome requires manual review")
    turns = read_thread(server, task["thread_id"])["turns"]
    ids = [turn["id"] for turn in turns]
    previous = task["previous_turn"]
    if previous and previous not in ids:
        raise ValueError("Cannot locate pre-submission turn")
    after = turns[ids.index(previous)+1:] if previous else turns
    if len(after) != 1 or user_text(after[0]) != task["submitted"]:
        raise ValueError("Cannot uniquely identify submitted QQ turn; retained for review")
    turn_id = after[0]["id"]
    q.db.execute("UPDATE mention_turns SET turn_id=? WHERE msg_id=?", (turn_id, task["msg_id"]))
    return turn_id


def deliver(server, q, key):
    task = stored(q, key)
    if task["reply_state"] != "pending":
        return
    if task["action"] == "clarify":
        publish(q, task, ASK)
        return
    answer = task["final"]
    if answer is None:
        turn_id = task["turn_id"]
        if task["action"] and not turn_id:
            turn_id = recover_turn(server, q, task)
        answer = final_answer(server, task["thread_id"], task["submitted"] or task["body"], turn_id)
        with q.transaction():
            q.db.execute("UPDATE tasks SET state='dispatched' WHERE msg_id=?", (key,))
            q.db.execute("UPDATE mention_turns SET final=? WHERE msg_id=?", (answer, key))
        print(f"dispatched msg={key} thread={task['thread_id']}", flush=True)
    with q.transaction():
        waiting = q.db.execute("""SELECT 1 FROM group_chat c JOIN mention_turns m USING(msg_id)
            JOIN tasks t USING(msg_id) WHERE m.root_id=? AND t.seq>? AND t.state='pending'
            AND c.intent='resume' AND coalesce(c.delivery,'next') IN ('queued','next') LIMIT 1""",
                               (task["root_id"],task["seq"])).fetchone()
        if waiting:
            q.db.execute("UPDATE tasks SET reply_state='superseded' WHERE msg_id=?", (key,))
            return
    publish(q, task, answer)


@contextmanager
def verified_mention(marker):
    match = MARKER.fullmatch(marker.name)
    if not match:
        raise ValueError("Invalid wake file")
    seq, key = match.groups()
    page = history(int(seq) - 1, key)
    q = TriggerQueue(STATE / "tasks.sqlite3", page["group"], page["owner"], page["account"],
                     ROUTE, page["account"], int(page["top"]), allow_init=False)
    try:
        rows = [r for r in page["rows"] if r["msgSeq"] == seq and r["msgId"] == key]
        if len(rows) != 1:
            raise RuntimeError("Mention not yet confirmed in native group history")
        row = rows[0]
        if not row.get("mentionPrompt") or str(row["senderUin"]) != q.owner or int(seq) <= q.enabled_after:
            raise ValueError("Native history did not confirm a new controller mention")
        q.observe(row)
        entry = stored(q, key)
        if not entry or (entry["seq"], entry["body"]) != (int(seq), row["mentionPrompt"]):
            raise ValueError("Durable task differs from native mention")
        yield q, plan(q, key, row, conversational=True)
    finally:
        q.db.close()


def reception(marker):
    """Classify and answer on a dedicated lane even when all work slots are occupied."""
    with verified_mention(marker) as (q, task):
        key = task["msg_id"]
        existing = desk_row(q,key)
        if not existing and task["state"] != "pending":
            return True  # pre-upgrade task, preserve its original delivery contract
        prepare_chat(q, task, codex_cli())
        task = stored(q,key)
        intent, focus, text, ack, delivery, _ = desk_row(q,key)
        if intent not in WORK:
            if task["reply_state"] == "pending":
                publish(q,task,text)
            return False
        if intent == "resume" and delivery is None and not task["clarification_id"]:
            with q.transaction():
                active = q.db.execute("""SELECT t.msg_id FROM tasks t JOIN mention_turns m USING(msg_id)
                    WHERE m.root_id=? AND t.state='verifying' AND m.turn_id IS NOT NULL
                    ORDER BY t.seq DESC LIMIT 1""", (task["root_id"],)).fetchone()
                if active:
                    q.db.execute("UPDATE group_chat SET delivery='queued' WHERE msg_id=?", (key,))
        if not ack:
            receipt = send_group(q,task,text,ack=True)
            q.db.execute("UPDATE group_chat SET ack_state=? WHERE msg_id=?", (receipt["state"],key))
        # A second marker for an already completed turn does not acquire any work capacity.
        if task["state"] == "dispatched" and task["reply_state"] in ("accepted","observed_in_group","confirmed","steered","superseded"):
            return False
        # The active worker polls this input itself. The scheduler handles a missed turn on completion.
        return True


def handle(marker):
    with verified_mention(marker) as (q, task):
        key, reply = task["msg_id"], task["reply_state"]
        entry = desk_row(q,key)
        if entry and entry[4] in ("accepted","sending","uncertain"):
            if entry[4] != "accepted" and not reconcile_steer(q,task,entry[5]):
                raise ValueError("Steering delivery needs reconciliation; will not resubmit")
            return
        if reply == "unknown" or task["state"] in ("creating", "uncertain", "failed"):
            raise ValueError("Task or group reply requires manual review")
        if task["state"] in ("dispatched", "clarified") and reply != "pending":
            return
        if task["action"] == "clarify":
            q.db.execute("UPDATE tasks SET reply_state='pending' WHERE msg_id=? AND reply_state IS NULL", (key,))
            deliver(None, q, key)
            return
        if task["source_id"]:
            source = stored(q, task["source_id"])
            if (source["state"] in ("failed", "uncertain", "clarified") or source["reply_state"] == "unknown" or
                    (task["action"] == "fork" and source["reply_state"] in ("superseded","steered")) or
                    (source["reply_state"] == "pending" and (REVIEW / (str(source["seq"])+"_"+source["msg_id"])).is_file())):
                if task["state"] == "pending":
                    q.db.execute("UPDATE mention_turns SET action='clarify' WHERE msg_id=?", (key,))
                    q.db.execute("UPDATE tasks SET reply_state='pending' WHERE msg_id=?", (key,))
                    deliver(None, q, key)
                    return
            if source["state"] != "dispatched" or source["reply_state"] == "pending":
                raise ThreadBusy()
        cwd = Path.home() / "Codex/QQ任务"
        if ROUTE == "win":
            cwd = cwd / ROUTE / q.account / q.group
        elif ROUTE != "mac":
            cwd = cwd / ROUTE
        cwd = cwd / task["root_id"]
        cwd.mkdir(mode=0o700, parents=True, exist_ok=True)
        if task["final"] is not None:
            deliver(None, q, key)
            return
        with AppServer() as server:
            if task["state"] == "pending":
                dispatch(server, q, key, cwd)
            elif task["state"] == "verifying" and not task["action"]:
                verify(server, q, key, task["thread_id"])  # first-turn-only legacy record
            deliver(server, q, key)


def process(marker, receive_only=False):
    # Retry read-only operations and pending jobs. A creating job is never created again.
    for delay in (0, 2, 5, 15, 30, 60):
        time.sleep(delay)
        try:
            if receive_only:
                if reception(marker):
                    return "work"
            else:
                handle(marker)
            marker.unlink(missing_ok=True)
            return
        except ThreadBusy:
            time.sleep(0.5)
            return  # leave marker for a later pass without occupying a worker
        except (OSError, sqlite3.Error, ValueError, RuntimeError) as exc:
            print(f"mention {marker.name}: {exc}", file=sys.stderr, flush=True)
            if isinstance(exc, ValueError):
                break
    REVIEW.mkdir(mode=0o700, exist_ok=True)
    marker.replace(REVIEW / marker.name)
    match = MARKER.fullmatch(marker.name)
    if match and (STATE / "tasks.sqlite3").is_file():
        path = (STATE / "tasks.sqlite3").resolve().as_uri() + "?mode=rw"
        try:
            with closing(sqlite3.connect(path, uri=True)) as db, db:
                db.execute("""UPDATE tasks SET state='uncertain' WHERE msg_id=? AND origin='mention'
                           AND state IN ('creating','verifying','pending')""", (match[2],))
        except sqlite3.Error as error:
            print(f"mention {marker.name}: retained for review: {error}", file=sys.stderr, flush=True)



def main():
    os.umask(0o077)
    os.chdir(STATE)
    # One consumer owns the wake files. The OS releases this lock on process exit.
    with closing(sqlite3.connect(STATE / "mention-dispatch.sqlite", timeout=0)) as lock:
        lock.execute("BEGIN IMMEDIATE")
        watch_directory()


def schedule(active, work_pool, chat_pool, plans, notify=None):
    for marker in list(active):
        future, lane = active[marker]
        if future.done():
            del active[marker]
            if future.result() == "work":
                plans[marker] = "work"
    occupied = {lane for _,lane in active.values()}
    for marker in list(plans):
        if not marker.exists():
            del plans[marker]
    markers = sorted(WAKE.iterdir(), key=lambda p: int(p.name.split("_")[0]) if MARKER.fullmatch(p.name) else 0)
    for marker in markers:
        if marker in active:
            continue
        if marker not in plans:
            if "chat" in occupied:
                continue
            lane = "chat"
            future = chat_pool.submit(process, marker, True)
        else:
            if len(occupied - {"chat"}) >= 4:
                continue
            try:
                with verified_mention(marker) as (_, task):
                    lane = task["root_id"]
                    parent = task["source_id"]
            except (OSError, ValueError, RuntimeError, sqlite3.Error):
                lane, parent = marker.name, None
            if lane in occupied or (parent and any(p.name.endswith("_"+parent) for p in active)):
                continue
            future = work_pool.submit(process, marker)
        active[marker] = future, lane
        occupied.add(lane)
        if notify:
            future.add_done_callback(notify)


def watch_directory():
    # launchd starts us on a nonempty directory. kqueue catches additional work
    # immediately, including while an earlier chat is still working.
    if os.name == "nt" or "--watch" in sys.argv:
        # Windows group mode is supervised by the foreground dispatcher command.
        with ThreadPoolExecutor(max_workers=4) as pool, ThreadPoolExecutor(max_workers=1) as chat:
            active, plans = {}, {}
            while True:
                binding = os.environ.get("QQ_MENTION_BINDING")
                if binding:
                    cfg = json.loads(Path(binding).read_text(encoding="utf-8"))
                    if not cfg or hashlib.sha256(cfg["token"].encode()).hexdigest()[:24] != STATE.name:
                        return
                schedule(active, pool, chat, plans)
                time.sleep(0.25)
    directory = os.open(WAKE, os.O_RDONLY)
    active, plans = {}, {}
    reader, writer = socket.socketpair()
    try:
        with closing(select.kqueue()) as events, reader, writer, ThreadPoolExecutor(max_workers=4) as pool, ThreadPoolExecutor(max_workers=1) as chat:
            changes = [select.kevent(directory, filter=select.KQ_FILTER_VNODE,
                                     flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=select.KQ_NOTE_WRITE),
                       select.kevent(reader.fileno(), filter=select.KQ_FILTER_READ, flags=select.KQ_EV_ADD)]
            events.control(changes, 0, 0)
            while True:
                schedule(active, pool, chat, plans, lambda _: writer.send(b'x'))
                if not active:
                    return
                for event in events.control(None, 2):
                    if event.ident == reader.fileno():
                        reader.recv(4096)
    finally:
        os.close(directory)


if __name__ == "__main__":
    main()
