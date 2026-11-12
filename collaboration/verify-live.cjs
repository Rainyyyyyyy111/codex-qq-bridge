#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {localCall}=require('./service.cjs');
const task='合成验收。发布规则为两端启动耗时均不超过 150 ms。对照输入作出 GO 或 HOLD 决定，最终答案以决定开头。';
const draft='GO。Windows 测试值为 80 ms，初步建议发布。';
const question='请从本端提供的验收条目找出另一端数值，核对发布规则。';

function summary(round,platform=process.platform) {
  const sent=round.events.find(x=>x.dir==='out'&&x.type==='request');
  function elapsed(type){
    const end=round.events.find(x=>x.dir==='in'&&x.type===type);
    return sent&&end?.observed!=null ? end.observed-sent.at : null;
  }
  const result=round.final;
  return {id:round.id,role:round.role,platform,phase:round.phase,
    sameFixture:round.task===task && round.draft===draft && round.question===question,
    reviewCitesPeerValue:/240\s*ms/i.test(round.review?.evidence??''),
    decisionChanged:/^HOLD\b/i.test(result?.answer?.trim()??'') && /240\s*ms/i.test(result?.answer??'')
      && ['adopted','partial'].includes(result?.disposition),
    finalSha256:result?createHash('sha256').update(JSON.stringify(result)).digest('hex'):null,
    finalEvent:round.finalReceipt?.event??null,revision:round.finalReceipt?.revision??null,
    ownerQueueToPeerAckMs:elapsed('received'),ownerQueueToReviewMs:elapsed('review'),ownerQueueToCloseMs:elapsed('closed')};
}
function compare(receipts) {
  const a=receipts.find(x=>x.role==='owner'),b=receipts.find(x=>x.role==='reviewer');
  const pass=!!a && !!b && a.id===b.id && [a.platform,b.platform].sort().join(',')==='darwin,win32'
    && receipts.every(x=>x.phase==='complete'&&x.sameFixture&&x.reviewCitesPeerValue&&x.decisionChanged)
    && /^[a-f0-9]{64}$/.test(a.finalSha256??'') && a.finalSha256===b.finalSha256
    && /^[a-f0-9-]{36}$/i.test(a.finalEvent??'') && a.finalEvent===b.finalEvent && a.revision===b.revision
    && [a.ownerQueueToPeerAckMs,a.ownerQueueToReviewMs,a.ownerQueueToCloseMs].every(x=>Number.isSafeInteger(x)&&x>=0);
  return {pass,id:a?.id??null,ownerPlatform:a?.platform??null,reviewerPlatform:b?.platform??null,
    queueToPeerReceiptMs:a?.ownerQueueToPeerAckMs??null,queueToBothCompleteMs:a?.ownerQueueToCloseMs??null};
}
function assess(round, platform=process.platform) {
  const own=summary(round,platform), peer=round.peerReceipt;
  const findings={
    ownerComplete:own.role==='owner' && own.phase==='complete',
    reviewedFixture:own.sameFixture && own.reviewCitesPeerValue && own.decisionChanged,
    oneMacOneWindows:[own.platform,peer?.platform].sort().join(',')==='darwin,win32',
    matchingArtifact:!!peer && /^[a-f0-9]{64}$/.test(own.finalSha256??'') &&
      own.finalSha256===peer.finalSha256 && !!own.finalEvent && own.finalEvent===peer.finalEvent &&
      Number.isInteger(own.revision) && own.revision===peer.revision,
    timedRoundTrip:[own.ownerQueueToPeerAckMs,own.ownerQueueToReviewMs,own.ownerQueueToCloseMs]
      .every(ms=>Number.isSafeInteger(ms)&&ms>=0)
  };
  return {pass:Object.values(findings).every(Boolean),id:own.id,phase:own.phase,ownerPlatform:own.platform,
    peerPlatform:peer?.platform??null,checks:findings,finalSha256:own.finalSha256,
    ownerQueueToPeerAckMs:own.ownerQueueToPeerAckMs,ownerQueueToReviewMs:own.ownerQueueToReviewMs,
    ownerQueueToCloseMs:own.ownerQueueToCloseMs};
}
async function main(){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='compare'&&args.length===2){
    const result=compare(args.map(file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))));
    console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1;return;
  }
  if(!['begin','run','inspect','check'].includes(mode)||!args[0]||args.length>2 || (['inspect','check'].includes(mode)&&!args[1])){
    throw Error('Usage: run STATE [UUID] | check STATE UUID | begin STATE [UUID] | inspect STATE UUID | compare OWNER.json REVIEWER.json');
  }
  const state=path.resolve(args[0]),id=args[1]??randomUUID();
  if(mode==='begin'||mode==='run'){
    console.error('Collaboration ID: '+id);
    const status=await localCall(state,'submit',{id,task,draft,question});
    if(mode==='begin'){console.log(JSON.stringify(status,null,2));return;}
  }
  if(mode==='run'||mode==='check'){
    const round=mode==='run' ? await localCall(state,'wait',{id,timeout_ms:180000}) : await localCall(state,'status',{id});
    const result=assess(round);
    console.log(JSON.stringify(result,null,2));
    if(!result.pass)process.exitCode=1;
    return;
  }
  console.log(JSON.stringify(summary(await localCall(state,'status',{id})),null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={summary,compare,assess};
