import os
import select
import threading
from contextlib import nullcontext
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mention_dispatch import AppServer, deliver, dispatch, final_answer, handle, main
from trigger import TriggerQueue


class Server:
    def __init__(self):
        self.calls = []
        self.prompt = None
        self.visible = False

    def call(self, method, params):
        self.calls.append(method)
        if method == 'thread/start':
            self.instructions = params['developerInstructions']
            return {'thread': {'id': 'real-id'}}
        if method == 'turn/start':
            self.prompt = params['input'][0]['text']
            return {'turn': {'id': 'turn1'}}
        if method == 'thread/name/set':
            return {}
        if method == 'thread/list':
            self.visible = True
            return {'data': [{'id': 'real-id'}], 'nextCursor': None}
        if method == 'thread/read':
            item = {'type': 'userMessage', 'content': [{'type': 'text', 'text': self.prompt}]}
            return {'thread': {'id': 'real-id', 'turns': [{'items': [item]}]}}
        raise AssertionError(method)

    def wait_turn(self, turn_id):
        assert turn_id == 'turn1'
        return 'completed'


class MentionDispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        self.path = self.cwd / 'tasks.sqlite3'
        self.q = TriggerQueue(self.path, '123', '789', '456', 'mac', '456', 10, allow_init=True)
        self.addCleanup(self.q.db.close)
        self.row = {'chatType': 2, 'peerUid': '123', 'peerUin': '123', 'msgId': '19', 'msgSeq': '15',
                    'senderUin': '789', 'mentionPrompt': ' 多行\n$(不要执行)  '}
        self.server = Server()

    @unittest.skipUnless(os.environ.get("QQ_TEST_CODEX_APP_SERVER"), "explicit local Codex executable")
    def test_real_app_server_starts_without_any_registered_qq_mcp(self):
        state = self.cwd / "isolated-codex"
        state.mkdir()
        env = {"CODEX_HOME": str(state), "HOME": str(self.cwd), "USERPROFILE": str(self.cwd),
               "QQ_MENTION_CODEX": os.environ["QQ_TEST_CODEX_APP_SERVER"]}
        with patch.dict(os.environ, env), AppServer() as server:
            thread = server.call("thread/start", {"cwd": str(self.cwd), "sandbox": "workspace-write",
                                                   "approvalPolicy": "never", "ephemeral": False})["thread"]
            observed = server.call("thread/read", {"threadId": thread["id"], "includeTurns": False})
            self.assertEqual(observed["thread"]["id"], thread["id"])

    def test_one_durable_chat_exact_first_input(self):
        for _ in range(2):
            self.q.observe(self.row)
            dispatch(self.server, self.q, '19', self.cwd)
        self.assertEqual(self.server.calls,
                         ['thread/start', 'turn/start', 'thread/name/set'])
        self.assertEqual(self.server.prompt, self.row['mentionPrompt'])
        self.assertIn('Mac 端', self.server.instructions)
        self.assertNotIn(self.server.prompt, self.server.instructions)
        self.assertEqual(self.q.db.execute('SELECT state FROM tasks').fetchone(), ('verifying',))  # deliver verifies the exact turn before publishing it.

    def test_plain_text_and_legacy_pending_never_dispatched(self):
        self.q.observe(dict(self.row, mentionPrompt=None, elements=[
            {'elementType': 1, 'textElement': {'atType': 0, 'content': '/task mac hi'}}]))
        self.assertIsNotNone(self.q.claim())  # The ordinary route dispatcher owns this row.
        dispatch(self.server, self.q, '19', self.cwd)
        self.assertEqual(self.server.calls, [])

    def test_unknown_creation_never_reissued(self):
        self.q.observe(self.row)
        with patch.object(self.server, 'call', side_effect=ConnectionError()):
            with self.assertRaises(ConnectionError):
                dispatch(self.server, self.q, '19', self.cwd)
        dispatch(self.server, self.q, '19', self.cwd)
        self.assertEqual(self.server.calls, [])
        self.assertEqual(self.q.db.execute('SELECT state FROM tasks').fetchone(), ('creating',))

    def test_forged_marker_without_native_mention_cannot_wake_codex(self):
        page = {'group':'123', 'account':'456', 'owner':'789', 'top':'15',
                'rows':[dict(self.row, mentionPrompt=None)]}
        with patch('mention_dispatch.STATE', self.cwd), patch('mention_dispatch.history', return_value=page), \
                patch('mention_dispatch.AppServer') as app:
            with self.assertRaisesRegex(ValueError, 'did not confirm'):
                handle(self.cwd/'15_19')
            app.assert_not_called()

    def test_missing_local_authorization_is_never_created(self):
        import sqlite3
        with self.assertRaises(sqlite3.OperationalError):
            TriggerQueue(self.cwd/'absent', '123', '789', '456', 'mac', '456', 10, allow_init=False)
        self.assertFalse((self.cwd/'absent').exists())

    @unittest.skipUnless(hasattr(select, "kqueue"), "macOS directory events")
    def test_directory_wakes_second_job_while_first_is_active(self):
        wake = self.cwd / 'mention-wake'
        wake.mkdir()
        first, second = threading.Event(), threading.Event()
        seen = []
        def consume(marker):
            if marker.name == '1_11':
                first.set()
                self.assertTrue(second.wait(5))
            else:
                second.set()
            marker.unlink()
            seen.append(marker.name)
        def notify():
            if first.wait(5):
                (wake/'2_22').touch()
        (wake/'1_11').touch()
        feeder = threading.Thread(target=notify)
        feeder.start()
        old_cwd = Path.cwd()
        old_umask = os.umask(0o077)
        try:
            with patch('mention_dispatch.STATE', self.cwd), patch('mention_dispatch.WAKE', wake), \
                    patch('mention_dispatch.process', consume), \
                    patch('mention_dispatch.verified_mention', side_effect=lambda p: nullcontext(
                        (None, {'root_id': p.name, 'source_id': None}))):
                main()
        finally:
            os.chdir(old_cwd)
            os.umask(old_umask)
            feeder.join()
        self.assertEqual(sorted(seen), ['1_11', '2_22'])

    def test_final_reply_is_idempotent_and_only_uses_the_original_turn(self):
        self.q.observe(self.row)
        dispatch(self.server, self.q, '19', self.cwd)
        user = {'type':'userMessage', 'content':[{'type':'text', 'text':self.row['mentionPrompt']}]}
        first = {'id':'turn1','status':'completed', 'items':[user, {'type':'agentMessage','phase':'commentary','text':'进度'},
                                               {'type':'agentMessage','phase':'final_answer','text':'完成了'}]}
        later = {'id':'turn2','status':'completed', 'items':[user, {'type':'agentMessage','phase':'final_answer','text':'别的答案'}]}
        result = {'thread':{'id':'real-id', 'turns':[first,later]}}
        receipt = {'state':'observed_in_group','requestId':'mention-reply-19','groupCode':'123'}
        with patch.object(self.server,'call',return_value=result), patch('mention_dispatch.bridge_call',return_value=receipt) as post:
            deliver(self.server,self.q,'19')
            deliver(self.server,self.q,'19')
            post.assert_called_once_with('reply_to_mention', {
                'seq':'15','id':'19','group':'123','owner':'789','account':'456','text':'完成了'})
            first['items'].pop()
            with self.assertRaisesRegex(RuntimeError, 'final answer'):
                final_answer(self.server,'real-id',self.row['mentionPrompt'])
            first['status']='failed'
            with self.assertRaisesRegex(ValueError, 'ended'):
                final_answer(self.server,'real-id',self.row['mentionPrompt'])

    def test_preexisting_and_uncertain_deliveries_do_not_send_again(self):
        self.q.observe(self.row)
        self.q.claim('19', group_reply=True)
        self.q.db.execute("UPDATE tasks SET reply_state=NULL")  # migrated chat without a send intent
        self.q.created('19',host='local',thread_id='real-id')
        self.q.verified('19','local','real-id',self.row['mentionPrompt'])
        with patch('mention_dispatch.bridge_call') as post:
            deliver(self.server,self.q,'19')
            self.q.db.execute("UPDATE tasks SET reply_state='unknown'")
            deliver(self.server,self.q,'19')
            post.assert_not_called()
