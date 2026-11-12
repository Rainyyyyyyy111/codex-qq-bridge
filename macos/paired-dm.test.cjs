'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path=require('node:path');
const { createPairedDM } = require('./paired-dm.cjs');
const { validateSettings } = require('./settings.cjs');

function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-paired-'));
  fs.mkdirSync(path.join(root,'dm-outbox'));
  const self={uin:'101',uid:'u_101'}, peerUin='202';
  const selfSettings={accountUin:self.uin,contacts:{windows:peerUin,other:'303'},collaborationContact:'windows'};
  let live=validateSettings(selfSettings), handlers, available=true, now=Date.now(), failAfterEvent=false;
  const history=[], sent=[], pages=[], adapters=[];
  const wire=(from=peerUin,to=self.uin) => 'QQCOLLAB/1\n'+JSON.stringify({
    id:randomUUID(), event:randomUUID(), from,to,at:now,type:'note',data:{text:'fixture'}});
  const message=(n,text=wire(),patch={})=>({chatType:1,peerUid:'u_202',peerUin:'202',senderUid:'u_202',
    senderUin:'202',msgId:String(n),msgSeq:String(n),msgTime:String(Math.floor(now/1000)),
    elements:[{elementType:1,textElement:{content:text,atType:0}}],...patch});
  const service={
    addKernelMsgListener(x){handlers=x;return 17;},
    removeKernelMsgListener(id){assert.equal(id,17);handlers=null;},
    getAioFirstViewLatestMsgs(peer,count){
      assert.deepEqual(peer,{chatType:1,peerUid:'u_202',guildId:''});
      assert.equal(count,32);
      return {result:available?0:1,msgList:history.slice(-count).reverse()};
    },
    getMsgsBySeqAndCount(peer,seq,count){
      pages.push(seq);
      return {result:0,msgList:history.filter(row=>BigInt(row.msgSeq)>=BigInt(seq)).slice(0,count)};
    },
    sendMsg(_,peer,elements){sent.push({peer,elements});return {result:0};},
  };
  const session={getMsgService:()=>service,getProfileService:()=>({
    getUidByUin:async(_, [uin])=>new Map([[uin,'u_'+uin]])
  })};
  function open() {
    const readJSON=name=>{
      try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}
      catch(e){if(e.code!=='ENOENT')throw e;}
    };
    const writeJSON=(name,v)=>{
      if (failAfterEvent && name.includes('/msg-')) throw Error('fixture power loss');
      fs.writeFileSync(path.join(root,name+'.tmp'),JSON.stringify(v));
      fs.renameSync(path.join(root,name+'.tmp'),path.join(root,name));
    };
    const adapter=createPairedDM({root,self,settings:validateSettings(selfSettings),currentSettings:()=>live,
      session,callbacks:x=>x,readJSON,writeJSON,now:()=>now,intervalMs:600000});
    adapters.push(adapter);
    return adapter;
  }
  t.after(()=>{adapters.forEach(a=>a.stop());fs.rmSync(root,{recursive:true,force:true});});
  return {root,open,wire,message,history,service,session,sent,pages,
    push:rows=>handlers?.onRecvMsg(rows), update:rows=>handlers?.onMsgInfoListUpdate(rows),
    online:value=>{available=value;}, crash:value=>{failAfterEvent=value;},
    revoke:()=>{live=validateSettings({...selfSettings,collaborationContact:undefined});}};
}
const read=(a,after,timeout_ms=0)=>a.call('collab_wait',{after,timeout_ms});

test('paired native push wakes a 30s wait immediately; updates and history share one durable cursor',async t=>{
  const f=setup(t), a=f.open();
  await a.start();
  const item=f.message(1), pending=read(a,0,30000);
  const info=await a.call('collab_info',{});
  assert.match(info.streamId,/^[0-9a-f-]{36}$/);
  f.push([item]);
  const result=await pending;
  assert.deepEqual(result.event,{cursor:1,text:item.elements[0].textElement.content,messageId:'1',time:Number(item.msgTime)});
  f.update([item]);f.history.push(item);await a.sync();
  assert.deepEqual(await read(a,0),result);
  assert.deepEqual(await read(a,1),{event:null});
  a.stop();
  const restarted=f.open();await restarted.start();
  assert.equal((await restarted.call('collab_info',{})).streamId,info.streamId);
  assert.deepEqual(await read(restarted,0),result);
  assert.deepEqual(await read(restarted,1),{event:null});
});
test('rejects group, third party, self, wrong envelope, forward, mention and ordinary private text',async t=>{
  const f=setup(t), a=f.open();await a.start();
  f.push([f.message(1,'hello'), f.message(2,f.wire('999')), f.message(3,f.wire('202','999')),
    f.message(4,undefined,{chatType:2}),f.message(5,undefined,{peerUid:'u_303'}),
    f.message(6,undefined,{senderUid:'u_101',senderUin:'101'}),f.message(7,undefined,{senderUin:'303'}),
    f.message(8,undefined,{elements:[{elementType:1,textElement:{content:f.wire(),atType:2}}]}),
    f.message(9,undefined,{elements:[{elementType:16,textElement:{content:f.wire(),atType:0}}]}),
    f.message(10,'QQCOLLAB/1\nnot JSON'),f.message(11,undefined,{msgId:Number.MAX_SAFE_INTEGER+5000})]);
  assert.deepEqual(await read(a,0),{event:null});
  await assert.rejects(read(a,2),/cursor/);
});
test('history pages fill an offline gap beyond the recent 32 rows; a torn journal commit recovers', async t=>{
  const f=setup(t), a=f.open();
  f.history.push(f.message(1));await a.start();
  assert.equal((await read(a,0)).event.messageId,'1');
  f.online(false);await a.sync();
  for(let n=2;n<=90;n++) f.history.push(f.message(n));
  f.online(true);await a.sync();
  assert.ok(f.pages.length>0);
  for(let n=1;n<=90;n++) assert.equal((await read(a,n-1)).event.messageId,String(n));
  f.crash(true);const last=f.message(91);f.push([last]);f.crash(false);a.stop();
  const restarted=f.open();await restarted.start();f.push([last]);
  assert.equal((await read(restarted,90)).event.messageId,'91');
  assert.deepEqual(await read(restarted,91),{event:null});
});
test('send pins both envelope identities and rechecks revocation across asynchronous lookup',async t=>{
  const f=setup(t),a=f.open();await a.start();
  const msg={text:f.wire('101','202'),request_id:'fixture-1'};
  assert.equal((await a.call('collab_send',msg)).state,'accepted');
  await a.call('collab_send',msg);
  assert.equal(f.sent.length,1);
  await assert.rejects(a.call('collab_send',{text:f.wire('101','303'),request_id:'bad'}),/pair/);
  const pending=read(a,0,30000),controller=new AbortController();
  const disconnected=a.call('collab_wait',{after:0,timeout_ms:30000},controller.signal);
  controller.abort();assert.deepEqual(await disconnected,{event:null});
  f.session.getProfileService=()=>({getUidByUin:async()=>{f.revoke();return new Map([['202','u_202']]);}});
  await assert.rejects(a.call('collab_send',{...msg,request_id:'fixture-2'}),/pairing changed/);
  assert.equal(f.sent.length,1);f.push([f.message(1)]);a.stop();
  await assert.rejects(pending,/pairing changed/);
});
test('unsupported native callback falls back to history and reports its capability',async t=>{
  const f=setup(t);delete f.service.addKernelMsgListener;
  const a=f.open();await a.start();f.history.push(f.message(1));await a.sync();
  assert.equal((await read(a,0)).event.messageId,'1');
  assert.equal((await a.call('collab_info',{})).push,false);
});

test('pair health requires an actual friend mapping and one available receive path',async t=>{
  const f=setup(t);
  const lookup=f.session.getProfileService;
  f.session.getProfileService=()=>({getUidByUin:async()=>new Map()});
  delete f.service.addKernelMsgListener;
  const a=f.open();await a.start();
  await assert.rejects(a.call('collab_info',{}),/No verified native UID/);
  f.session.getProfileService=lookup;
  f.online(false);
  await assert.rejects(a.call('collab_info',{}),/neither push nor private history/);
  f.online(true);
  assert.equal((await a.call('collab_info',{})).history,'recent-window');
});

test('older paired journals receive a stable stream identity without losing their cursor',async t=>{
  const f=setup(t), a=f.open();await a.start();f.push([f.message(8)]);a.stop();
  const dir=fs.readdirSync(f.root).find(name=>name.startsWith('collab-inbox-'));
  const file=path.join(f.root,dir,'head.json'), metadata=JSON.parse(fs.readFileSync(file,'utf8'));
  delete metadata.streamId;fs.writeFileSync(file,JSON.stringify(metadata));
  const upgraded=f.open();
  const info=await upgraded.call('collab_info',{});
  assert.equal(info.cursor,1);
  assert.match(info.streamId,/^[0-9a-f-]{36}$/);
  assert.equal((await read(upgraded,0)).event.messageId,'8');
  upgraded.stop();
  assert.equal((await f.open().call('collab_info',{})).streamId,info.streamId);
});
