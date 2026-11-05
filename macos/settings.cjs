'use strict';
const fs = require('node:fs');
const path = require('node:path');
const validUin = (s) => typeof s === 'string' && /^[1-9][0-9]{0,19}$/.test(s);
function validateSettings(value) {
  if (!value || !validUin(value.accountUin) ||
      Object.keys(value).some((k) => !['accountUin', 'contacts'].includes(k))) {
    throw Error('settings.json requires a decimal accountUin string and optional contacts');
  }
  const contacts = value.contacts === undefined ? {} : value.contacts;
  if (!contacts || typeof contacts !== 'object' || Array.isArray(contacts)) {
    throw Error('contacts must map local aliases to QQ numbers');
  }
  const peers = new Map();
  for (const [alias, uin] of Object.entries(contacts)) {
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(alias) || !validUin(uin) || uin === value.accountUin) {
      throw Error('Invalid contact alias, QQ number or self contact');
    }
    peers.set(alias, uin);
  }
  return { accountUin: value.accountUin, peers };
}
function loadSettings(state, profile) {
  let json;
  try {
    json = fs.readFileSync(path.join(state, 'settings.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (profile === 'default') return { accountUin: null, peers: new Map() };
    throw Error('Create settings.json with the expected accountUin before starting this profile');
  }
  return validateSettings(JSON.parse(json));
}
module.exports = { loadSettings, validateSettings };
if (require.main === module) {
  try { loadSettings(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
