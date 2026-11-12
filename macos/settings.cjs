'use strict';
const fs = require('node:fs');
const path = require('node:path');
const validUin = (s) => typeof s === 'string' && /^[1-9][0-9]{0,19}$/.test(s);
function validateSettings(value) {
  if (!value || !validUin(value.accountUin) ||
      Object.keys(value).some((k) => !['accountUin', 'contacts', 'collaborationContact'].includes(k))) {
    throw Error('Invalid accountUin or unrecognized settings.json field');
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
  const collaborationContact = value.collaborationContact;
  if (collaborationContact !== undefined && !peers.has(collaborationContact))
    throw Error('collaborationContact must name a configured contact');
  return { accountUin: value.accountUin, peers, collaborationContact };
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

function optionalFile(file) {
  try {return fs.readFileSync(file,'utf8');}
  catch (e) {if(e.code==='ENOENT')return undefined;throw e;}
}
// A SQLite writer lock serializes simultaneous "pair" calls and releases on process death.
// It holds no QQ messages, contacts or credentials. The native worker still reads settings.json.
function pairContact(state, peerUin, explicitSelf, collaborationState) {
  if (!validUin(peerUin) || (explicitSelf!==undefined && !validUin(explicitSelf)))
    throw Error('Usage: bridge collab pair WINDOWS_QQ [MAC_QQ], using decimal QQ account numbers');
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  const {DatabaseSync}=require('node:sqlite');
  const lock=new DatabaseSync(path.join(state,'settings-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=4000; BEGIN IMMEDIATE');
    const names=['settings.json','account.json','binding.json'];
    const raw=names.map(name=>optionalFile(path.join(state,name)));
    const [existing,account,binding]=raw.map(text=>text===undefined?undefined:JSON.parse(text));
    const checked=existing===undefined?undefined:validateSettings(existing);
    const pins=[explicitSelf,checked?.accountUin].filter(value=>value!==undefined);
    for (const native of [account,binding]) {
      if (native===undefined) continue;
      const v=native?.uin;
      if (!validUin(v) && !(Number.isSafeInteger(v) && v>0)) throw Error('Invalid account pin in native profile');
      pins.push(String(v));
    }
    const ledger=collaborationState && path.join(collaborationState,'rounds.sqlite');
    if(ledger && fs.existsSync(ledger)) {
      const db=new DatabaseSync(ledger,{readOnly:true});
      try {
        const active=db.prepare('SELECT self,peer FROM binding WHERE slot=1').get();
        if(!active || !validUin(active.self) || active.peer!==peerUin)
          throw Error('The collaboration state belongs to another pair; use a separate profile');
        pins.push(active.self);
      } finally {db.close();}
    }
    const self=pins[0];
    if (!self) throw Error('First setup requires the local Mac QQ account: bridge collab pair WINDOWS_QQ MAC_QQ');
    if (pins.some(v=>v!==self) || (account?.uid && binding?.uid && binding.uid!==account.uid))
      throw Error('Local account identity disagrees with settings.json, account.json, binding.json or the supplied MAC_QQ');
    if (self===peerUin) throw Error('The Mac and Windows QQ accounts must be different');
    let alias=checked?.collaborationContact;
    if (alias) {
      if (checked.peers.get(alias)!==peerUin) throw Error('This profile is already paired with another account');
      if(collaborationState)fs.mkdirSync(collaborationState,{recursive:true,mode:0o700});
      return {state:'already-paired',contact:alias};
    }
    const contacts={...existing?.contacts};
    alias=Object.keys(contacts).find(name=>contacts[name]===peerUin);
    if (!alias) {
      alias='windows';
      for (let i=2;Object.hasOwn(contacts,alias);i++) alias='windows-'+i;
      contacts[alias]=peerUin;
    }
    const settings={...existing,accountUin:self,contacts,collaborationContact:alias};
    validateSettings(settings);
    if(collaborationState)fs.mkdirSync(collaborationState,{recursive:true,mode:0o700});
    const dest=path.join(state,names[0]);
    if(fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink())
      throw Error('Edit the linked settings.json at its original location');
    const temp=dest+'.'+require('node:crypto').randomUUID()+'.tmp';
    try {
      fs.writeFileSync(temp,JSON.stringify(settings,null,2)+'\n',{mode:0o600,flag:'wx',flush:true});
      if(names.some((name,i)=>optionalFile(path.join(state,name))!==raw[i]))
        throw Error('Local profile changed during pairing; rerun with the current identity');
      fs.renameSync(temp,dest);
    } finally {fs.rmSync(temp,{force:true});}
    return {state:'paired',contact:alias};
  } finally {lock.close();}
}
module.exports = { loadSettings, validateSettings, pairContact };
if (require.main === module) {
  try {
    if(process.argv[2]==='--pair') {
      if(process.argv.length<5 || process.argv.length>6)throw Error('Usage: bridge collab pair WINDOWS_QQ [MAC_QQ]');
      console.log(JSON.stringify(pairContact(process.argv[3],process.argv[4],process.argv[5],process.env.QQ_BRIDGE_COLLAB_STATE)));
    } else loadSettings(process.argv[2], process.argv[3]);
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
