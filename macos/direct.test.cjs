'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings } = require('./settings.cjs');
const { createDirect } = require('./direct.cjs');

function fixture() {
  const settings = validateSettings({ accountUin: '101', contacts: { coworker: '202', laptop: '303' } });
  const self = { uid: 'u_self', uin: '101' };
  const files = new Map(), counts = { lookup: 0, read: 0, send: 0 };
  const row = {
    chatType: 1, peerUid: 'u_202', peerUin: '202', msgId: '-925099999000000001',
    senderUid: 'u_202', senderUin: '202', msgTime: '1000',
    elements: [{ elementType: 1, textElement: { content: '/task mac test' } }],
  };
  const native = {
    getUidByUin(service, ids) {
      counts.lookup++;
      assert.equal(service, 'FriendsServiceImpl');
      return new Map(ids.map(id => [id, 'u_' + id]));
    },
    getAioFirstViewLatestMsgs(peer, count) {
      counts.read++;
      assert.deepEqual(peer, { chatType: 1, peerUid: 'u_202', guildId: '' });
      assert.equal(count, 1);
      return { result: 0, msgList: [row] };
    },
    async sendMsg(id, peer, elements, attrs) {
      counts.send++;
      assert.equal(id, '0');
      assert.deepEqual(peer, { chatType: 1, peerUid: 'u_202', guildId: '' });
      assert.equal(elements.length, 1);
      assert.equal(elements[0].textElement.content, 'test');
      assert.deepEqual(attrs, new Map());
      return { result: 0 };
    },
  };
  const session = { getMsgService: () => native, getProfileService: () => native };
  const start = () => createDirect(session, self, settings, k => files.get(k), (k, v) => files.set(k, v));
  const scope = { accountUin: '101', peerUin: '202' };
  const args = { contact: 'coworker', request_id: 'one', text: 'test' };
  return { start, scope, counts, row, native, args, files };
}

test('large DM previews share one byte budget across all elements', async () => {
  const f = fixture();
  f.row.elements = Array.from({length:2000}, () => ({textElement:{content:'"中😀\n'}}));
  const result = await f.start()('read_dm_latest', {contact:'coworker'}, f.scope);
  assert.equal(result.message.truncated,true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.message.elements))<=8192);
  assert.equal(result.replyPolicy,'none');
});

test('an allowed alias uses a C2C peer and returns task-looking text as ordinary data', async () => {
  const f = fixture();
  const get = () => f.start()('read_dm_latest', { contact: 'coworker' }, f.scope);
  let result = await get();
  assert.equal(result.message.id, f.row.msgId);
  assert.deepEqual(result.message.elements, ['/task mac test']);
  assert.equal(result.message.fromSelf, false);
  assert.equal(result.replyPolicy, 'none');
  Object.assign(f.row, { senderUid: 'u_self', senderUin: '101' });
  assert.equal((await get()).message.fromSelf, true);
  f.native.getAioFirstViewLatestMsgs = () => ({ result: 0, msgList: [] });
  assert.deepEqual(await get(), { message: null, replyPolicy: 'none' });
});

test('unconfigured recipients, injected peers and changed account/contact mappings fail before native IO', async () => {
  const f = fixture(), call = f.start();
  for (const args of [{ contact: '202' }, { contact: 'constructor' }, { contact: 'coworker', peerUid: 'raw' }]) {
    await assert.rejects(call('read_dm_latest', args, f.scope));
  }
  for (const scope of [{ accountUin: '999', peerUin: '202' }, { accountUin: '101', peerUin: '303' }]) {
    await assert.rejects(call('send_dm_text', f.args, scope), /binding changed/);
  }
  for (const args of [{ ...f.args, text: '' }, { ...f.args, request_id: '../other' }]) {
    await assert.rejects(call('send_dm_text', args, f.scope));
  }
  assert.deepEqual(f.counts, { lookup: 0, read: 0, send: 0 });
});

test('foreign native records and unresolved identities never return content or send', async () => {
  for (const change of [{ chatType: 2 }, { peerUid: 'u_303' }, { peerUin: '303' },
    { senderUid: 'u_303' }, { senderUin: '303' }, { msgId: '0' }]) {
    const f = fixture();
    Object.assign(f.row, change);
    await assert.rejects(f.start()('read_dm_latest', { contact: 'coworker' }, f.scope), /identity|Unverified/);
  }
  const f = fixture();
  f.native.getUidByUin = () => new Map();
  await assert.rejects(f.start()('send_dm_text', f.args, f.scope), /No verified/);
  assert.equal(f.counts.send, 0);
});

test('concurrent DM sends reserve exactly one receipt and retries survive restart and alias changes', async () => {
  const f = fixture(), call = f.start();
  await Promise.all([call('send_dm_text', f.args, f.scope), call('send_dm_text', f.args, f.scope)]);
  assert.equal((await f.start()('send_dm_text', f.args, f.scope)).state, 'accepted');
  await assert.rejects(call('send_dm_text', { ...f.args, text: 'changed' }, f.scope), /different/);
  await assert.rejects(call('send_dm_text', { ...f.args, contact: 'laptop' },
    { ...f.scope, peerUin: '303' }), /different/);
  assert.equal(f.counts.send, 1);
  assert.deepEqual([...f.files.keys()], ['dm-outbox/one.json']);
});

test('loss of a native reply leaves a durable unknown receipt', async () => {
  const f = fixture();
  f.native.sendMsg = () => { f.counts.send++; throw Error('connection lost'); };
  await assert.rejects(f.start()('send_dm_text', f.args, f.scope), /connection lost/);
  assert.equal((await f.start()('send_dm_text', f.args, f.scope)).state, 'unknown');
  assert.equal(f.counts.send, 1);
});

test('settings require an account pin and valid local aliases', () => {
  for (const value of [null, {}, { accountUin: 101 }, { accountUin: '101', typo: true },
    { accountUin: '101', contacts: null }, { accountUin: '101', contacts: { man: '101' } },
    { accountUin: '101', contacts: { 'bad/name': '202' } }]) {
    assert.throws(() => validateSettings(value));
  }
});
