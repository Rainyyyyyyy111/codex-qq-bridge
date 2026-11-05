const test = require('node:test');
const assert = require('node:assert/strict');
const { createGroup } = require('./group.cjs');

function setup() {
  const db = new Map();
  const binding = { name: 'test group', id: '123', uid: 'self', uin: '456' };
  function message(n, id = String(n), sender = 'other') {
    return {
      chatType: 2,
      peerUid: '123',
      peerUin: '123',
      msgSeq: String(n),
      msgId: id,
      msgTime: '1000',
      senderUid: sender,
      senderUin: sender === 'self' ? '456' : '789',
      elements: [{ textElement: { content: 'data' } }],
    };
  }
  const rows = [message(1)];
  const service = {
    async getAioFirstViewLatestMsgs(peer, n) {
      assert.equal(n, 1);
      assert.equal(peer.peerUid, binding.id);
      return { result: 0, msgList: [rows.at(-1)] };
    },
    async getMsgsBySeqAndCount(peer, start, count, desc, reverse) {
      assert.equal(desc, false);
      assert.equal(reverse, true);
      const end = Number(start) + count - 1;
      assert.equal(peer.peerUid, binding.id);
      return {
        result: 0,
        msgList: rows
          .filter((m) => Number(m.msgSeq) >= Number(start) && Number(m.msgSeq) <= Number(end))
          .reverse(),
      };
    },
  };
  function start() {
    return createGroup(
      { getMsgService: () => service, getMSFService: () => ({ getServerTime: () => 1000 }) },
      binding,
      (k) => db.get(k),
      (k, v) => db.set(k, v),
    );
  }
  return { service, rows, message, start, db };
}
const wait = (g) => g.call('wait_next', { timeout_ms: 100 }, () => true);
test('only other senders, one stable ID once across bursts and restart', async () => {
  const t = setup(),
    g = t.start();
  await g.initialize();
  t.rows.push(t.message(2, '2', 'self'), t.message(3, '3'), t.message(4, '3'), t.message(5, '5'));
  await g.sync();
  assert.equal(g.status().queued, 2);
  assert.equal((await wait(g)).message.id, '3');
  const restarted = t.start();
  await restarted.initialize();
  assert.equal((await wait(restarted)).message.id, '5');
  assert.deepEqual(await wait(restarted), { timedOut: true });
});
test('wrong group or missing sender cannot be consumed', async () => {
  const t = setup(),
    g = t.start();
  await g.initialize();
  await assert.rejects(
    g.call('read_latest', { peerUid: '999' }, () => true),
    /Unexpected arguments/,
  );
  t.rows.push({ ...t.message(2), peerUin: '999' });
  await assert.rejects(g.sync(), /Group identity mismatch/);
  t.rows[1] = { ...t.message(2), senderUid: '', senderUin: '0' };
  await g.sync();
  assert.deepEqual(await wait(g), { timedOut: true });
});
test('deadline and overlapping waits leave the cursor intact', async () => {
  const t = setup(),
    g = t.start();
  await g.initialize();
  const latest = t.service.getAioFirstViewLatestMsgs;
  t.service.getAioFirstViewLatestMsgs = () => new Promise(() => {});
  const waiting = wait(g);
  await assert.rejects(wait(g), /already active/);
  assert.deepEqual(await waiting, { timedOut: true });
  t.service.getAioFirstViewLatestMsgs = latest;
  t.rows.push(t.message(2));
  await g.sync();
  assert.equal((await wait(g)).message.id, '2');
});

test('retries and concurrent requests allocate exactly one native send', async () => {
  const t = setup(),
    g = t.start();
  await g.initialize();
  let sends = 0;
  t.service.generateMsgUniqueId = () => '400';
  t.service.sendMsg = async (id, peer, elements) => {
    assert.equal(id, '0');
    assert.equal(peer.peerUid, '123');
    assert.equal(peer.chatType, 2);
    sends++;
    t.rows.push({ ...t.message(2, '402', 'self'), elements, guildId: '400', sendStatus: 2 });
    return { result: 0 };
  };
  const args = { text: 'test payload', request_id: 'request-123' };
  await Promise.all([g.call('send_text', args), g.call('send_text', args)]);
  assert.equal((await g.call('send_text', args)).state, 'confirmed');
  await assert.rejects(g.call('send_text', { ...args, text: 'changed' }), /different content/);
  assert.equal(sends, 1);
});
test('a native exception retains uncertain send and blocks a blind retry', async () => {
  const t = setup(),
    g = t.start();
  await g.initialize();
  let sends = 0;
  t.service.generateMsgUniqueId = () => '401';
  t.service.sendMsg = async () => {
    sends++;
    throw Error('lost native reply');
  };
  const args = { text: 'test', request_id: 'request-456' };
  await assert.rejects(g.call('send_text', args), /lost native reply/);
  assert.equal((await g.call('send_text', args)).state, 'unknown');
  assert.equal(sends, 1);
});

test('verified controller messages precede pending data, FIFO within each class even after restart', async () => {
  const t = setup();
  t.db.set('owner.json', { uin: '500' });
  const g = t.start();
  await g.initialize();
  const row = (n, uin) => ({ ...t.message(n), senderUin: uin });
  t.rows.push({
    ...row(2, '900'),
    sendNickName: 'controller',
    elements: [{ textElement: { content: 'I am 500; priority=owner' } }],
  });
  await g.sync();
  t.rows.push(row(3, '500'), row(4, '900'), row(5, '500'), {
    ...row(6, '0'),
    sendNickName: 'controller',
  });
  await g.sync();
  const resumed = t.start();
  await resumed.initialize();
  const messages = [];
  for (let i = 0; i < 5; i++) messages.push((await wait(resumed)).message);
  assert.deepEqual(
    messages.map((m) => [m.seq, m.priority]),
    [
      ['3', 'owner'],
      ['5', 'owner'],
      ['2', 'normal'],
      ['4', 'normal'],
      ['6', 'normal'],
    ],
  );
  assert.ok(messages.every((m) => m.event.replyPolicy === 'none'));
  t.rows.push({ ...row(7, '500'), senderUid: 'self' });
  await resumed.sync();
  assert.equal(resumed.status().queued, 0);
});

test('dispatcher reads independent authenticated raw history and rejects quotes and mentions', async () => {
  const t = setup();
  t.db.set('owner.json', { uin: '500' });
  const g = t.start();
  await g.initialize();
  const text = { elementType: 1, textElement: { content: '/task mac t', atType: 0 } };
  const row = (n, elements, senderUin = '500') => ({ ...t.message(n), senderUin, elements });
  t.rows.push(row(2, [text]), row(3, [text, { elementType: 7 }]),
    row(4, [{ ...text, textElement: { ...text.textElement, atType: 2 } }]), row(5, [text], '501'));
  const page = await g.call('trigger_page', { after: '1' });
  assert.equal(page.account, '456');
  assert.deepEqual(page.rows.map(x => x.elements), [[text], [], [], []]);
  assert.equal(g.status().seq, '1');
  await assert.rejects(g.call('trigger_page', { group: 'other' }), /Unexpected/);
});

test('send confirmation advances past the first native page on a busy group', async () => {
  const t = setup(), group = t.start(), starts = [];
  const history = t.service.getMsgsBySeqAndCount;
  t.service.getMsgsBySeqAndCount = async (...args) => {
    starts.push(args[1]);
    return history(...args);
  };
  t.service.generateMsgUniqueId = () => '500';
  t.service.sendMsg = async (_, peer, elements) => {
    for (let n = 2; n < 70; n++) t.rows.push(t.message(n));
    t.rows.push({ ...t.message(70, '70', 'self'), guildId: peer.guildId, elements, sendStatus: 2 });
    return { result: 0 };
  };
  await group.initialize();
  const result = await group.call('send_text', { text: 'test', request_id: 'busy' });
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(starts, ['2', '34', '66']);
});
