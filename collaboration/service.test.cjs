'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:sleep}=require('node:timers/promises');
const {DatabaseSync}=require('node:sqlite');
const net=require('node:net');
const {localCall}=require('./service.cjs');
const {compare,summary,assess}=require('./verify-live.cjs');

function startChild(state,socket){
  return spawn(process.execPath,['--no-warnings',path.join(__dirname,'service.cjs'),'serve','--state',state,'--socket',socket],
    {windowsHide:true,stdio:'ignore'});
}
test('publishing failure releases the singleton lease and preserves the existing endpoint path',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-publish-'));
  const endpoint=path.join(root,'control.json');fs.mkdirSync(endpoint);
  const child=startChild(root,'unreachable.sock');
  const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;fs.rmSync(root,{recursive:true,force:true});});
  const [code]=await Promise.race([exited,sleep(3500,null,{ref:false}).then(()=>{throw Error('failed service did not exit');})]);
  assert.ok(code>0);assert.ok(fs.statSync(endpoint).isDirectory());
  const db=new DatabaseSync(path.join(root,'daemon-lock.sqlite'));try{db.exec('BEGIN IMMEDIATE; ROLLBACK');}finally{db.close();}
});
test('live revocation during an outstanding native wait prevents a new round being queued',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-revoke-'));
  const address=process.platform==='win32'?'\\\\.\\pipe\\qq-review-'+randomUUID():path.join(root,'bridge.sock');
  const sockets=new Set();let paired=true, waiter;
  const server=net.createServer(s=>{
    sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));let data='';
    s.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;
      const {name}=JSON.parse(data);
      if(!paired)s.end(JSON.stringify({error:'pair revoked'})+'\n');
      else if(name==='collab_info')s.end(JSON.stringify({value:{accountUin:'101',peerUin:'202',streamId:'test'}})+'\n');
      else if(name==='collab_wait')waiter=s;
      else if(name==='collab_send')s.end(JSON.stringify({value:{state:'accepted'}})+'\n');
      else s.end(JSON.stringify({error:'unused'})+'\n');
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
  const state=path.join(root,'state'), child=startChild(state,address), exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;
    for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<150&&!waiter;i++)await sleep(20);
  assert.ok(waiter);
  paired=false;
  await assert.rejects(localCall(state,'submit',{task:'x',draft:'y',question:'z'}),/revoked/);
  assert.equal((await localCall(state,'health',{})).ready,false);
  assert.deepEqual(await localCall(state,'status',{}),[]);
  paired=true;
  const {id}=await localCall(state,'submit',{task:'x',draft:'y',question:'z'});
  const listening=localCall(state,'listen',{after:0,timeout_ms:3000});
  const now=Date.now();
  const text='QQCOLLAB/1\n'+JSON.stringify({id,event:randomUUID(),from:'202',to:'101',at:now,type:'received',data:{}});
  waiter.end(JSON.stringify({value:{event:{cursor:1,text,time:Math.floor(now/1000),messageId:'1'}}})+'\n');
  const page=await listening;
  assert.deepEqual(page.events.map(e=>[e.id,e.type]),[[id,'received']]);
  assert.deepEqual(await localCall(state,'listen',{after:0,timeout_ms:0}),page);
  assert.deepEqual((await localCall(state,'listen',{after:page.cursor,timeout_ms:0})).events,[]);
});
test('live acceptance compares two platforms, a changed decision and the same finalized artifact',()=>{
  const a={id:randomUUID(),role:'owner',platform:'win32',phase:'complete',sameFixture:true,reviewCitesPeerValue:true,
    decisionChanged:true,finalSha256:'a'.repeat(64),finalEvent:randomUUID(),revision:1,ownerQueueToPeerAckMs:5,ownerQueueToReviewMs:100,ownerQueueToCloseMs:250};
  const b={...a,role:'reviewer',platform:'darwin'};
  assert.equal(compare([a,b]).pass,true);
  for(const bad of [{id:'other'},{platform:'win32'},{phase:'awaiting_close'},{finalSha256:'bb'},{decisionChanged:false},{finalEvent:randomUUID()}])
    assert.equal(compare([a,{...b,...bad}]).pass,false);
});

test('owner-only audit needs an authenticated peer digest, complementary platforms and the substantive correction',()=>{
  const finalEvent=randomUUID();
  const round={id:randomUUID(),role:'owner',phase:'complete',
    task:'合成验收。发布规则为两端启动耗时均不超过 150 ms。对照输入作出 GO 或 HOLD 决定，最终答案以决定开头。',
    draft:'GO。Windows 测试值为 80 ms，初步建议发布。',question:'请从本端提供的验收条目找出另一端数值，核对发布规则。',
    review:{evidence:'240 ms'},final:{answer:'HOLD。240 ms 超限。',disposition:'adopted',rationale:'对端超限'},
    finalReceipt:{event:finalEvent,revision:2},events:[{dir:'out',type:'request',at:100},
      ...['received','review','closed'].map((type,i)=>({dir:'in',type,observed:110+30*i}))]};
  const peer={platform:'darwin',finalEvent,revision:2,finalSha256:summary(round).finalSha256};
  assert.equal(assess({...round,peerReceipt:peer},'win32').pass,true);
  for(const receipt of [null,{...peer,platform:'win32'},{...peer,revision:1},{...peer,finalSha256:'0'.repeat(64)},{...peer,finalEvent:randomUUID()}])
    assert.equal(assess({...round,peerReceipt:receipt},'win32').pass,false);
  assert.equal(assess({...round,peerReceipt:peer,review:{evidence:'unknown'}},'win32').pass,false);
});
