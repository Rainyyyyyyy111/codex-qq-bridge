"""Run an authenticated QQ mention locally and return its final answer to the bound group."""
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
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from trigger import TriggerQueue
from triggerctl import ROUTE, STATE, bridge_call, history

CODEX = Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")
WAKE = STATE / "mention-wake"
REVIEW = STATE / "mention-review"
MARKER = re.compile(r"([1-9][0-9]*)_(-?[1-9][0-9]*)")


class AppServer:
    def __enter__(self):
        cli = os.environ.get("QQ_MENTION_CODEX") or (CODEX if CODEX.is_file() else shutil.which("codex"))
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
                if "id" in msg or msg.get("method") == "turn/completed":
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
                    raise RuntimeError(f"{method}: {msg['error'].get('message', 'RPC failed')}")
                return msg["result"]

    def wait_turn(self, turn_id):
        while turn_id not in self.completed:
            # Quiet long-running jobs are allowed to finish.
            try:
                self.next(time.monotonic() + 600)
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


def dispatch(server, q, key, cwd):
    claim = q.claim(only_id=key, group_reply=True)
    if not claim:
        return
    _, task = claim
    created = server.call("thread/start", {
        "cwd": str(cwd), "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": False,
        "developerInstructions": "这是绑定的人类控制账号在 QQ 群里 @ 你发起的任务。在本地完成工作；桥接会把你的最终答复作为一条纯文本发回原群。用适合群里阅读的简洁文字，仅写可以在群里公开的内容。不要自行发信、呼叫其他账号或操作桥接队列、arm、replay。",
    })
    thread_id = created["thread"]["id"]
    q.created(key, host="local", thread_id=thread_id)
    result = server.call("turn/start", {"threadId": thread_id,
        "input": [{"type": "text", "text": task["prompt"], "text_elements": []}]})
    turn_id = result["turn"]["id"]
    try:
        server.call("thread/name/set", {"threadId": thread_id, "name": task["title"]})
        verify(server, q, key, thread_id)
        print(f"dispatched msg={key} thread={thread_id}", flush=True)
    finally:
        status = server.wait_turn(turn_id)
        print(f"turn {status} msg={key} thread={thread_id}", flush=True)


def final_answer(server, thread_id, expected_prompt):
    thread = server.call("thread/read", {"threadId": thread_id, "includeTurns": True})["thread"]
    if thread["id"] != thread_id:
        raise ValueError("Codex thread identity mismatch")
    for turn in thread["turns"]:
        items = turn["items"]
        user = next((item for item in items if item["type"] == "userMessage"), None)
        if user is None:
            continue
        content = user["content"]
        if len(content) != 1 or content[0].get("type") != "text" or content[0].get("text") != expected_prompt:
            raise ValueError("Initial task does not match the controller mention")
        if turn["status"] in ("failed", "interrupted"):
            raise ValueError("Initial turn ended without a deliverable final answer")
        if turn["status"] != "completed":
            break
        for item in reversed(items):
            if item["type"] == "agentMessage" and item.get("phase") == "final_answer" and item["text"].strip():
                return item["text"]
        # Older providers omit phase. Only a terminal assistant message qualifies.
        last = items[-1]
        if last["type"] == "agentMessage" and last.get("phase") is None and last["text"].strip():
            return last["text"]
        break
    raise RuntimeError("Initial turn has no completed final answer yet")


def deliver(server, q, key):
    entry = q.db.execute(
        "SELECT seq,body,thread_id FROM tasks WHERE grp=? AND msg_id=? AND origin='mention' "
        "AND state='dispatched' AND reply_state='pending'", (q.group, key),
    ).fetchone()
    if not entry:
        return
    seq, prompt, thread_id = entry
    answer = final_answer(server, thread_id, prompt)
    receipt = bridge_call("reply_to_mention", {
        "seq": str(seq), "id": key, "group": q.group, "owner": q.owner, "account": q.account,
        "text": answer[:4001],
    })
    if receipt.get("requestId") != "mention-reply-" + key or receipt.get("groupCode") != q.group:
        raise ValueError("QQ reply receipt identity mismatch")
    status = receipt.get("state")
    if status not in ("accepted", "confirmed", "observed_in_group", "unknown"):
        raise ValueError("Unexpected QQ reply receipt")
    q.db.execute("UPDATE tasks SET reply_state=? WHERE grp=? AND msg_id=? AND reply_state='pending'",
                 (status, q.group, key))
    if status == "unknown":
        raise ValueError("QQ delivery outcome unknown; retained native receipt for review")
    print(f"QQ reply {status} source={seq} message={receipt.get('messageId', '-')}", flush=True)


def handle(marker):
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
        entry = q.db.execute("SELECT seq,body,origin,state,thread_id,reply_state FROM tasks WHERE grp=? AND msg_id=?",
                             (q.group, key)).fetchone()
        if not entry or entry[:3] != (int(seq), row["mentionPrompt"], "mention"):
            raise ValueError("Durable task differs from native mention")
        state, thread_id, reply_state = entry[3:]
        if reply_state == "unknown":
            raise ValueError("QQ reply outcome requires manual review")
        if state == "dispatched" and reply_state != "pending":
            return
        if state not in ("pending", "verifying", "dispatched"):
            raise ValueError("Creation outcome requires manual review: " + state)
        cwd = Path.home() / "Codex/QQ任务"
        if ROUTE == "win":
            cwd = cwd / ROUTE / q.account / q.group
        elif ROUTE != "mac":
            cwd = cwd / ROUTE
        cwd = cwd / key
        cwd.mkdir(mode=0o700, parents=True, exist_ok=True)
        with AppServer() as server:
            if state == "verifying":
                verify(server, q, key, thread_id)
            elif state == "pending":
                dispatch(server, q, key, cwd)
            deliver(server, q, key)
    finally:
        q.db.close()


def process(marker):
    # Retry read-only operations and pending jobs. A creating job is never created again.
    for delay in (0, 2, 5, 15, 30, 60):
        time.sleep(delay)
        try:
            handle(marker)
            marker.unlink(missing_ok=True)
            return
        except (OSError, sqlite3.Error, ValueError, RuntimeError) as exc:
            print(f"mention {marker.name}: {exc}", file=sys.stderr, flush=True)
            if isinstance(exc, ValueError):
                break
    REVIEW.mkdir(mode=0o700, exist_ok=True)
    marker.replace(REVIEW / marker.name)


def main():
    os.umask(0o077)
    os.chdir(STATE)
    # One consumer owns the wake files. The OS releases this lock on process exit.
    with closing(sqlite3.connect(STATE / "mention-dispatch.sqlite", timeout=0)) as lock:
        lock.execute("BEGIN IMMEDIATE")
        watch_directory()


def watch_directory():
    # launchd starts us on a nonempty directory. kqueue catches additional work
    # immediately, including while an earlier chat is still working.
    if os.name == "nt" or "--watch" in sys.argv:
        # Windows group mode is supervised by the foreground dispatcher command.
        with ThreadPoolExecutor(max_workers=4) as pool:
            active = {}
            while True:
                binding = os.environ.get("QQ_MENTION_BINDING")
                if binding:
                    cfg = json.loads(Path(binding).read_text(encoding="utf-8"))
                    if not cfg or hashlib.sha256(cfg["token"].encode()).hexdigest()[:24] != STATE.name:
                        return
                for marker in list(active):
                    if active[marker].done():
                        active.pop(marker).result()
                for marker in WAKE.iterdir():
                    if marker not in active and len(active) < 4:
                        active[marker] = pool.submit(process, marker)
                time.sleep(0.25)
    directory = os.open(WAKE, os.O_RDONLY)
    active = {}
    reader, writer = socket.socketpair()
    try:
        with closing(select.kqueue()) as events, reader, writer, ThreadPoolExecutor(max_workers=4) as pool:
            changes = [select.kevent(directory, filter=select.KQ_FILTER_VNODE,
                                     flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=select.KQ_NOTE_WRITE),
                       select.kevent(reader.fileno(), filter=select.KQ_FILTER_READ, flags=select.KQ_EV_ADD)]
            events.control(changes, 0, 0)
            while True:
                for marker in list(active):
                    if active[marker].done():
                        active.pop(marker).result()
                for marker in WAKE.iterdir():
                    if marker not in active and len(active) < 4:
                        future = pool.submit(process, marker)
                        active[marker] = future
                        future.add_done_callback(lambda _: writer.send(b'x'))
                if not active:
                    return
                for event in events.control(None, 2):
                    if event.ident == reader.fileno():
                        reader.recv(4096)
    finally:
        os.close(directory)


if __name__ == "__main__":
    main()
