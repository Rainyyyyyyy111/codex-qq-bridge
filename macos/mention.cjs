'use strict';

// QQNT has returned atUid as both a QQ number and a signed 32-bit decimal.
function targetUin(value) {
  const s = String(value);
  if (/^[1-9]\d*$/.test(s)) return s;
  if (/^-[1-9]\d*$/.test(s) && BigInt(s) >= -2147483648n)
    return String(BigInt.asUintN(32, BigInt(s)));
  return null;
}
function mentionPrompt(raw, binding, owner, allowQuote = false) {
  if (!raw || !owner || String(raw.senderUin) !== owner.uin || owner.uin === binding.uin ||
      raw.senderUid === binding.uid || raw.chatType !== 2 || String(raw.peerUid) !== binding.id ||
      !['0', binding.id].includes(String(raw.peerUin ?? '0')) ||
      [raw.msgSeq,raw.msgId].some(id => typeof id === 'number' && !Number.isSafeInteger(id)) ||
      !/^[1-9]\d{0,18}$/.test(String(raw.msgSeq)) || BigInt(raw.msgSeq) > 9223372036854775807n || !/^-?[1-9]\d*$/.test(String(raw.msgId)) ||
      !Array.isArray(raw.elements)) return null;

  let addressed = false, hasTaskText = false, quoted = false, otherMention = false;
  const body = [];
  for (const e of raw.elements) {
    // QQ's quote preview is never a task or evidence of the quoted sender.
    if (e?.elementType === 7 && e.replyElement) { quoted = true; continue; }
    if (e?.elementType !== 1 || !e.textElement) return null;
    const t = e.textElement;
    if (t.atType === 0 && typeof t.content === 'string') {
      body.push(t.content);
      if (t.content.trim()) hasTaskText = true;
      continue;
    }
    if (t.atType === 1 && typeof t.content === 'string') {
      body.push(t.content);
      continue;
    }
    if (t.atType !== 2 && t.atType !== 4) return null;
    const ids = [t.atUid, t.atNtUid].filter(id => id != null && id !== '' && String(id) !== '0');
    if (!ids.length) return null;
    const matches = ids.map(id => String(id) === binding.uid || targetUin(id) === binding.uin);
    if (matches.every(Boolean)) addressed = true;
    else if (matches.some(Boolean) || typeof t.content !== 'string') return null;
    else { otherMention = true; body.push(t.content); }
  }
  const prompt = body.join('');
  return (addressed || (allowQuote && quoted && !otherMention)) && hasTaskText && prompt.length <= 16000 ? prompt : null;
}
module.exports = { mentionPrompt };
