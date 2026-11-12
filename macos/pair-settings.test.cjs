'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {pairContact,loadSettings}=require('./settings.cjs');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mac-pair-config-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  return {dir,file,save:(name,v)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(v))};
}

test('first setup requires self; same peer retries preserve existing settings bytes',t=>{
  const {dir,file}=fixture(t);
  assert.throws(()=>pairContact(dir,'202'),/First setup/);
  assert.equal(fs.existsSync(file),false);
  assert.deepEqual(pairContact(dir,'202','101'),{state:'paired',contact:'windows'});
  const first=fs.readFileSync(file);
  assert.deepEqual(pairContact(dir,'202'),{state:'already-paired',contact:'windows'});
  assert.deepEqual(fs.readFileSync(file),first);
  assert.throws(()=>pairContact(dir,'303'),/already paired/);
  assert.throws(()=>pairContact(dir,'101'),/different/);
  assert.deepEqual(fs.readFileSync(file),first);
});

test('merges with unrelated aliases, reuses a matching alias and never overwrites an occupied alias',t=>{
  const {dir,save,file}=fixture(t);
  const contacts={family:'303',windows:'404',lab:'202'};
  save('settings.json',{accountUin:'101',contacts});
  save('binding.json',{uin:'101',uid:'u_101'});
  assert.equal(pairContact(dir,'202').contact,'lab');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).contacts,contacts);
  save('settings.json',{accountUin:'101',contacts});
  assert.equal(pairContact(dir,'505').contact,'windows-2');
  assert.deepEqual(Object.fromEntries(loadSettings(dir,'default').peers),{...contacts,'windows-2':'505'});
});

test('native self identity is reusable; conflicting native/explicit/ledger pins fail before changing contacts',t=>{
  const {dir,file,save}=fixture(t), collab=path.join(dir,'side');
  save('account.json',{uin:'101',uid:'u_101'});
  save('binding.json',{uin:'101',uid:'u_other'});
  assert.throws(()=>pairContact(dir,'202'),/identity/);
  assert.equal(fs.existsSync(file),false);
  save('binding.json',{uin:101,uid:'u_101'});
  assert.throws(()=>pairContact(dir,'202','303'),/identity/);
  pairContact(dir,'202',undefined,collab);
  const first=fs.readFileSync(file);
  const db=new (require('node:sqlite').DatabaseSync)(path.join(collab,'rounds.sqlite'));
  db.exec("CREATE TABLE binding(slot INTEGER,self TEXT,peer TEXT);INSERT INTO binding VALUES(1,'101','999')");
  db.close();
  assert.throws(()=>pairContact(dir,'202',undefined,collab),/another pair/);
  assert.deepEqual(fs.readFileSync(file),first);
});

test('two competing CLI calls select one peer and retain unrelated contacts',async t=>{
  const {dir,file,save}=fixture(t);
  save('settings.json',{accountUin:'101',contacts:{known:'505'}});
  const args=[path.join(__dirname,'settings.cjs'),'--pair',dir], env={...process.env,QQ_BRIDGE_COLLAB_STATE:path.join(dir,'side')};
  const results=await Promise.allSettled(['202','303'].map(uin=>run(process.execPath,[...args,uin],{env})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const settings=JSON.parse(fs.readFileSync(file));
  assert.equal(settings.contacts.known,'505');
  assert.ok(['202','303'].includes(settings.contacts[settings.collaborationContact]));
  assert.deepEqual(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')),[]);
});
