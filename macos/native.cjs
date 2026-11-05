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
module.exports = { checkedResult, checkArgs, validateText, textElement };
