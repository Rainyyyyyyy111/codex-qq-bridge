const test = require('node:test');
const assert = require('node:assert/strict');
const { mentionPrompt } = require('./mention.cjs');
const binding = { id: '123', uid: 'u_mac', uin: '4000000000' };
const owner = { uin: '789' };
const at = (atType, atUid, atNtUid) => ({ elementType: 1, textElement: { atType, atUid, atNtUid, content: '@同名' } });
const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
const addressed = at(2, '-294967296', 'u_mac');
const raw = (elements, extra = {}) => ({chatType: 2, peerUid: '123', peerUin: '123', senderUin: '789',
  senderUid: 'u_owner', msgSeq: '17', msgId: '-987654321012345678', elements, ...extra});
test('only signed native identities address the pinned Mac; QQ text stays verbatim', () => {
  const prompt = " A\n$(touch /tmp/no) ‘正文’  ";
  for (const mention of [addressed, at(4, '0', 'u_mac'), at(2, '4000000000', '')])
    assert.equal(mentionPrompt(raw([mention, text(prompt)]), binding, owner), prompt);
  for (const row of [
    raw([text('@同名 任务')]), raw([text('/task mac 任务')]), raw([at(1,'0',''), text('任务')]),
    raw([at(4,'0',''), text('任务')]), raw([at(2,'1','u_mac'), text('任务')]),
    raw([at(2,'4000000000','u_other'), text('任务')]), raw([addressed, text('  ')]),
    raw([addressed, {elementType:7}, text('任务')]), raw([addressed, text('x')], {chatType:1}),
    raw([addressed, text('x')], {peerUid:'555'}), raw([addressed, text('x')], {senderUin:'555'}),
    raw([addressed, text('x')], {senderUid:'u_mac'}), raw([addressed,text('x')],{msgId:'0'}),
    raw([addressed,text('x')],{msgId:Number.MAX_SAFE_INTEGER+1}), raw([addressed,text('x'.repeat(16001))]),
  ]) assert.equal(mentionPrompt(row, binding, owner), null);
});
