'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Engine,PREFIX,TTL}=require('./engine.cjs');

const input={task:'Determine release readiness',draft:'Release on the local result.',question:'What does the peer know?'};
const review={finding:'One missing validation',evidence:'Mac build fails on arm64',suggestion:'Hold the release and fix the build.'};
const final={answer:'Hold release. Mac build fails on arm64.',disposition:'adopted',rationale:'The peer supplied the missing platform result.'};
function pair(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-rounds-'));
  let now=Date.now();
  const devices={A:['101','202'],B:['202','101']}, sides={};
  function open(side){
    const [accountUin,peerUin]=devices[side];
    return new Engine(path.join(dir,side+'.sqlite'),{accountUin,peerUin},()=>now);
  }
  for(const side of Object.keys(devices))sides[side]=open(side);
  t.after(()=>{Object.values(sides).forEach(e=>e.close());fs.rmSync(dir,{recursive:true,force:true});});
  function relay(from,to){
    const sender=sides[from],receiver=sides[to],mail=sender.takeMail();assert.ok(mail);
    sender.sent(mail,'accepted');const data={cursor:receiver.cursor()+1,text:mail.text,time:Math.floor(now/1000)};
    receiver.consume(data);return {data,type:JSON.parse(mail.text.slice(PREFIX.length)).type};
  }
  return {sides,relay,dir,tick:ms=>{now+=ms;},restart(side){sides[side].close();sides[side]=open(side);sides[side].recover();}};
}

test('a round closes only after the evidence changes the answer and the peer acknowledges the final',t=>{
  const p=pair(t),{A,B}=p.sides,id=A.start(input);
  const {data}=p.relay('A','B');
  assert.equal(B.status(id).phase,'review_needed');
  assert.equal(p.relay('B','A').type,'received');
  assert.ok(A.status(id).peerReceivedAt);
  B.consume({...data,cursor:B.cursor()+1}); // QQ history replay under another native cursor
  assert.equal(B.takeMail(),null);
  const work=B.claim();assert.equal(work.draft,input.draft);
  B.note(id,'QA has an arm64 build log','log-1');B.note(id,'QA has an arm64 build log','log-1');
  assert.throws(()=>B.note(id,'different','log-1'));
  p.relay('B','A');B.finish(work,review);p.relay('B','A');
  const merge=A.claim();assert.deepEqual(merge.review,review);assert.equal(merge.notes.length,1);
  A.finish(merge,final);
  assert.equal(A.status(id).phase,'awaiting_close');
  p.relay('A','B');assert.deepEqual(B.status(id).final,final);
  p.relay('B','A');assert.equal(A.status(id).phase,'complete');assert.equal(B.status(id).phase,'complete');
  assert.equal(B.takeMail(),null);assert.equal(A.takeMail(),null);assert.equal(A.claim(),null);
});

test('local intent retry, in-flight native request, read-only work and scope all survive restart',t=>{
  const p=pair(t),id=p.sides.A.start({...input,request_id:'pair-check'});
  const first=p.sides.A.takeMail();p.restart('A');const {A}=p.sides;
  assert.equal(A.start({...input,request_id:'pair-check'}),id);
  assert.throws(()=>A.start({...input,task:'different',request_id:'pair-check'}));
  const again=A.takeMail();assert.deepEqual(again,first);
  A.sent(again,'unknown');assert.equal(A.takeMail(),null);
  p.sides.B.consume({cursor:1,text:first.text,time:Math.floor(Date.now()/1000)});
  p.sides.B.claim();p.restart('B');assert.equal(p.sides.B.claim().phase,'reviewing');
  assert.throws(()=>new Engine(path.join(p.dir,'A.sqlite'),{accountUin:'101',peerUin:'999'}),/another pair/);
});

test('wrong-scope, stale, malformed and plain chat advance journal cursor without launching work',t=>{
  const p=pair(t),{A,B}=p.sides;A.start(input);const mail=A.takeMail(), original=JSON.parse(mail.text.slice(PREFIX.length));
  for(const [i,text] of ['ordinary DM',PREFIX+'{',PREFIX+JSON.stringify({...original,from:'999'}),
    PREFIX+JSON.stringify({...original,at:Date.now()-TTL-1000}),PREFIX+JSON.stringify({...original,id:[original.id]})].entries()){
    B.consume({cursor:i+1,text,time:Math.floor(Date.now()/1000)});
  }
  assert.equal(B.cursor(),5);assert.equal(B.claim(),null);assert.deepEqual(B.status(),[]);
});

test('note may beat request, and a stale round or repeated final never starts another exchange',t=>{
  const p=pair(t),{A,B}=p.sides,id=A.start(input);A.note(id,'Observe peer build');
  const request=A.takeMail(),note=A.takeMail();
  B.consume({cursor:1,text:note.text,time:Math.floor(Date.now()/1000)});
  assert.equal(B.claim(),null);
  B.consume({cursor:2,text:request.text,time:Math.floor(Date.now()/1000)});
  assert.deepEqual(B.claim().notes,['对端：Observe peer build']);
  p.tick(TTL+10);A.expire();B.expire();assert.equal(B.status(id).phase,'expired');
  assert.equal(B.takeMail(),null);assert.equal(A.takeMail(),null);
});

test('drafting does not publish until a valid bounded draft and review question exist',t=>{
  const {sides:{A}}=pair(t);const id=A.start({task:input.task},true);
  assert.equal(A.takeMail(),null);
  const work=A.claim();assert.equal(work.phase,'drafting');
  assert.throws(()=>A.finish(work,{draft:'x'.repeat(2000),question:'why'}));
  assert.equal(A.takeMail(),null);
  A.finish(work,{draft:input.draft,question:input.question});
  assert.equal(A.status(id).phase,'awaiting_review');
  assert.equal(JSON.parse(A.takeMail().text.slice(PREFIX.length)).data.question,input.question);
});

function mail(sender){
  const m=sender.takeMail();assert.ok(m);sender.sent(m,'accepted');return m;
}
function deliver(receiver,m){
  receiver.consume({cursor:receiver.cursor()+1,text:m.text,time:Math.floor(Date.now()/1000)});
}
const wire=m=>JSON.parse(m.text.slice(PREFIX.length));
function awaitRevision(p){
  const {A,B}=p.sides, id=A.start(input);
  p.relay('A','B');
  p.relay('B','A');
  B.finish(B.claim(),review);
  p.relay('B','A');
  return id;
}
test('late peer corrections ride the amendment ahead of their original notes; exactly three finals cover both corrections',t=>{
  const p=pair(t),id=awaitRevision(p);
  let {A,B}=p.sides;
  A.finish(A.claim(),final);
  const first=mail(A);
  assert.equal(wire(first).data.revision,1);
  B.note(id,'Evidence now reads 80 ms','first');
  const note1=mail(B);
  deliver(B,first);
  assert.equal(B.status(id).phase,'awaiting_final');
  const amend1=mail(B);
  assert.equal(wire(amend1).type,'amend');
  assert.deepEqual(wire(amend1).data.notes,[{id:wire(note1).event,text:'Evidence now reads 80 ms'}]);
  deliver(A,amend1);deliver(A,amend1);deliver(A,note1);
  p.restart('A');A=p.sides.A;
  let work=A.claim();
  assert.deepEqual(work.notes,['对端：Evidence now reads 80 ms']);assert.equal(A.claim(),null);
  A.finish(work,{...final,answer:'80 ms confirmed'});
  const second=mail(A);
  B.note(id,'New observation: 75 ms','second');
  const note2=mail(B);
  deliver(B,second);deliver(B,first);
  assert.equal(wire(second).data.revision,2);
  assert.deepEqual(wire(second).data.noteIds,[wire(note1).event]);
  const amend2=mail(B);
  p.restart('B');B=p.sides.B;
  deliver(A,amend1);deliver(A,note2);deliver(A,amend2);deliver(A,amend2);
  work=A.claim();assert.deepEqual(work.noteIds,[wire(note1).event,wire(note2).event]);
  A.finish(work,{...final,answer:'Release at 75 ms; previous test measured 80 ms.'});
  const third=mail(A);deliver(B,third);deliver(B,second);deliver(B,third);
  assert.equal(wire(third).data.revision,3);
  assert.equal(B.status(id).phase,'complete');
  const close=mail(B);
  assert.equal(wire(close).data.finalEvent,wire(third).event);
  deliver(A,close);deliver(A,close);
  assert.equal(A.status(id).phase,'complete');
  assert.deepEqual(A.status(id).final,B.status(id).final);
  assert.deepEqual(A.status(id).finalReceipt,B.status(id).finalReceipt);
  assert.equal(A.claim(),null);assert.equal(B.claim(),null);
  assert.equal(A.takeMail(),null);assert.equal(B.takeMail(),null);
});

test('a delayed receipt for a different final cannot consume a genuine receipt or report completion',t=>{
  const p=pair(t),id=awaitRevision(p),{A,B}=p.sides;
  A.finish(A.claim(),final);
  const actual=mail(A);deliver(B,actual);
  const ack=mail(B),old=wire(ack);old.event=randomUUID();old.data.finalEvent=randomUUID();
  deliver(A,{text:PREFIX+JSON.stringify(old)});
  assert.equal(A.status(id).phase,'awaiting_close');
  deliver(A,ack);
  assert.equal(A.status(id).phase,'complete');
});

test('an enhanced close proves the exact saved revision and survives either endpoint restarting',t=>{
  const p=pair(t),id=awaitRevision(p),{A,B}=p.sides;
  A.finish(A.claim(),final);
  const artifact=mail(A), finalEvent=wire(artifact).event;
  deliver(B,artifact);
  p.restart('B');
  const ack=mail(p.sides.B), frame=wire(ack);
  const saved=p.sides.B.db.prepare('SELECT final FROM jobs WHERE id=?').get(id).final;
  const digest=createHash('sha256').update(saved,'utf8').digest('hex');
  assert.deepEqual(frame.data,{finalEvent},'legacy decoders require exactly this payload');
  assert.deepEqual(frame.receipt,{revision:1,platform:process.platform,finalSha256:digest});
  assert.equal(p.sides.B.status(id).peerReceipt,null);
  for(const invalid of [
    null, {}, {...frame.receipt,revision:2}, {...frame.receipt,finalSha256:'0'.repeat(64)},
    {...frame.receipt,platform:'unrecognized-platform'},{...frame.receipt,extra:'private'},
  ]){
    // Keep the original event UUID to ensure rejected frames cannot poison a valid replay.
    deliver(A,{text:PREFIX+JSON.stringify({...frame,receipt:invalid})});
    assert.equal(A.status(id).phase,'awaiting_close');
    assert.equal(A.status(id).peerReceipt,null);
  }
  deliver(A,ack);deliver(A,ack);
  p.restart('A');
  assert.equal(p.sides.A.status(id).phase,'complete');
  assert.deepEqual(p.sides.A.status(id).peerReceipt,{finalEvent,...frame.receipt});
  assert.equal(p.sides.A.status(id).events.filter(e=>e.type==='closed').length,1);
});

test('legacy close by final event can finish without recording an enhanced peer proof',t=>{
  const p=pair(t),id=awaitRevision(p),{A,B}=p.sides;
  A.finish(A.claim(),final);deliver(B,mail(A));
  const original=wire(mail(B));
  delete original.receipt;
  deliver(A,{text:PREFIX+JSON.stringify(original)});
  p.restart('A');
  assert.equal(p.sides.A.status(id).phase,'complete');
  assert.equal(p.sides.A.status(id).peerReceipt,null);
});

test('a reviewer storage mismatch is visible to the owner and never closes the owner round',t=>{
  const p=pair(t),id=awaitRevision(p),{A,B}=p.sides;
  A.finish(A.claim(),final);
  // Simulate corruption at persistence time; hashing the incoming wire text would falsely pass.
  B.db.exec("CREATE TRIGGER alter_fixture_final AFTER UPDATE OF final ON jobs BEGIN UPDATE jobs SET final='{}' WHERE id=NEW.id; END");
  deliver(B,mail(A));
  const ack=mail(B);
  assert.equal(wire(ack).receipt.finalSha256,createHash('sha256').update('{}').digest('hex'));
  deliver(A,ack);
  assert.equal(A.status(id).phase,'awaiting_close');
  assert.equal(A.status(id).peerReceipt,null);
});

test('an owner note referenced by the final can arrive after close without reopening the reviewer',t=>{
  const p=pair(t),id=awaitRevision(p),{A,B}=p.sides;
  A.note(id,'Keep the local estimate explicitly labeled','estimate');
  const late=mail(A), snapshot=A.claim();
  A.finish(snapshot,final);
  const artifact=mail(A);
  assert.deepEqual(wire(artifact).data.noteIds,[wire(late).event]);
  deliver(B,artifact);deliver(A,mail(B));
  deliver(B,late);deliver(B,late);
  assert.deepEqual(B.status(id).notes,['对端：Keep the local estimate explicitly labeled']);
  assert.equal(B.status(id).phase,'complete');assert.equal(B.claim(),null);assert.equal(B.takeMail(),null);
});

test('a generation cannot mark a newly arrived note as incorporated without rerunning',t=>{
  const p=pair(t),id=awaitRevision(p),{A,B}=p.sides;
  const stale=A.claim();B.note(id,'A new check','check');p.relay('B','A');
  A.finish(stale,final);
  assert.equal(A.takeMail(),null);
  assert.equal(A.status(id).phase,'revision_needed');
  const fresh=A.claim();assert.equal(fresh.noteIds.length,1);A.finish(fresh,final);
  assert.deepEqual(wire(mail(A)).data.noteIds,fresh.noteIds);
});

test('missing ids are optional only when omitted and explicit invalid idempotency keys never enqueue',t=>{
  const {sides:{A}}=pair(t),id=A.start(input);
  for(const request_id of ['',null,false,0]){
    assert.throws(()=>A.start({...input,id:randomUUID(),request_id}),/request_id/);
    assert.throws(()=>A.note(id,'message',request_id),/request_id/);
  }
  assert.equal(A.status().length,1);assert.deepEqual(A.status(id).notes,[]);
});

test('co-author checks recover after restart and unresolved editorial disagreement stays open until the correction budget is exhausted',t=>{
  const p=pair(t),a=p.sides.A;
  const input={request_id:'coauthor-restart',task:'Decide on a rollout',lead:'Windows is ready.',assignment:'Document the Mac gate.'};
  const id=a.start(input,false,'write');
  assert.throws(()=>a.start({...input,draft:'Windows is ready.',question:'Document the Mac gate.'}),/already in use/);
  p.relay('A','B');p.relay('B','A');
  p.sides.B.finish(p.sides.B.claim(),{passage:'Mac needs more testing.',evidence:'more testing'});
  p.relay('B','A');
  for(let r=1;r<=3;r++){
    a.finish(a.claim(),{...final,answer:'Candidate '+r});
    p.relay('A','B');
    assert.equal(p.sides.B.claim().phase,'checking');
    p.restart('B');
    const b=p.sides.B,job=b.claim();
    assert.equal(job.phase,'checking');assert.equal(job.final.answer,'Candidate '+r);
    b.finish(job,{verdict:'revise',reason:'Restore the Mac gate, version '+r});
    if(r<3){
      assert.equal(p.relay('B','A').type,'note');
      assert.equal(p.relay('B','A').type,'amend');
    }else assert.equal(p.relay('B','A').type,'failed');
  }
  for(const endpoint of [a,p.sides.B]){
    const s=endpoint.status(id);
    assert.equal(s.phase,'failed');assert.match(s.reason,/version 3/);
    assert.equal(s.writing.revisions.length,3);assert.equal(s.peerReceipt,null);
    assert.equal(endpoint.claim(),null);assert.equal(endpoint.takeMail(),null);
  }
});

test('an in-flight co-written final is amended before proofreading against two previously sent corrections',t=>{
  const p=pair(t),{A,B}=p.sides;
  const id=A.start({task:'Write a release note',lead:'Windows is ready.',assignment:'Add Mac.'},false,'write');
  p.relay('A','B');p.relay('B','A');
  B.finish(B.claim(),{passage:'Mac needs testing.',evidence:'testing'});p.relay('B','A');
  A.finish(A.claim(),final);
  B.note(id,'First correction','one');B.note(id,'Second correction','two');
  p.relay('A','B');
  assert.equal(B.claim(),null);assert.equal(B.status(id).phase,'awaiting_final');
  for(const type of ['note','note','amend'])assert.equal(p.relay('B','A').type,type);
  A.finish(A.claim(),final);p.relay('A','B');
  const check=B.claim();assert.equal(check.phase,'checking');
  B.finish(check,{verdict:'accept',reason:'Corrected.'});p.relay('B','A');
  assert.equal(A.status(id).phase,'complete');assert.equal(A.status(id).finalReceipt.revision,2);
});
