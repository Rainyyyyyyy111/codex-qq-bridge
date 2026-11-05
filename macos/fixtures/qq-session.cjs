// Preloaded ONLY by the offline worker test. No Tencent binary or network service is used.
'use strict';
const Module = require('node:module');
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const self = process.env.FIXTURE_UIN;
const base = '/Applications/QQ.app/Contents/Resources/app/';
const account = { uid: 'u_' + self, uin: self };
let loginCallbacks, sessionCallbacks;
const login = {
  initConfig() {}, getMachineGuid: () => '00000000000000000000000000000000',
  addKernelLoginListener(callbacks) { loginCallbacks = callbacks; },
  connect() { setImmediate(() => loginCallbacks.onQRCodeLoginSucceed(account)); },
  getMsfStatus: () => 3,
};
const session = {
  init(config, ignored1, ignored2, callbacks) { sessionCallbacks = callbacks; },
  startNT() { setImmediate(() => sessionCallbacks.onOpentelemetryInit({ is_init: true })); },
  getGroupService: () => ({
    addKernelGroupListener() {},
    getGroupList: () => ({ groupList: [{ groupName: 'Codex共享chat', groupCode: '900' }] }),
  }),
  getProfileService: () => ({
    getUidByUin: (_, [uin]) => new Map([[uin, 'u_' + uin]]),
  }),
  getMsgService: () => ({
    getAioFirstViewLatestMsgs(peer) {
      const group = peer.chatType === 2;
      const peerUin = group ? '900' : peer.peerUid.slice(2);
      return { result: 0, msgList: [{
        ...peer, peerUin, senderUin: group ? '400' : peerUin, senderUid: group ? 'u_400' : peer.peerUid,
        msgTime: '1000', msgSeq: '1', msgId: '10001',
        elements: [{ elementType: 1, textElement: { atType: 0, content: 'fixture ' + self } }],
      }] };
    },
    sendMsg(_, peer, elements) {
      assert.equal(peer.chatType, 1);
      appendFileSync('test-sends.jsonl', JSON.stringify({ from: self, to: peer.peerUid,
        text: elements[0].textElement.content }) + '\n');
      return { result: 0 };
    },
  }),
};
const wrapper = { NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
  NodeIKernelLoginService: { get: () => login }, NodeIQQNTWrapperSession: { create: () => session } };
Object.defineProperty(process, 'arch', { value: 'arm64' });
const load = Module._load;
Module._load = function (name, ...rest) {
  if (name === base + 'package.json') return { version: '6.9.55-28172' };
  if (name === base + 'wrapper.node') return wrapper;
  return load.call(this, name, ...rest);
};
