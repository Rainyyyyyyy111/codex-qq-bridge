'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {configurePair,request}=require('./paired-dm.cjs');
const {loginState}=require('./dm-only.cjs');

test('private-only login starts the peer callback and history without querying any group',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dm-only-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pair=configurePair(dir,'101','202'), state=loginState(dir);
  assert.equal(state.accountUin,'101');
  let listener,loginReady=0,offline=0;
  const native={
    addKernelMsgListener(cb){listener=cb;return 1;},removeKernelMsgListener(){},
    async getAioFirstViewLatestMsgs(peer){assert.equal(peer.chatType,1);return {result:0,msgList:[]};}
  };
  const session={
    getGroupService(){throw Error('Private-only login must not access groups');},
    getProfileService(){return {getUidByUin:async()=>new Map([['202','u_peer']])};},
    getMsgService(){return native;}
  };
  const handle=await state.start({session,callbacks:x=>x,self:{uin:'101',uid:'u_self'},
    ready:()=>{loginReady++;},offline:()=>{offline++;}});
  try{
    await handle.ready;
    assert.equal(loginReady,1);
    const info=await request(pair,'collab_info',{});
    assert.equal(info.history,'ready');assert.equal(info.pushSubscribed,true);
    listener.onKickedOffLine();assert.equal(offline,1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pair.dir,'dm-only-status.json'))).phase,'offline');
  }finally{handle.close();}
});

test('portable installer injects private-only branch before group, filters saved login, and remains idempotent', {skip:process.platform!=='win32'}, t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-dm-install-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const outs=path.join(root,'outputs');fs.mkdirSync(outs);
  fs.writeFileSync(path.join(outs,'qq-target-watch.cjs'),'function watch({session, callbacks, self, target, dataDir, ready}) {\n}\n');
  const reader=path.join(outs,'qq-read-latest.cjs');
  fs.writeFileSync(reader,[
    'const [addon, dataDir, qrFile] = process.argv.slice(2);',
    'function startSession({uin, uid}) {',
    "    if (process.argv[5] === '--watch') { throw Error('group'); }",
    '}',
    'function choose(LocalLoginInfoList) {return LocalLoginInfoList.filter(account => account.isQuickLogin);}',
    'function save(png){','    fs.writeFileSync(qrFile,png);','}'
  ].join('\n'));
  const control=path.join(outs,'qq-target.ps1');
  fs.writeFileSync(control,[
    "param([ValidateSet('start','status')][string]$Action)",
    "if (!$lock.WaitOne(10000)) { throw 'Another monitor operation is in progress' }",
    'try {',"    'old'",'} finally { $lock.Dispose() }'
  ].join('\n'));
  for(let i=0;i<2;i++)execFileSync('pwsh',['-NoProfile','-File',path.join(__dirname,'install.ps1'),'-WatcherRoot',root],{windowsHide:true,stdio:'pipe'});
  const code=fs.readFileSync(reader,'utf8');
  assert.ok(code.indexOf('if (dmOnly) {')<code.indexOf("if (process.argv[5] === '--watch')"));
  assert.equal((code.match(/dmOnly\.start\(/g)||[]).length,1);
  assert.match(code,/String\(account.uin\) === dmOnly.accountUin/);
  assert.match(code,/String\(uin\) !== dmOnly.accountUin/);
  execFileSync(process.execPath,['--check',reader]);
  assert.match(fs.readFileSync(control,'utf8'),/dm-host\.ps1/);
  assert.ok(fs.existsSync(path.join(outs,'dm-login.html')));
});
