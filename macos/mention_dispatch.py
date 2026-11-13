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
from contextlib import closing, contextmanager

from mention_routing import ASK, plan, stored
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
    status = server.wait_turn(turn_id)
    if status != "completed":
        raise ValueError("QQ work turn ended: " + str(status))
    print(f"turn {status} msg={key} thread={thread_id} turn={turn_id}", flush=True)


def publish(q, task, answer):
    key = task["msg_id"]
    receipt = bridge_call("reply_to_mention", {
        "seq": str(task["seq"]), "id": key, "group": q.group, "owner": q.owner, "account": q.account,
        "text": answer[:4001],
    })
    if receipt.get("requestId") != "mention-reply-" + key or receipt.get("groupCode") != q.group:
        raise ValueError("QQ reply receipt identity mismatch")
    status = receipt.get("state")
    if status not in ("accepted", "confirmed", "observed_in_group", "unknown"):
        raise ValueError("Unexpected QQ reply receipt")
    with q.transaction():
        if task["action"] == "clarify":
            q.db.execute("UPDATE tasks SET state='clarified' WHERE msg_id=?", (key,))
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
        yield q, plan(q, key, row)
    finally:
        q.db.close()


def handle(marker):
    with verified_mention(marker) as (q, task):
        key, reply = task["msg_id"], task["reply_state"]
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


def process(marker):
    # Retry read-only operations and pending jobs. A creating job is never created again.
    for delay in (0, 2, 5, 15, 30, 60):
        time.sleep(delay)
        try:
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


def schedule(active, pool, plans, notify=None):
    # Freeze plans in native sequence order before submitting concurrent jobs.
    # Only one worker at a time owns a conversation, including during reply publication.
    for marker in list(active):
        if active[marker][0].done():
            active.pop(marker)[0].result()
    occupied = {root for _, root in active.values()}
    for marker in list(plans):
        if not marker.exists():
            del plans[marker]
    markers = sorted(WAKE.iterdir(), key=lambda p: int(p.name.split("_")[0]) if MARKER.fullmatch(p.name) else 0)
    for marker in markers:
        if marker in active or len(active) >= 4:
            continue
        try:
            if marker not in plans:
                with verified_mention(marker) as (_, task):
                    plans[marker] = (task["root_id"], task["source_id"])
            root, parent = plans[marker]
        except (OSError, sqlite3.Error, ValueError, RuntimeError):
            # process() performs the bounded retry and preserves a failed marker for review.
            root = marker.name
            # An unresolved earlier marker may address any conversation.
            if active:
                break
            future = pool.submit(process, marker)
            active[marker] = future, root
            if notify:
                future.add_done_callback(notify)
            break
        if root in occupied or (parent and any(p.name.endswith("_" + parent) for p in active)):
            continue
        future = pool.submit(process, marker)
        active[marker] = future, root
        occupied.add(root)
        if notify:
            future.add_done_callback(notify)


def watch_directory():
    # launchd starts us on a nonempty directory. kqueue catches additional work
    # immediately, including while an earlier chat is still working.
    if os.name == "nt" or "--watch" in sys.argv:
        # Windows group mode is supervised by the foreground dispatcher command.
        with ThreadPoolExecutor(max_workers=4) as pool:
            active, plans = {}, {}
            while True:
                binding = os.environ.get("QQ_MENTION_BINDING")
                if binding:
                    cfg = json.loads(Path(binding).read_text(encoding="utf-8"))
                    if not cfg or hashlib.sha256(cfg["token"].encode()).hexdigest()[:24] != STATE.name:
                        return
                schedule(active, pool, plans)
                time.sleep(0.25)
    directory = os.open(WAKE, os.O_RDONLY)
    active, plans = {}, {}
    reader, writer = socket.socketpair()
    try:
        with closing(select.kqueue()) as events, reader, writer, ThreadPoolExecutor(max_workers=4) as pool:
            changes = [select.kevent(directory, filter=select.KQ_FILTER_VNODE,
                                     flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=select.KQ_NOTE_WRITE),
                       select.kevent(reader.fileno(), filter=select.KQ_FILTER_READ, flags=select.KQ_EV_ADD)]
            events.control(changes, 0, 0)
            while True:
                schedule(active, pool, plans, lambda _: writer.send(b'x'))
                if not active:
                    return
                for event in events.control(None, 2):
                    if event.ident == reader.fileno():
                        reader.recv(4096)
    finally:
        os.close(directory)


if __name__ == "__main__":
    main()
