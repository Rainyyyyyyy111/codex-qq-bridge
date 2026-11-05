'use strict';
const { createHash } = require('node:crypto');
const { checkedResult, checkArgs, validateText, textElement } = require('./native.cjs');

// A direct call always uses the authenticated account and a locally configured alias.
// It has no dispatcher, background reader, or link to the group event state machine.
function createDirect(session, self, settings, readJSON, writeJSON) {
  if (settings.accountUin !== self.uin) throw Error('Direct contact configuration belongs to another account');
  const msgs = session.getMsgService();

  async function resolvePeer(uin) {
    const mapping = await session.getProfileService().getUidByUin('FriendsServiceImpl', [uin]);
    const uid = mapping.get(uin);
    if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(uid) || uid === self.uid) {
      throw Error('No verified native UID for this contact');
    }
    return { chatType: 1, peerUid: uid, guildId: '' };
  }

  async function latest(uin) {
    const peer = await resolvePeer(uin);
    const result = await msgs.getAioFirstViewLatestMsgs(peer, 1);
    checkedResult('getAioFirstViewLatestMsgs', result);
    if (!Array.isArray(result.msgList) || result.msgList.length > 1) throw Error('Invalid DM result');
    if (!result.msgList.length) return { message: null, replyPolicy: 'none' };
    const [m] = result.msgList;
    if (m.chatType !== 1 || m.peerUid !== peer.peerUid ||
        (m.peerUin && String(m.peerUin) !== '0' && String(m.peerUin) !== uin)) {
      throw Error('Direct conversation identity mismatch');
    }
    const fromSelf = m.senderUid === self.uid;
    const sender = fromSelf ? self.uin : uin;
    if ((!fromSelf && m.senderUid !== peer.peerUid) ||
        (m.senderUin && String(m.senderUin) !== '0' && String(m.senderUin) !== sender) ||
        !/^-?[1-9]\d*$/.test(String(m.msgId))) throw Error('Unverified DM sender or message ID');
    return {
      message: { id: String(m.msgId), fromSelf, time: new Date(Number(m.msgTime) * 1000).toISOString(),
        elements: m.elements.map((e) => e.textElement?.content ?? { elementType: e.elementType }) },
      replyPolicy: 'none',
    };
  }

  async function send(uin, args) {
    const { text, request_id: requestId } = args;
    validateText(text, requestId);
    const key = 'dm-outbox/' + requestId + '.json';
    const digest = createHash('sha256').update(text).digest('hex');
    function existing() {
      const saved = readJSON(key);
      if (saved && (saved.accountUin !== self.uin || saved.peerUin !== uin || saved.digest !== digest)) {
        throw Error('DM request_id already used for a different account, contact or text');
      }
      return saved;
    }
    const previous = existing();
    if (previous) return previous;
    const peer = await resolvePeer(uin);
    const raced = existing();
    if (raced) return raced;
    const receipt = { requestId, accountUin: self.uin, peerUin: uin, digest, state: 'unknown' };
    writeJSON(key, receipt);
    const result = await msgs.sendMsg('0', peer, [textElement(text)], new Map());
    checkedResult('sendMsg', result);
    const accepted = { ...receipt, state: 'accepted' };
    writeJSON(key, accepted);
    return accepted;
  }

  return async function call(name, args, scope) {
    const sending = name === 'send_dm_text';
    if (!sending && name !== 'read_dm_latest') throw Error('Unknown DM operation');
    checkArgs(args, sending ? ['contact', 'text', 'request_id'] : ['contact']);
    const uin = settings.peers.get(args.contact);
    if (!uin) throw Error('Unknown local contact alias');
    if (scope?.accountUin !== self.uin || scope.peerUin !== uin)
      throw Error('Contact binding changed; restart the service and MCP client');
    return sending ? send(uin, args) : latest(uin);
  };
}
module.exports = { createDirect };
