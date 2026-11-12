const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {configurePair,readPair,createAdapter,startPairedDm,request,prefix}=require('./paired-dm.cjs');
const {nativeClient}=require('../collaboration/transport.cjs');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paired-dm-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=configurePair(dir,'101','202');
  const self={uin:'101',uid:'u_self'};
  const rows=[], sent=[], listeners=new Set(), pages=[];
  const target={chatType:1,peerUid:'u_peer',guildId:''};
  const native={
    addKernelMsgListener(listener){listeners.add(listener);return listener;},
    removeKernelMsgListener(listener){listeners.delete(listener);},
    async getAioFirstViewLatestMsgs(peer,count) {
      assert.deepEqual(peer,target);
      return {result:0,msgList:rows.slice(-count)};
    },
    async getMsgsIncludeSelf(peer,id,count,reverse) {
      assert.deepEqual(peer,target);assert.equal(reverse,false);
      pages.push(id);
      const end=rows.findIndex(r=>r.msgId===id)+1;
      return {result:0,msgList:rows.slice(Math.max(0,end-count),end)};
    },
    async sendMsg(id,peer,elems,attrs) {
      assert.equal(id,'0');assert.deepEqual(peer,target);assert.ok(attrs instanceof Map);
      sent.push(elems[0].textElement.content);return {result:0};
    }
  };
  const profile={getUidByUin:async(service,ids)=>{
    assert.equal(service,'FriendsServiceImpl');assert.deepEqual(ids,['202']);return new Map([['202','u_peer']]);
  }};
  const session={getProfileService:()=>profile,getMsgService:()=>native};
  function wire(seq,from='202',to='101') {
    return prefix+JSON.stringify({id:'00000000-0000-4000-8000-000000000002',event:'00000000-0000-4000-8000-'+String(seq).padStart(12,'0'),from,to,at:Date.now(),type:'request',data:{question:'example'}});
  }
  function msg(seq, text=wire(seq)) {
    return {chatType:1,peerUid:'u_peer',peerUin:'202',senderUid:'u_peer',senderUin:'202',
      msgId:String(10n**19n+BigInt(seq)),msgSeq:String(seq),msgTime:cfg.since+1,
      elements:[{elementType:1,textElement:{atType:0,content:text}}]};
  }
  const start=()=>startPairedDm({session,self,callbacks:x=>x,dataDir:dir});
  const adapter=()=>createAdapter({session,self,cfg,current:()=>readPair(dir)?.generation===cfg.generation});
  return {cfg,dir,self,session,profile,rows,sent,pages,listeners,native,wire,msg,start,adapter};
}
const read=(adapter,after=0,timeout_ms=0)=>adapter.call('collab_wait',{after,timeout_ms});

test('push wakes authenticated named-pipe wait; durable cursor filters foreign, plain and echoed messages',async t=>{
  const f=fixture(t);
  let s=await f.start();
  try{
    await s.ready;
    const rpc=nativeClient({socket:f.cfg.socket,tokenFile:f.cfg.tokenFile});
    assert.equal((await rpc('collab_info',{})).peerUin,'202');
    await assert.rejects(request({...f.cfg,token:'0'.repeat(64)},'collab_info',{}),/Invalid local token/);
    const pending=rpc('collab_wait',{after:0,timeout_ms:2000},3000);
    await new Promise(r=>setTimeout(r,20));
    const bad=f.msg(1);
    const blocked=[f.msg(2,'ordinary'),{...bad,chatType:2},{...bad,peerUid:'u_other'},
      {...bad,senderUid:'u_other'},{...bad,senderUin:'999'},{...bad,peerUin:'999'},
      {...bad,senderUid:'u_self',senderUin:'101'},{...bad,msgTime:f.cfg.since-1},
      {...bad,elements:[...bad.elements,...bad.elements]},f.msg(3,f.wire(3,'999','101')),
      f.msg(4,prefix+'not json'),f.msg(5,prefix+'x'.repeat(4000))];
    for(const l of f.listeners) l.onRecvMsg(blocked);
    assert.equal((await request(f.cfg,'collab_wait',{after:0,timeout_ms:0})).event,null);
    const valid=f.msg(6);
    const began=performance.now();
    for(const l of f.listeners){l.onRecvMsg([valid]);l.onMsgInfoListUpdate([valid]);}
    const {event}=await pending;
    t.diagnostic('simulated native callback to waiting local service: '+(performance.now()-began).toFixed(2)+' ms');
    assert.equal(event.messageId,valid.msgId);assert.equal(event.text,valid.elements[0].textElement.content);
    assert.equal((await request(f.cfg,'collab_wait',{after:event.cursor,timeout_ms:0})).event,null);
    s.close();s=await f.start();await s.ready;
    assert.deepEqual((await request(f.cfg,'collab_wait',{after:0,timeout_ms:0})).event,event);
  }finally{s.close();}
});

test('restart reads missed pages older than one window in chronological order; ordinary DMs do not enter the work queue',async t=>{
  const f=fixture(t);
  let adapter=f.adapter();
  try{
    f.rows.push(f.msg(1,'baseline'));await adapter.refresh();adapter.close();adapter=f.adapter();
    for(let seq=2;seq<=90;seq++)f.rows.push(f.msg(seq,seq%7===0 ? f.wire(seq) : 'chat'));
    await adapter.refresh();assert.ok(f.pages.length>=2);
    let after=0;
    for(let seq=7;seq<=84;seq+=7){
      const {event}=await read(adapter,after);
      assert.equal(event.messageId,f.msg(seq).msgId);after=event.cursor;
    }
    await adapter.refresh();assert.equal((await read(adapter,after)).event,null);
    assert.equal((await adapter.call('dm_latest')).message.text,'chat');
  } finally{adapter.close();}
});

test('startup live callback overlaps history; native IDs and order survive both paths',async t=>{
  const f=fixture(t), adapter=f.adapter();
  let enter,release;
  const inside=new Promise(r=>{enter=r;});
  f.native.getAioFirstViewLatestMsgs=async()=>{enter();await new Promise(r=>{release=r;});return {result:0,msgList:[f.msg(1),f.msg(2)]};};
  try{
    const work=adapter.refresh();await inside;
    adapter.ingest([f.msg(2),f.msg(3)]);
    assert.equal((await read(adapter)).event,null);
    release();await work;
    let after=0;
    for(const seq of [1,2,3]){const {event}=await read(adapter,after);assert.equal(event.messageId,f.msg(seq).msgId);after=event.cursor;}
    assert.equal((await read(adapter,after)).event,null);
  }finally{adapter.close();}
});

test('when opening the DM gives a native error, retry the same verified peer through history ID zero',async t=>{
  const f=fixture(t), a=f.adapter(), row=f.msg(1);
  f.native.getAioFirstViewLatestMsgs=async()=>({result:-1,msgList:[]});
  let fallback=0;
  f.native.getMsgsIncludeSelf=async(peer,anchor,count,reverse)=>{
    assert.equal(peer.peerUid,'u_peer');assert.equal(anchor,'0');assert.ok([1,32].includes(count));assert.equal(reverse,false);
    fallback++;return {result:0,msgList:[row]};
  };
  try{
    await a.refresh();
    assert.equal(fallback,1);assert.equal((await a.call('collab_info')).history,'ready');
    assert.equal((await read(a)).event.messageId,row.msgId);
    assert.equal((await a.call('dm_latest',{expected:{accountUin:'101',peerUin:'202'}})).message.messageId,row.msgId);
    await assert.rejects(a.call('dm_latest',{expected:{accountUin:'101',peerUin:'404'}}),/expected scope/);
    await assert.rejects(a.call('dm_send',{expected:{accountUin:'999',peerUin:'202'},request_id:'bad',text:'ignore'}),/expected scope/);
    assert.equal(f.sent.length,0);
  }finally{a.close();}
});

test('manual send, protocol send, uncertain native submission, binding changes and restart cannot repeat submission',async t=>{
  const f=fixture(t);let a=f.adapter();
  const manual={request_id:'plain-1',text:'pair note'};
  const coop={request_id:'round-1',text:f.wire(1,'101','202')};
  try{
    await a.refresh();
    await Promise.all([a.call('dm_send',manual),a.call('dm_send',manual)]);
    assert.equal(f.sent.length,1);
    await assert.rejects(a.call('collab_send',manual),/Invalid scoped/);
    await assert.rejects(a.call('dm_send',coop),/Invalid scoped/);
    await assert.rejects(a.call('dm_send',{...manual,text:'other'}),/different text/);
    await assert.rejects(a.call('collab_send',{...coop,text:f.wire(1,'101','999')}),/Invalid scoped/);
    assert.equal((await a.call('collab_send',coop)).state,'accepted');
    f.native.sendMsg=async()=>{f.sent.push('ambiguous');throw Error('after native entry');};
    const uncertain={request_id:'unknown',text:'please inspect'};
    assert.equal((await a.call('dm_send',uncertain)).state,'unknown');
    a.close();a=f.adapter();
    assert.equal((await a.call('dm_send',uncertain)).state,'unknown');
    assert.equal((await a.call('collab_send',coop)).state,'accepted');
    assert.equal(f.sent.length,3);
    let enter,release;const inside=new Promise(r=>{enter=r;});
    f.profile.getUidByUin=async()=>{enter();await new Promise(r=>{release=r;});return new Map([['202','u_peer']]);};
    const call=a.call('dm_send',{request_id:'race',text:'revoked'});await inside;
    fs.writeFileSync(f.cfg.config,JSON.stringify({enabled:false}));release();
    await assert.rejects(call,/revoked/);assert.equal(f.sent.length,3);
  }finally{a.close();}
});

test('local selection and QQ login are checked before native work',async t=>{
  const f=fixture(t);
  assert.throws(()=>configurePair(f.dir,'101','303'),/existing pair/);
  assert.throws(()=>createAdapter({session:f.session,cfg:f.cfg,self:{uin:'999',uid:'u_other'}}),/Logged-in QQ/);
  const a=f.adapter();
  try{
    await a.refresh(); const info=await a.call('collab_info');assert.equal(info.streamId,f.cfg.generation);
    f.profile.getUidByUin=async()=>new Map([['202','u_replaced']]);
    await assert.rejects(a.call('dm_send',{request_id:'swapped',text:'blocked'}),/identity changed/);
    a.ingest([f.msg(1)]);
    assert.equal((await read(a)).event,null);
    f.profile.getUidByUin=async()=>new Map([['202','u_self']]);
    await assert.rejects(a.call('dm_send',{request_id:'bad',text:'blocked'}),/verify/);
    assert.deepEqual(f.sent,[]);
  }finally{a.close();}
});
