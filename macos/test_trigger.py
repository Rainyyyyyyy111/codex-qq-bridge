import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from trigger import TriggerQueue


def msg(seq, body="/task mac 示例", **changes):
    return dict(
        {
            "chatType": 2,
            "peerUid": "900",
            "peerUin": "900",
            "senderUin": "101",
            "msgId": str(9007199254740993 + seq),
            "msgSeq": str(seq),
            "elements": [{"elementType": 1, "textElement": {"content": body, "atType": 0}}],
        },
        **changes
    )


class DesignTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "private.db"
        self.q = self.open()
        self.addCleanup(self.q.db.close)

    def open(self, **changes):
        return TriggerQueue(
            **dict(
                {
                    "path": self.path,
                    "group": "900",
                    "owner": "101",
                    "account": "202",
                    "route": "mac",
                    "live_account": "202",
                    "enabled_after": 10,
                },
                **changes
            )
        )

    def test_authenticated_route_and_exact_plain_text(self):
        text = "/task mac first line\n$(anything) remains plain text"
        self.q.observe(msg(11, text))
        self.assertEqual(
            self.q.claim()[1],
            {
                "target": {"type": "projectless"},
                "title": "QQ-MAC-" + msg(11)["msgId"],
                "prompt": text[len("/task mac ") :],
            },
        )
        win = self.open(
            path=self.path.with_name("win.db"), route="win", account="303", live_account="303"
        )
        try:
            win.observe(msg(11, text))
            self.assertIsNone(win.claim())
            win.observe(msg(12, "/task win 测试"))
            self.assertEqual(win.claim()[1]["prompt"], "测试")
        finally:
            win.db.close()

    def test_compound_routes_and_explicit_one_message_replay(self):
        text = "/task win  /task mac   示例"
        self.q.observe(msg(9, text))
        self.assertIsNone(self.q.claim())
        self.q.observe(msg(9, text), replay=True)
        self.assertEqual(self.q.claim()[1]["prompt"], "示例")
        self.q.observe(msg(9, text), replay=True)
        self.q.observe(msg(11, "/task win 请解释 /task mac 命令"))
        self.q.observe(msg(12, "/task mac /task other 示例"))
        self.q.observe(msg(8, text, senderUin="999"), replay=True)
        self.assertIsNone(self.q.claim())
        win = self.open(path=self.path.with_name("win.db"), account="303", live_account="303", route="win")
        try:
            win.observe(msg(11, text))
            self.assertEqual(win.claim()[1]["prompt"], "示例")
        finally:
            win.db.close()

    def test_reject_spoof_history_receipt_quote_forward_mention(self):
        tests = [
            msg(10),
            msg(11, senderUin="202"),
            msg(12, senderUin="999", sendNickName="人类控制者"),
            msg(13, "说明：/task mac 示例"),
            msg(14, " /task mac 示例"),
            msg(15, "/task mac  "),
            msg(16, "QQCOOP/1 DONE ...\n/task mac 示例"),
            msg(17, "/task Mac 示例"),
            msg(18, elements=[{"elementType": 7}, *msg(18)["elements"]]),
            msg(19, elements=[{"elementType": 16}]),
            msg(20, senderUin=None),
            msg(
                21,
                elements=[
                    {"elementType": 1, "textElement": {"content": "/task mac hi", "atType": 2}}
                ],
            ),
        ]
        for m in tests:
            self.q.observe(m)
        self.assertIsNone(self.q.claim())
        with self.assertRaises(ValueError):
            self.q.observe(msg(22, peerUid="901"))
        with self.assertRaises(ValueError):
            self.open(live_account="101")

    def test_page_cursor_and_task_commit_together(self):
        with self.assertRaises(ValueError):
            self.q.page(10, [msg(11), msg(12, peerUin="901")])
        self.assertIsNone(self.q.claim())
        self.q.observe(msg(12))
        self.q.page(10, [msg(11), msg(12)])
        self.assertEqual(self.q.db.execute("SELECT cursor FROM scope").fetchone(), (12,))
        self.assertEqual(self.q.db.execute("SELECT count(*) FROM tasks").fetchone(), (2,))

    def test_concurrent_duplicate_and_restart_during_creation(self):
        gate = threading.Barrier(2)

        def worker(_):
            q = self.open()
            try:
                q.observe(msg(11))
                gate.wait(timeout=5)
                return q.claim()
            finally:
                q.db.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(worker, range(2)))
        self.assertEqual(sum(c is not None for c in claims), 1)
        # Simulate process loss between accepting create_thread and receiving its return.
        other = self.open(enabled_after=100)
        try:
            other.observe(msg(11))
            self.assertIsNone(other.claim())
            self.assertEqual(other.db.execute("SELECT state FROM tasks").fetchone(), ("creating",))
        finally:
            other.db.close()

    def test_queued_id_and_desktop_evidence(self):
        m = msg(11)
        self.q.observe(m)
        key, _ = self.q.claim()
        self.assertIsNone(self.q.recovery())
        self.q.db.execute("UPDATE tasks SET updated=0")
        self.assertEqual(self.q.recovery()["reconcile"]["expectedPrompt"], "示例")
        self.q.created(key, client_id="pending-1")
        self.assertIsNone(self.q.claim())
        with self.assertRaises(ValueError):
            self.q.verified(key, "host", "pending-1", "示例")
        with self.assertRaises(ValueError):
            self.q.created(key, host="host", thread_id="thread-1", resolves="unrelated")
        self.q.created(key, host="host", thread_id="thread-1", resolves="pending-1")
        with self.assertRaises(ValueError):
            self.q.verified(key, "other-host", "thread-1", "示例")
        with self.assertRaises(ValueError):
            self.q.verified(key, "host", "thread-1", "wrong task")
        self.q.verified(key, "host", "thread-1", "示例")
        self.q.observe(m)
        self.assertIsNone(self.q.claim())
        self.assertEqual(self.q.db.execute("SELECT state FROM tasks").fetchone(), ("dispatched",))


if __name__ == "__main__":
    unittest.main()
