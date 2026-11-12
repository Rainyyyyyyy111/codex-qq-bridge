// Preloaded ONLY by the offline worker test. No Tencent binary or network service is used.
'use strict';
const Module = require('node:module');
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const self = process.env.FIXTURE_UIN;
const base = '/Applications/QQ.app/Contents/Resources/app/';
const account = { uid: 'u_' + self, uin: self };
let loginCallbacks, sessionCallbacks;
const dmRows = [];
let dmListener;
if (process.send) {
  process.on('message', command => {
    if (command?.op !== 'fixture-push') return;
    dmRows.push(command.row);
    dmListener?.onRecvMsg([command.row]);
    process.send({op:'fixture-pushed'});
  });
}
// The macOS worker always uses bridge.sock. The Windows-hosted offline test uses
// one private named pipe to exercise the very same JSON-line IPC listener.
if (process.platform === 'win32' && process.env.FIXTURE_PIPE) {
  const net = require('node:net'), fs = require('node:fs');
  const listen = net.Server.prototype.listen, chmod = fs.chmodSync;
  net.Server.prototype.listen = function(...args) {
    if (args[0]==='bridge.sock') args[0]=process.env.FIXTURE_PIPE;
    return listen.apply(this,args);
  };
  fs.chmodSync = (file,...args) => file==='bridge.sock' ? undefined : chmod(file,...args);
}
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
    getGroupList: () => ({ groupList: (process.env.FIXTURE_AMBIGUOUS ? ['900','901'] : ['900'])
      .map(groupCode=>({ groupName:'Codex共享chat', groupCode })) }),
  }),
  getProfileService: () => ({
    getUidByUin: (_, [uin]) => new Map([[uin, 'u_' + uin]]),
  }),
  getMsgService: () => ({
    addKernelMsgListener(callbacks) { dmListener=callbacks;return 7; },
    removeKernelMsgListener() { dmListener=undefined; },
    getAioFirstViewLatestMsgs(peer,count) {
      const group = peer.chatType === 2;
      if (!group && count>1) return {result:0,msgList:dmRows.slice(-count)};
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
  const normalized = name.replaceAll('\\','/');
  if (normalized === base + 'package.json') return { version: '6.9.55-28172' };
  if (normalized === base + 'wrapper.node') return wrapper;
  return load.call(this, name, ...rest);
};
