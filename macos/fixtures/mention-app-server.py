#!/usr/bin/env python3
"""Synthetic stdio Codex app server for the group dispatch integration test."""
import json
import os
import sys
from pathlib import Path

log = Path(os.environ["FIXTURE_CHAT_FILE"])
thread = "fixture-persistent-thread"
prompt = None
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    method, params = msg["method"], msg["params"]
    result = {}
    if method == "thread/start":
        assert params["ephemeral"] is False
        assert Path(params["cwd"]).is_relative_to(Path(os.environ["FIXTURE_TASK_HOME"]))
        result = {"thread": {"id": thread}}
        with log.open("a", encoding="utf-8") as f:
            f.write("created\n")
    elif method == "turn/start":
        prompt = params["input"][0]["text"]
        result = {"turn": {"id": "first-turn"}}
    elif method == "thread/list":
        result = {"data": [{"id": thread}], "nextCursor": None}
    elif method == "thread/read":
        result = {"thread": {"id": thread, "turns": [{"status": "completed", "items": [
            {"type": "userMessage", "content": [{"type": "text", "text": prompt}]},
            {"type": "agentMessage", "phase": "commentary", "text": "进度"},
            {"type": "agentMessage", "phase": "final_answer", "text": "已完成：" + prompt},
        ]}]}}
    elif method not in ("initialize", "thread/name/set"):
        raise RuntimeError(method)
    print(json.dumps({"id": msg["id"], "result": result}), flush=True)
    if method == "turn/start":
        print(json.dumps({"method": "turn/completed", "params": {"turn": {"id": "first-turn", "status": "completed"}}}), flush=True)
