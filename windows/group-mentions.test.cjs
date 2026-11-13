'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync,fork}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:pause}=require('node:timers/promises');
const {configuration,enable,startMentions}=require('./group-mentions.cjs');
const {request}=require('./paired-dm.cjs');
const mac=path.join(__dirname,'../macos'), adapter=path.join(__dirname,'group-mentions.cjs');
const python=process.platform==='win32'?'python':'python3';
const prompt=' 写一份周报\n保留第二行';
const plain=content=>({elementType:1,textElement:{atType:0,content}});
function row(seq,owner='303',mentioned=true){
  const elements=mentioned?[{elementType:1,textElement:{atType:2,atNtUid:'u_101',content:'@设备'}},plain(prompt)]:[plain('@设备'+prompt)];
  return {chatType:2,peerUid:'900',peerUin:'900',senderUin:owner,senderUid:'u_'+owner,
    msgSeq:String(seq),msgId:String(10000+seq),msgTime:'1000',elements};
}
async function until(fn,reason){
  const end=Date.now()+12000;
  while(!await fn()){
    if(Date.now()>end)throw Error('Timeout: '+reason);
    await pause(30);
  }
}
for(const route of ['mac','win']) {
  test(route+' group mention creates one chat and sends its final turn back to the original group', {
    skip:route==='mac' && process.platform!=='darwin',timeout:35000
  }, async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-at-')), log=path.join(root,'chats');
    const fixture=path.join(mac,'fixtures','mention-app-server.py');
    let fake=fixture;
    if(process.platform==='win32'){
      fake=path.join(root,'fixture.cmd');
      fs.writeFileSync(fake,'@echo off\r\npython "'+fixture+'"\r\n');
    }
    const env={...process.env,HOME:root,USERPROFILE:root,QQ_MENTION_CODEX:fake,QQ_MENTION_PYTHON:python,
      FIXTURE_TASK_HOME:root,FIXTURE_CHAT_FILE:log,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'};
    const children=[];
    let group,errors='';
    function track(child){
      children.push(child);
      child.stderr?.on('data',buf=>{errors+=buf;});
      return child;
    }
    t.after(async()=>{
      for(const c of children.reverse()){
        if(c.exitCode===null && c.signalCode===null){
          const ended=once(c,'close');c.kill('SIGKILL');await ended;
        }
      }
      group?.close();
      fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
    });
    let push, messages, state, dispatcher;
    if(route==='mac'){
      state=root;
      Object.assign(env,{QQ_STATE:root,QQ_BRIDGE_STATE:root,QQ_BRIDGE_ROUTE:'mac',QQ_BRIDGE_PROFILE:'default',FIXTURE_UIN:'101'});
      fs.mkdirSync(path.join(root,'mention-wake'));
      fs.writeFileSync(path.join(root,'owner.json'),JSON.stringify({uin:'303'}));
      const worker=track(fork(path.join(mac,'worker.cjs'),['serve'],{cwd:root,env,
        execArgv:['--require',path.join(mac,'fixtures','qq-session.cjs')],stdio:['ignore','ignore','pipe','ipc']}));
      await until(()=>fs.existsSync(path.join(root,'mention-start-900.json')),'Mac group ready');
      execFileSync(python,[path.join(mac,'triggerctl.py'),'arm'],{env,cwd:root});
      push=async msg=>{const next=once(worker,'message');worker.send({op:'fixture-push',row:msg});await next;};
      messages=()=>fs.readFileSync(path.join(root,'test-sends.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    }else{
      const cfg=enable(root,'101','900','303');state=cfg.dir;
      const rows=[row(1)],sent=[];let listener;
      const native={getAioFirstViewLatestMsgs:async()=>({result:0,msgList:rows.slice(-1)}),
        getMsgsBySeqAndCount:async(_,s,n)=>({result:0,msgList:rows.filter(m=>+m.msgSeq>=+s).slice(0,n)}),
        addKernelMsgListener:cb=>(listener=cb),removeKernelMsgListener(){},
        sendMsg:async(_,peer,elements)=>{
          assert.equal(peer.chatType,2);assert.equal(elements[0].textElement.atType,0);
          const echo={...row(+rows.at(-1).msgSeq+1,'101'),elements};
          rows.push(echo);listener.onRecvMsg([echo]);
          sent.push({to:peer.peerUid,text:elements[0].textElement.content});return {result:0};
        }};
      group=await startMentions({session:{getMsgService:()=>native},callbacks:x=>x,self:{uin:'101',uid:'u_101'},dataDir:root});
      await group.ready;
      assert.equal((await request(cfg,'trigger_page',{})).owner,'303');
      await assert.rejects(request(cfg,'send_text',{}),/Unknown/);
      dispatcher=track(spawn(process.execPath,[adapter,root,'dispatch'],{env,stdio:['ignore','pipe','pipe']}));
      await once(dispatcher.stdout,'data'); // trigger arm has committed its native baseline.
      push=async m=>{if(!rows.some(r=>r.msgId===m.msgId))rows.push(m);listener.onRecvMsg([m]);};
      messages=()=>sent;
    }
    await push(row(2,'404'));await push(row(3,'303',false));await push(row(4));await push(row(4));
    const marker=path.join(state,'mention-wake','4_10004');
    if(route==='mac'){
      dispatcher=track(spawn(python,[path.join(mac,'mention_dispatch.py')],{cwd:state,env,stdio:['ignore','ignore','pipe']}));
    }
    await until(()=>fs.existsSync(log) && !fs.existsSync(marker),'completed final reply '+errors);
    const replies=messages();
    assert.equal(replies.length,1,errors);assert.equal(replies[0].to,'900');
    assert.equal(replies[0].text,'回复 #4\n已完成：'+prompt);
    assert.equal(fs.readFileSync(log,'utf8'),'created'+os.EOL);
    assert.deepEqual(fs.readdirSync(path.join(state,'mention-wake')),[]);
    if(route==='win'){
      execFileSync(process.execPath,[adapter,root,'disable'],{env});
      assert.equal(configuration(root),null);
      await until(()=>dispatcher.exitCode!==null,'dispatcher exits after revocation');
      await push(row(6));
      assert.deepEqual(fs.readdirSync(path.join(state,'mention-wake')),[]);
    }
  });
}
