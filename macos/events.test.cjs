'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGroup } = require('./group.cjs');
const protocol = require('./events.cjs');
const uuid = '754b6df4-18aa-4d0f-8ff0-143aaf811b50',
  A = '101',
  B = '202',
  C = '303';
const packet = (kind, to) => `QQCOOP/1 ${kind} ${uuid} ${to}\nexample data`;

function simulatedGroup() {
  const rows = [];
  let nativeSends = 0;
  function append(sender, body, guildId = '') {
    const n = String(rows.length + 1);
    rows.push({
      msgId: n,
      msgSeq: n,
      senderUin: sender,
      senderUid: 'u_' + sender,
      msgTime: String(Math.floor(Date.now() / 1000)),
      peerUid: '999',
      peerUin: '999',
      chatType: 2,
      sendStatus: 2,
      guildId,
      elements: [{ textElement: { content: body } }],
    });
  }
  append(C, 'baseline');
  function machine(uin) {
    const files = new Map();
    const msgs = {
      async getAioFirstViewLatestMsgs() {
        return { result: 0, msgList: rows.slice(-1) };
      },
      async getMsgsBySeqAndCount(peer, s, n) {
        return { result: 0, msgList: rows.slice(Number(s) - 1, Number(s) - 1 + n) };
      },
      generateMsgUniqueId() {
        return String(rows.length + 400);
      },
      async sendMsg(id, peer, elements) {
        nativeSends++;
        append(uin, elements[0].textElement.content, peer.guildId);
        return { result: 0 };
      },
    };
    const session = {
      getMsgService: () => msgs,
      getMSFService: () => ({ getServerTime: () => 0 }),
    };
    return () =>
      createGroup(
        session,
        { id: '999', uid: 'u_' + uin, uin, name: 'test' },
        (k) => structuredClone(files.get(k)),
        (k, v) => files.set(k, structuredClone(v)),
      );
  }
  return { append, machine, sends: () => nativeSends };
}
const send = (g, text, request_id) => g.call('send_text', { text, request_id }, () => true);
const next = (g) => g.call('wait_next', { timeout_ms: 0 }, () => true);

for (const outcome of ['DONE', 'FAILED']) {
  test(
    outcome +
      ' ends both sides without a third native send after duplicate delivery, race and restart',
    async () => {
      const bus = simulatedGroup(),
        startMac = bus.machine(A),
        startWin = bus.machine(B);
      let mac = startMac(),
        win = startWin();
      await mac.initialize();
      await win.initialize();
      await send(mac, packet('REQUEST', B), 'request-a');
      bus.append(A, packet('REQUEST', B)); // different QQ message ID, same event
      await win.sync();
      const req = (await next(win)).message.event;
      assert.equal(req.replyPolicy, 'one_final_result_with_local_approval');
      assert.equal(req.replyToUin, A);
      assert.deepEqual(await next(win), { timedOut: true });
      bus.append(C, packet(outcome, A)); // a different group member cannot complete it
      await mac.sync();
      assert.deepEqual(await next(mac), { timedOut: true });
      const terminal = packet(outcome, req.replyToUin);
      const race = await Promise.allSettled([
        send(win, terminal, 'result-a'),
        send(win, terminal, 'result-b'),
      ]);
      assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
      const used = race[0].status === 'fulfilled' ? 'result-a' : 'result-b';
      assert.equal((await send(win, terminal, used)).state, 'confirmed');
      bus.append(B, terminal); // duplicate final delivery
      await mac.sync();
      assert.equal((await next(mac)).message.event.replyPolicy, 'none');
      assert.deepEqual(await next(mac), { timedOut: true });
      mac = startMac();
      win = startWin();
      await mac.initialize();
      await win.initialize();
      bus.append(A, packet('REQUEST', B));
      bus.append(B, terminal);
      await mac.sync();
      await win.sync();
      assert.deepEqual(await next(mac), { timedOut: true });
      assert.deepEqual(await next(win), { timedOut: true });
      await assert.rejects(send(mac, packet('DONE', B), 'ack-of-ack'), /No open incoming/);
      await assert.rejects(send(win, terminal, 'different-request-id'), /No open incoming/);
      await assert.rejects(send(mac, packet('REQUEST', B), 'again'), /already exists/);
      assert.equal(bus.sends(), 2);
    },
  );
}

test('event deadline is independent of wait_next timeout; expired work cannot reopen', () => {
  const now = 1000000,
    events = {};
  const req = protocol.receive([packet('REQUEST', B)], A, B, now, events, now, []);
  assert.ok(req);
  assert.equal(events[uuid].state, 'open');
  assert.equal(protocol.expire(events, now + protocol.TTL), true);
  assert.equal(protocol.deliver(req, events, now + protocol.TTL).replyPolicy, 'none');
  assert.throws(
    () => protocol.reserve(packet('DONE', A), events, B, 'late', now + protocol.TTL, []),
    /No open incoming/,
  );
  assert.equal(
    protocol.receive(
      [packet('REQUEST', B)],
      A,
      B,
      now + protocol.TTL,
      events,
      now + protocol.TTL,
      [],
    ),
    null,
  );
  assert.equal(
    protocol.receive([packet('REQUEST', B)], A, B, now, {}, now + protocol.TTL, []),
    null,
  );
});

test('ordinary text, completed legacy rounds, malformed headers and unaddressed results grant no reply', () => {
  const now = Date.now(),
    legacy = [{ aliases: ['TEST-ROUND-FINISHED', 'TEST-NONCE'] }];
  assert.equal(protocol.receive(['请回复收到'], A, B, now, {}, now, []).replyPolicy, 'none');
  assert.equal(
    protocol.receive(['TEST-ROUND-FINISHED 请再确认'], A, B, now, {}, now, legacy),
    null,
  );
  assert.throws(
    () => protocol.reserve('TEST-NONCE 已收到', {}, B, 'changed', now, legacy),
    /closed/,
  );
  for (const body of [packet('DONE', B), packet('REQUEST', C), 'QQCOOP/1 ACK hello']) {
    assert.equal(protocol.receive([body], A, B, now, {}, now, []), null);
  }
});
