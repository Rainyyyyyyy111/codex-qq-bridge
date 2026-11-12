import json
import os
from pathlib import Path
import shutil
import selectors
import socket
import subprocess
import tempfile
import unittest

from test_trigger import msg
from trigger import TriggerQueue


ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(shutil.which("zsh") and shutil.which("node"), "requires zsh and Node")
class Profiles(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.env = dict(os.environ, HOME=tmp.name)
        self.home = Path(tmp.name)

    def bridge(self, *args, check=True):
        return subprocess.run(
            [str(ROOT / "bridge"), *args],
            env=self.env,
            cwd=ROOT,
            check=check,
            capture_output=True,
            text=True,
            timeout=8,
        )

    def paths(self, profile):
        return self.bridge("--profile", profile, "paths").stdout.splitlines()

    def test_pair_command_merges_contact_in_selected_profile(self):
        state = Path(self.paths("studio")[0])
        state.mkdir(parents=True)
        config = state / "settings.json"
        config.write_text(json.dumps({"accountUin":"101","contacts":{"known":"303","desk":"202"}}))
        result = self.bridge("--profile", "studio", "collab", "pair", "202")
        self.assertEqual(json.loads(result.stdout)["contact"], "desk")
        self.assertEqual(json.loads(config.read_text())["contacts"], {"known":"303","desk":"202"})
        self.assertFalse((Path(self.paths("default")[0]) / "settings.json").exists())

    def test_scopes_include_state_runtime_launchd_mcp_and_route(self):
        profiles = [self.paths(p) for p in ("default", "lab", "studio")]
        for dimension in zip(*profiles):
            self.assertEqual(len(set(dimension)), 3)
        self.assertEqual(profiles[0], self.bridge("paths").stdout.splitlines())
        self.assertEqual(profiles[0][0], str(self.home / "Library/Application Support/CodexQQBridge"))
        self.assertEqual(profiles[0][-1], "mac")
        self.assertEqual(profiles[1][-1], "acct-lab")
        for name in ("../lab", "Lab", "a/b", "", "a" * 25):
            self.assertNotEqual(self.bridge("--profile", name, "paths", check=False).returncode, 0)

    def test_unconfigured_named_profile_fails_before_startup(self):
        result = self.bridge("--profile", "lab", "mcp", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected accountUin", result.stderr)
        self.assertFalse(Path(self.paths("lab")[0]).exists())

    def test_mcp_registration_preserves_legacy_tools_and_limits_contact_choices(self):
        for profile in ("default", "lab"):
            state = Path(self.paths(profile)[0])
            state.mkdir(parents=True)
            if profile == "lab":
                (state / "settings.json").write_text('{"accountUin":"202","contacts":{"desk":"303"}}')
            reqs = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            ]
            out = subprocess.run(
                [str(ROOT / "bridge"), "--profile", profile, "mcp"],
                cwd=ROOT,
                env=self.env,
                text=True,
                capture_output=True,
                timeout=5,
                check=True,
                input="".join(json.dumps(r) + "\n" for r in reqs),
            )
            init, listing = [json.loads(line)["result"] for line in out.stdout.splitlines()]
            self.assertEqual(init["serverInfo"]["name"], self.paths(profile)[3])
            tools = listing["tools"]
            self.assertEqual([t["name"] for t in tools[:3]], ["read_latest", "wait_next", "send_text"])
            self.assertEqual(len(tools), 3 if profile == "default" else 5)
            for t in tools[3:]:
                self.assertEqual(t["inputSchema"]["properties"]["contact"]["enum"], ["desk"])

    def test_installed_named_runtime_cannot_fall_back_to_default(self):
        runtime = self.home / "runtime"
        shutil.copytree(ROOT, runtime)
        (runtime / "installed-profile").write_text("lab\n")

        def run(*args):
            return subprocess.run(
                args, cwd=runtime, env=self.env, capture_output=True, text=True, timeout=5
            )

        self.assertEqual(run("./bridge", "paths").stdout.splitlines(), self.paths("lab"))
        self.assertNotEqual(run("./bridge", "--profile", "default", "paths").returncode, 0)
        self.assertIn("correct profile", run("node", "mcp.cjs", "--status").stderr)
        self.assertIn("correct profile", run("/usr/bin/python3", "triggerctl.py", "status").stderr)

    def test_three_accounts_route_and_deduplicate_the_same_history_independently(self):
        inputs = [msg(11, "/task acct-lab first"), msg(12, "/task mac /task acct-lab second")]
        claims = {}
        for account, route in [("201", "mac"), ("202", "acct-lab"), ("203", "acct-studio")]:
            q = TriggerQueue(self.home / (route + ".db"), "900", "101", account, route, account, 10)
            try:
                q.page(10, inputs)
                for item in inputs:
                    q.observe(item)
                claims[route] = []
                while True:
                    claim = q.claim()
                    if not claim:
                        break
                    self.assertIn(route.upper(), claim[1]["title"])
                    claims[route].append(claim[1]["prompt"])
            finally:
                q.db.close()
        self.assertEqual(claims, {"mac": ["second"], "acct-lab": ["first", "second"], "acct-studio": []})

    def test_trigger_cli_uses_named_database_and_live_profile(self):
        state = Path(self.paths("lab")[0])
        state.mkdir(parents=True)
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        sock.settimeout(6)
        before = os.getcwd()
        try:
            os.chdir(state)
            sock.bind("bridge.sock")
        finally:
            os.chdir(before)
        sock.listen()

        def history():
            for top, rows in [(10, []), (11, []), (11, [msg(11, "/task acct-lab fixture")])]:
                with sock.accept()[0] as conn, conn.makefile("rb") as stream:
                    req = json.loads(stream.readline())
                    self.assertEqual(req["name"], "trigger_page")
                    self.assertEqual(req["args"], {"after": "10"} if rows else {})
                    value = {
                        "top": str(top),
                        "rows": rows,
                        "account": "202",
                        "owner": "101",
                        "group": "900",
                    }
                    conn.sendall(json.dumps({"value": value}).encode())

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor() as pool:
            server = pool.submit(history)
            self.bridge("--profile", "lab", "trigger", "arm")
            raw = self.bridge("--profile", "lab", "trigger", "claim").stdout
            self.assertEqual(json.loads(raw)[1]["prompt"], "fixture")
            self.assertIn("QQ-ACCT-LAB", json.loads(raw)[1]["title"])
            server.result(timeout=6)
        self.assertTrue((state / "tasks.sqlite3").exists())
        self.assertFalse((Path(self.paths("default")[0]) / "tasks.sqlite3").exists())

    def test_two_workers_login_and_send_only_to_their_own_configured_dm_alias(self):
        import time

        workers = []

        def request(proc, method, params):
            proc.stdin.write(json.dumps(dict(jsonrpc="2.0", id=1, method=method, params=params)) + "\n")
            proc.stdin.flush()
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ)
                self.assertTrue(sel.select(6), "MCP response timed out")
            return json.loads(proc.stdout.readline())["result"]

        try:
            for profile, account, peer in [("lab", "101", "201"), ("studio", "102", "202")]:
                state = Path(self.paths(profile)[0])
                state.mkdir(parents=True)
                (state / "settings.json").write_text(
                    json.dumps({"accountUin": account, "contacts": {"desk": peer}})
                )
                env = dict(self.env, QQ_BRIDGE_PROFILE=profile, QQ_STATE=str(state), FIXTURE_UIN=account)
                worker = subprocess.Popen(
                    [
                        "node",
                        "--require",
                        str(ROOT / "fixtures/qq-session.cjs"),
                        str(ROOT / "worker.cjs"),
                        "serve",
                    ],
                    cwd=state,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                workers.append(worker)
                deadline = time.monotonic() + 5
                while not (state / "binding.json").exists():
                    if worker.poll() is not None:
                        self.fail(worker.stderr.read())
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.02)
            for profile, account, peer in [("lab", "101", "201"), ("studio", "102", "202")]:
                state = Path(self.paths(profile)[0])
                proc = subprocess.Popen(
                    [str(ROOT / "bridge"), "--profile", profile, "mcp"],
                    env=dict(self.env, QQ_BRIDGE_CONNECT_ONLY="1"),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:

                    def call(name, args):
                        return request(proc, "tools/call", {"name": name, "arguments": args})

                    read = call("read_dm_latest", {"contact": "desk"})
                    self.assertEqual(
                        json.loads(read["content"][0]["text"])["message"]["elements"],
                        ["fixture " + account],
                    )
                    args = {"contact": "desk", "text": "fixture", "request_id": "same-id"}
                    for _ in range(2):
                        result = call("send_dm_text", args)
                        self.assertEqual(json.loads(result["content"][0]["text"])["state"], "accepted")
                    (state / "settings.json").write_text(json.dumps({"accountUin": account}))
                    self.assertTrue(call("send_dm_text", dict(args, request_id="revoked"))["isError"])
                    sent = (state / "test-sends.jsonl").read_text().splitlines()
                    self.assertEqual(
                        [json.loads(line) for line in sent],
                        [{"from": account, "to": "u_" + peer, "text": "fixture"}],
                    )
                    self.assertEqual(json.loads((state / "binding.json").read_text())["uin"], account)
                finally:
                    proc.kill()
                    proc.communicate(timeout=5)
        finally:
            for worker in workers:
                worker.kill()
                worker.communicate(timeout=5)

    def test_worker_rejects_unexpected_login_before_binding_or_opening_inbox(self):
        state = Path(self.paths("lab")[0])
        state.mkdir(parents=True)
        (state / "settings.json").write_text('{"accountUin":"101"}')
        env = dict(self.env, QQ_BRIDGE_PROFILE="lab", QQ_STATE=str(state), FIXTURE_UIN="999")
        proc = subprocess.run(
            [
                "node",
                "--require",
                str(ROOT / "fixtures/qq-session.cjs"),
                str(ROOT / "worker.cjs"),
                "serve",
            ],
            cwd=state,
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("differs from settings", proc.stderr)
        for name in ["account.json", "binding.json", "cursor-900.json", "dm-outbox"]:
            self.assertFalse((state / name).exists())
