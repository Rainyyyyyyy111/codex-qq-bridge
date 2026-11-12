'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const net=require('node:net');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {createInterface}=require('node:readline');
const {setTimeout:sleep}=require('node:timers/promises');
const {createPairedDM}=require('../macos/paired-dm.cjs');
const {configurePair,startPairedDm}=require('../windows/paired-dm.cjs');
const {PREFIX}=require('./engine.cjs');
const {summary,assess}=require('./verify-live.cjs');
const execFileAsync=require('node:util').promisify(execFile);

const service=path.join(__dirname,'service.cjs');
const preload=path.join(__dirname,'fixtures','integration-codex.cjs');
const win='101', mac='202';

async function until(check, label, timeout=8000) {
  const end=Date.now()+timeout;
  let lastError;
  while (Date.now()<end) {
    try {
      const value=await check();
      if (value) return value;
    } catch (err) { lastError=err; }
    await sleep(15);
  }
  throw Error('Timed out waiting for '+label+(lastError ? ': '+lastError.message : ''));
}

// This is the Tencent SDK boundary. Both platform adapters, receivers, outboxes, and sidecars are real.
function syntheticQQ() {
  const endpoints=new Map(), frames=[], manual=[];
  const held=new Map();
  let sequence=1;
  function holdNext(type) {
    let release;
    held.set(type,deliver=>{release=deliver;});
    return ()=>{
      assert.equal(typeof release,'function',type+' should have reached the transport');
      release();
      release=null;
    };
  }
  function session(account,peer) {
    const endpoint={rows:[],listener:null};
    endpoints.set(account,endpoint);
    function push(text) {
      const to=endpoints.get(peer);
      const raw={chatType:1,peerUid:'u_'+account,peerUin:account,senderUid:'u_'+account,senderUin:account,
        msgId:String(++sequence),msgSeq:String(sequence),msgTime:Math.floor(Date.now()/1000),
        elements:[{elementType:1,textElement:{atType:0,content:text}}]};
      to.rows.push(raw);
      to.listener?.onRecvMsg([raw]);
      to.listener?.onMsgInfoListUpdate([raw]);
    }
    const msgs={
      addKernelMsgListener(listener){endpoint.listener=listener;return 1;},
      removeKernelMsgListener(){endpoint.listener=null;},
      getAioFirstViewLatestMsgs:async(_peer,n)=>({result:0,msgList:endpoint.rows.slice(-n)}),
      getMsgsIncludeSelf:async()=>({result:0,msgList:[]}),
      async sendMsg(_id,target,elements) {
        assert.equal(target.chatType,1);assert.equal(target.peerUid,'u_'+peer);
        const text=elements[0].textElement.content;
        if (!text.startsWith(PREFIX)) {
          manual.push({from:account,to:peer,text});
          push(text);
          return {result:0};
        }
        const frame=JSON.parse(text.slice(PREFIX.length));
        assert.equal(frame.from,account);assert.equal(frame.to,peer);
        frames.push({...frame,pushed:performance.now()});
        const deliver=()=>{
          push(text);
          // Fresh QQ message ID and repeated wire event: exercises both levels of deduplication.
          if (frame.type==='request') push(text);
        };
        const hold=held.get(frame.type);
        if(hold){held.delete(frame.type);hold(deliver);}
        else deliver();
        return {result:0};
      },
    };
    return {getMsgService:()=>msgs,getProfileService:()=>({
      async getUidByUin(_service,ids){return new Map(ids.map(id=>[id,'u_'+id]));},
    })};
  }
  return {session,frames,manual,holdNext};
}

async function localMacSocket(address, call) {
  const connections=new Set();
  const server=net.createServer(socket=>{
    connections.add(socket);
    const ctl=new AbortController();
    socket.on('error',()=>socket.destroy());
    socket.on('close',()=>{connections.delete(socket);ctl.abort();});
    socket.setEncoding('utf8');
    let buffer='';
    socket.on('data',async function onData(chunk) {
      buffer+=chunk;
      if (!buffer.includes('\n')) return;
      socket.removeListener('data',onData);
      try {
        const {name,args}=JSON.parse(buffer);
        const value=await call(name,args,ctl.signal);
        if (!socket.destroyed) socket.end(JSON.stringify({value})+'\n');
      } catch(err) {
        if (!socket.destroyed) socket.end(JSON.stringify({error:err.message})+'\n');
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
  return ()=>{for(const socket of connections)socket.destroy();server.close();};
}

function command(node,cmd,{input,args=[],timeout=16000}={}) {
  return new Promise((resolve,reject)=>{
    const child=execFile(process.execPath,['--no-warnings',service,cmd,'--state',node.state,...args],
      {timeout,windowsHide:true},(err,stdout,stderr)=>{
        if (err) return reject(Error((stderr || err.message).trim()));
        try {resolve(JSON.parse(stdout));}catch(error){reject(error);}
      });
    child.stdin.on('error',()=>{});
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

async function start(node) {
  const cli=node.realModel ? (process.env.QQ_COLLAB_CODEX || (process.platform==='win32' ? 'codex.exe' : 'codex')) : process.execPath;
  const args=['--no-warnings',...(node.realModel ? [] : ['-r',preload]),service,'serve','--state',node.state,
    '--socket',node.socket,'--codex',cli,'--evidence-file',node.evidence];
  if (node.tokenFile) args.push('--token-file',node.tokenFile);
  const child=spawn(process.execPath,args,{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe'],
    env:{...process.env,QQ_FIXTURE_GATE:node.gate || ''}});
  node.child=child;
  let diagnostic='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',s=>{diagnostic=(diagnostic+s).slice(-2000);});
  node.exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  await until(async()=>{
    if (child.exitCode!==null) throw Error('Service exited: '+diagnostic);
    return (await command(node,'health')).ready;
  },'service health; stderr='+diagnostic);
}

async function stop(node) {
  if (!node.child) return;
  node.child.kill('SIGKILL');
  await node.exited;
  node.child=null;
}

function mcpClient(state) {
  const child=spawn(process.execPath,['--no-warnings',path.join(__dirname,'mcp.cjs'),'--state',state],
    {windowsHide:true,stdio:['pipe','pipe','inherit']});
  const pending=new Map();
  let seq=0;
  const exited=new Promise(resolve=>child.once('close',()=>{
    for (const reply of pending.values()) reply.reject(Error('MCP client closed'));
    pending.clear();
    resolve();
  }));
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
    const packet=JSON.parse(line), reply=pending.get(packet.id);
    if (!reply) return;
    pending.delete(packet.id);
    if (packet.error) reply.reject(Error(packet.error.message));
    else reply.resolve(packet.result);
  });
  function rpc(method,params={}) {
    const id=++seq;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',err=>{
        if (err) {pending.delete(id);reject(err);}
      });
    });
  }
  return {rpc,async tool(name,args) {
    const result=await rpc('tools/call',{name,arguments:args});
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  },async close(){child.kill('SIGKILL');await exited;}};
}

async function setup(t,realModel=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-two-endpoints-'));
  const gate=path.join(root,'release-review');
  const qa={state:path.join(root,'a'),evidence:path.join(root,'windows.txt'),realModel};
  const qb={state:path.join(root,'b'),evidence:path.join(root,'mac.txt'),gate,realModel};
  const aEvidence='Windows 实测启动 80 ms。', bEvidence='Mac 独立实测启动 240 ms。';
  fs.writeFileSync(qa.evidence,aEvidence);
  if (realModel) qb.evidence=path.join(__dirname,'fixtures','live-evidence.txt');
  else fs.writeFileSync(qb.evidence,bEvidence);
  const ww=path.join(root,'w-native'), mm=path.join(root,'m-native');
  fs.mkdirSync(mm,{recursive:true});
  const cfg=configurePair(ww,win,mac);
  qa.socket=cfg.socket;qa.tokenFile=cfg.tokenFile;
  qb.socket=process.platform==='win32' ? '\\\\.\\pipe\\qq-test-'+randomUUID() : '/tmp/qq-test-'+randomUUID()+'.sock';
  const network=syntheticQQ(), sa=network.session(win,mac), sb=network.session(mac,win);
  const settings={accountUin:mac,collaborationContact:'peer',peers:new Map([['peer',win]])};
  const readJSON=key=>{
    const file=path.join(mm,key);
    if(fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,'utf8'));
  };
  const writeJSON=(key,value)=>{
    const file=path.join(mm,key);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file+'.tmp',JSON.stringify(value));
    fs.renameSync(file+'.tmp',file);
  };
  const b=createPairedDM({root:mm,self:{uin:mac,uid:'u_'+mac},settings,currentSettings:()=>settings,
    session:sb,callbacks:x=>x,readJSON,writeJSON,intervalMs:60000});
  let w, closeSocket;
  t.after(async()=>{
    fs.writeFileSync(gate,'open');
    await Promise.all([stop(qa),stop(qb)]);
    w?.close();b.stop();closeSocket?.();
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  closeSocket=await localMacSocket(qb.socket,b.call);
  w=await startPairedDm({session:sa,self:{uin:win,uid:'u_'+win},callbacks:x=>x,dataDir:ww});
  await Promise.all([w.ready,b.start()]);
  await Promise.all([start(qa),start(qb)]);
  return {qa,qb,network,gate,aEvidence,bEvidence};
}

test('two sidecars cooperate over paired native DMs, recover an offline reviewer result, and reverse roles', {timeout:55000},async t=>{
  const {qa,qb,network,gate,aEvidence,bEvidence}=await setup(t);
  const task='对比两台设备的实测结果。';
  const id=randomUUID(), draft=aEvidence+' 估计两端均在 100 ms 以内。';
  await command(qa,'submit',{input:{id,task,draft,question:'Mac 的测量值是多少？'}});
  const frames=type=>network.frames.filter(m=>m.type===type && m.id===id);
  const ack=await until(()=>frames('received')[0],'peer durable acknowledgement');
  assert.equal(frames('review').length,0,'receipt should not wait for model generation');
  t.diagnostic('synthetic native request push → peer ACK push ('+win+' → '+mac+', model held): '+
    (ack.pushed-frames('request')[0].pushed).toFixed(1)+' ms');
  await until(async()=>(await command(qa,'status',{args:['--id',id]})).peerReceivedAt,'owner received acknowledgement');
  const note='注明这是冷启动采样。';
  await command(qb,'note',{input:{id,text:note}});
  await until(async()=>(await command(qa,'status',{args:['--id',id]})).notes.includes('对端：'+note),'incoming note');
  await stop(qa);
  fs.writeFileSync(gate,'open');
  await until(()=>frames('review').length===1,'review delivered to offline owner native queue');
  await start(qa);
  const wait=(node,key)=>command(node,'wait',{args:['--id',key,'--timeout-ms','12000']});
  const [owner,reviewer]=await Promise.all([wait(qa,id),wait(qb,id)]);
  assert.equal(owner.phase,'complete');assert.equal(reviewer.phase,'complete');
  assert.equal(owner.role,'owner');assert.equal(reviewer.role,'reviewer');
  assert.equal(owner.review.evidence,bEvidence);assert.deepEqual(owner.final,reviewer.final);
  assert.equal(owner.peerReceipt.finalSha256,summary(reviewer).finalSha256);
  assert.equal(owner.peerReceipt.finalEvent,reviewer.finalReceipt.event);
  assert.equal(owner.peerReceipt.platform,process.platform);
  assert.equal(owner.final.disposition,'adopted');
  assert.ok(!draft.includes(bEvidence) && owner.final.answer.includes(bEvidence));
  assert.ok(owner.final.answer.includes(aEvidence));
  assert.ok(owner.final.rationale.includes(note));
  for(const type of ['request','received','review','final','closed']) assert.equal(frames(type).length,1,type);

  const reverse=randomUUID();
  await command(qb,'start',{input:{id:reverse,task}});
  const [bOwner,aReviewer]=await Promise.all([wait(qb,reverse),until(async()=>{
    const status=await command(qa,'status',{args:['--id',reverse]});
    return status.phase==='complete' && status;
  },'reverse reviewer complete')]);
  assert.equal(bOwner.phase,'complete');assert.equal(aReviewer.phase,'complete');
  assert.equal(bOwner.review.evidence,aEvidence);assert.equal(bOwner.role,'owner');
  assert.ok(!bOwner.draft.includes(aEvidence) && bOwner.final.answer.includes(aEvidence));
  assert.ok(bOwner.final.answer.includes(bEvidence));
  assert.deepEqual(bOwner.final,aReviewer.final);
  assert.equal(bOwner.peerReceipt.finalSha256,summary(aReviewer).finalSha256);

  // Fixed payload, warm services, one request-to-ACK at a time. Keep the model behind the gate.
  const mcp=mcpClient(qa.state);
  t.after(()=>mcp.close());
  const hello=await mcp.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
  assert.ok(hello.capabilities.tools);
  const list=await mcp.rpc('tools/list');
  assert.ok(list.tools.some(tool=>tool.name==='collab_wait'));
  fs.rmSync(gate);
  const ackSamples=[], visibleSamples=[], ids=[];
  for(let i=0;i<20;i++) {
    const startArgs={request_id:'repeat-'+i,task,draft,question:'Mac 的测量值是多少？'};
    const submitted=await mcp.tool('collab_start',startArgs);
    const visible=await mcp.tool('collab_wait',{id:submitted.id,after:1,timeout_ms:5000});
    const visibleAt=performance.now();
    assert.ok(visible.peerReceivedAt);
    if(i===0) assert.equal((await mcp.tool('collab_start',startArgs)).id,submitted.id);
    const observed=network.frames.find(m=>m.id===submitted.id && m.type==='received');
    const pushed=network.frames.find(m=>m.id===submitted.id && m.type==='request');
    ackSamples.push(observed.pushed-pushed.pushed);
    visibleSamples.push(visibleAt-pushed.pushed);
    ids.push(submitted.id);
  }
  assert.equal(network.frames.filter(m=>ids.includes(m.id) && m.type==='review').length,0);
  fs.writeFileSync(gate,'open');
  const finals=await Promise.all(ids.map(id=>mcp.tool('collab_wait',{id,timeout_ms:30000})));
  assert.ok(finals.every(s=>s.phase==='complete' && s.final.answer.includes(bEvidence)));
  function percentiles(samples) {
    samples.sort((a,b)=>a-b);
    const at=p=>samples[Math.ceil(samples.length*p)-1].toFixed(1);
    return 'p50='+at(.5)+' ms, p95='+at(.95)+' ms';
  }
  t.diagnostic('20 warm runs, model gated; synthetic request delivery immediately before peer SDK callback → '+
    'peer native ACK send: '+percentiles(ackSamples)+'; same start → owner MCP wait returned peerReceivedAt: '+
    percentiles(visibleSamples));
});

test('an in-flight correction causes a second final before either peer closes the collaboration',{timeout:30000},async t=>{
  const {qa,qb,gate,network,aEvidence}=await setup(t);
  fs.writeFileSync(gate,'open');
  const releaseReview=network.holdNext('review');
  const releaseNote=network.holdNext('note');
  const releaseAmendment=network.holdNext('amend');
  const id=randomUUID(), note='更正：报告中的 240 ms 是首次冷启动，请明确这一条件。';
  const frames=type=>network.frames.filter(m=>m.type===type && m.id===id);
  await command(qa,'submit',{input:{id,task:'复核设备数据。',draft:aEvidence,question:'对端的测量值是多少？'}});
  await until(()=>frames('review').length,'review complete before the correction is submitted');
  const reviewer=mcpClient(qb.state);
  t.after(()=>reviewer.close());
  const noteArgs={id,text:note,request_id:'late-correction'};
  await reviewer.tool('collab_note',noteArgs);
  await reviewer.tool('collab_note',noteArgs);
  const sentNote=await until(()=>frames('note')[0],'held correction');
  releaseReview();
  const amend=await until(()=>frames('amend')[0],'reviewer requests a new final');
  const first=frames('final')[0];
  assert.equal(first.data.revision,1);
  assert.deepEqual(first.data.noteIds,[]);
  assert.ok(!first.data.rationale.includes(note));
  assert.equal(amend.data.finalEvent,first.event);
  assert.deepEqual(amend.data.notes,[{id:sentNote.event,text:note}]);
  assert.equal(frames('closed').length,0);
  assert.equal((await command(qb,'status',{args:['--id',id]})).phase,'awaiting_final');
  releaseAmendment();
  const second=await until(()=>frames('final')[1],'revised final from embedded amendment, before original note delivery');
  assert.equal(second.data.revision,2);
  assert.deepEqual(second.data.noteIds,[sentNote.event]);
  assert.ok(second.data.rationale.includes(note));
  releaseNote();
  const close=await until(()=>frames('closed')[0],'receipt for second final');
  assert.equal(close.data.finalEvent,second.event);
  const [a,b]=await Promise.all([qa,qb].map(node=>command(node,'wait',{args:['--id',id,'--timeout-ms','8000']})));
  assert.equal(a.phase,'complete');assert.equal(b.phase,'complete');
  assert.deepEqual(a.final,b.final);
  assert.ok(a.final.rationale.includes(note));
  assert.deepEqual(a.notes,['对端：'+note]);assert.deepEqual(b.notes,['本端：'+note]);
  assert.equal(frames('note').length,1);assert.equal(frames('amend').length,1);assert.equal(frames('final').length,2);
  assert.equal(a.events.filter(e=>e.dir==='in' && e.type==='note').length,1);
});

test('paired devices exchange ordinary text over two stdio MCP servers without creating collaboration jobs',async t=>{
  const {qa,qb,network}=await setup(t);
  const a=mcpClient(qa.state), b=mcpClient(qb.state);
  t.after(()=>Promise.all([a.close(),b.close()]));
  for (const client of [a,b]) {
    const list=await client.rpc('tools/list');
    assert.ok(['peer_send_text','peer_read_latest'].every(name=>list.tools.some(tool=>tool.name===name)));
    assert.equal((await client.tool('peer_read_latest',{})).message,null);
  }
  async function exchange(sender,receiver,text) {
    // Same request ID on both devices tests local sender scope as well as retry idempotence.
    const args={text,request_id:'ordinary-message-1'};
    const first=await sender.tool('peer_send_text',args);
    assert.equal(first.state,'accepted');
    assert.deepEqual(await sender.tool('peer_send_text',args),first);
    await assert.rejects(sender.tool('peer_send_text',{...args,text:text+' changed'}));
    const delivery=await receiver.tool('peer_read_latest',{});
    assert.equal(delivery.replyPolicy,'none');
    assert.equal(delivery.message.fromSelf,false);
    const receivedText=delivery.message.text ?? delivery.message.elements.join('');
    assert.equal(receivedText,text);
    assert.deepEqual(await receiver.tool('peer_read_latest',{}),delivery);
  }
  const first='/task mac 这是普通私聊原文，不建聊天。', reply='Windows，这条私聊已收到。';
  await exchange(a,b,first);
  await exchange(b,a,reply);
  assert.deepEqual(network.manual,[{from:win,to:mac,text:first},{from:mac,to:win,text:reply}]);
  assert.deepEqual(network.frames,[]);
  for (const client of [a,b]) assert.deepEqual(await client.tool('collab_status',{}),[]);
});

test('opt-in paid model rehearsal revises GO to HOLD through both services and synthetic QQ', {
  skip:process.env.QQ_COLLAB_REAL_MODEL!=='1',timeout:275000,
},async t=>{
  const {qa,qb,network}=await setup(t,true);
  // Share only the verify-live fixture. This rehearsal uses synthetic QQ, even when real accounts are available.
  const {stdout}=await execFileAsync(process.execPath,['--no-warnings',path.join(__dirname,'verify-live.cjs'),
    'begin',qa.state],{windowsHide:true});
  const {id}=JSON.parse(stdout);
  await until(()=>network.frames.find(f=>f.id===id && f.type==='received'),'initial peer acknowledgement');
  const wait=node=>command(node,'wait',{args:['--id',id,'--timeout-ms','250000'],timeout:255000});
  const [a,b]=await Promise.all([wait(qa),wait(qb)]);
  const owner=summary(a), reviewer=summary(b);
  for(const s of [owner,reviewer]){
    assert.equal(s.phase,'complete',JSON.stringify({phase:s.phase,reason:s.role==='owner'?a.reason:b.reason}));
    assert.ok(s.sameFixture && s.reviewCitesPeerValue && s.decisionChanged);
  }
  assert.equal(owner.finalSha256,reviewer.finalSha256);
  assert.equal(a.peerReceipt?.finalSha256,reviewer.finalSha256);
  const audited=assess(a);
  assert.ok(audited.checks.matchingArtifact && audited.checks.reviewedFixture);
  assert.equal(audited.checks.oneMacOneWindows,false,'two processes on this host do not prove a real Mac/Windows round');
  const types=network.frames.filter(f=>f.id===id).map(f=>f.type);
  assert.deepEqual(types,['request','received','review','final','closed']);
  t.diagnostic(JSON.stringify({transport:'synthetic QQ',model:'real local Codex CLI',sourceDecision:'GO',
    finalDecision:'HOLD',reviewerQuoted240ms:owner.reviewCitesPeerValue,disposition:a.final.disposition,
    events:types,queueToPeerAckMs:owner.ownerQueueToPeerAckMs,queueToReviewMs:owner.ownerQueueToReviewMs,
    queueToBothCompleteMs:owner.ownerQueueToCloseMs,matchingFinalSHA256:owner.finalSha256}));
});
