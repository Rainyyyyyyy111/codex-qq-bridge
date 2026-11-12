'use strict';
function checkedResult(operation, response) {
  if (String(response?.result) !== '0') {
    throw Error(
      operation +
        ' result=' +
        response?.result +
        ' ' +
        String(response?.errMsg ?? '').slice(0, 200),
    );
  }
}
function checkArgs(args, keys) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !keys.includes(key))
  )
    throw Error('Unexpected arguments');
}
function validateText(text, requestId) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000)
    throw Error('text must be 1..4000 characters');
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId))
    throw Error('Invalid request_id');
}
function textElement(text) {
  return {
    elementType: 1,
    elementId: '',
    textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' },
  };
}
// Cap only the tool-facing element array. Native receipts and event checks use the original.
function previewMessage(message) {
  const limit = 8192;
  let used = 2; // JSON array brackets
  const elements = [];
  for (const item of message.elements) {
    const remaining = limit - used - (elements.length ? 1 : 0);
    if (typeof item !== 'string' || item.length <= remaining) {
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (bytes <= remaining) {
        used += bytes + (elements.length ? 1 : 0);
        elements.push(item);
        continue;
      }
    }
    if (typeof item === 'string' && remaining >= 2) {
      const prefix = n => item.slice(0,n).replace(/[\uD800-\uDBFF]$/, '');
      let low = 0, high = Math.min(item.length, remaining);
      while (low < high) {
        const mid = Math.ceil((low+high)/2);
        if (Buffer.byteLength(JSON.stringify(prefix(mid))) <= remaining) low = mid;
        else high = mid-1;
      }
      elements.push(prefix(low));
    }
    return { ...message, elements, truncated:true };
  }
  return message;
}
module.exports = { checkedResult, checkArgs, validateText, textElement, previewMessage };
