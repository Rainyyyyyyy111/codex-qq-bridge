#!/usr/bin/env python3
"""Probe the QQ build, then read the bound group through the running default worker."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def main():
    # Use an empty, temporary profile for the native probe. It exits before login.
    with tempfile.TemporaryDirectory() as state:
        out = subprocess.check_output(
            [str(ROOT / "run"), "probe"],
            cwd=ROOT,
            env=dict(os.environ, QQ_BRIDGE_STATE=state),
            text=True,
            timeout=30,
        )
        probe = json.loads(out.strip().splitlines()[-1])
        if not all(probe.get(k) for k in ("engine", "login", "session")):
            raise RuntimeError("Native probe did not create the required services")
        print("Native probe:", json.dumps(probe))

    with subprocess.Popen(
        [str(ROOT / "bridge"), "mcp"],
        cwd=ROOT,
        env=dict(os.environ, QQ_BRIDGE_CONNECT_ONLY="1"),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    ) as proc:

        def rpc(counter, method, params):
            proc.stdin.write(
                json.dumps({"jsonrpc": "2.0", "id": counter, "method": method, "params": params}) + "\n"
            )
            proc.stdin.flush()
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ)
                if not sel.select(60):
                    raise RuntimeError("Timed out waiting for the default MCP client")
            response = json.loads(proc.stdout.readline())
            if response.get("id") != counter or "result" not in response:
                raise RuntimeError("Unexpected MCP response")
            return response["result"]

        try:
            info = rpc(1, "initialize", {"protocolVersion": "2025-03-26"})["serverInfo"]
            print("MCP:", info["name"], info["version"])
            rpc(2, "tools/list", {})
            result = rpc(3, "tools/call", {"name": "read_latest", "arguments": {}})
            if result.get("isError"):
                raise RuntimeError(result["content"][0]["text"])
            msg = json.loads(result["content"][0]["text"])
            if (
                msg.get("group") != "Codex共享chat"
                or not msg.get("id")
                or not msg.get("seq")
                or msg.get("replyPolicy") != "none"
            ):
                raise RuntimeError("Bound group read failed validation")
            print("Bound group read passed. Message contents and identifiers omitted.")
        finally:
            proc.terminate()


if __name__ == "__main__":
    main()
