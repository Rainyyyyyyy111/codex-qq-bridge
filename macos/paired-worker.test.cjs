'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), net=require('node:net'), os=require('node:os'), path=require('node:path');
const {fork} = require('node:child_process');
const {once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {setTimeout:sleep} = require('node:timers/promises');

test('real worker IPC carries paired private frames before group selection and revokes cached clients', {timeout:10000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-coop-'));
  const socket=process.platform==='win32' ? '\\\\.\\pipe\\qq-test-'+randomUUID() : path.join(root,'bridge.sock');
  function rpc(name,args={}) {
    return new Promise((resolve,reject)=>{
      const s=net.connect(socket), chunks=[];
      s.on('error',reject);
      s.setTimeout(3000,()=>s.destroy(Error('RPC timeout')));
      s.once('connect',()=>s.write(JSON.stringify({name,args})+'\n'));
      s.on('data',buf=>chunks.push(buf));
      s.on('end',()=>{
        try {
          const result=JSON.parse(Buffer.concat(chunks).toString());
          if (result.error) reject(Error(result.error)); else resolve(result.value);
        } catch (e) {reject(e);}
      });
    });
  }
  const settings={accountUin:'101',contacts:{windows:'202'},collaborationContact:'windows'};
  const settingsFile=path.join(root,'settings.json');
  fs.writeFileSync(settingsFile,JSON.stringify(settings));
  const child=fork(path.join(__dirname,'worker.cjs'),['serve'],{cwd:root,
    execArgv:['--require',path.join(__dirname,'fixtures','qq-session.cjs')],stdio:['ignore','ignore','pipe','ipc'],
    env:{...process.env,QQ_STATE:root,QQ_BRIDGE_PROFILE:'default',FIXTURE_UIN:'101',FIXTURE_PIPE:socket,FIXTURE_AMBIGUOUS:'1'}});
  let errors='';
  child.stderr.on('data',c=>{errors+=c;});
  t.after(async()=>{
    if (child.exitCode===null && child.signalCode===null) {
      const closed=once(child,'close');child.kill('SIGKILL');await closed;
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  const until=Date.now()+4000;
  for (;;) {
    try {if ((await rpc('collab_info')).push) break;} catch {}
    if (child.exitCode!==null || Date.now()>=until) assert.fail('Fixture worker not ready: '+errors);
    await sleep(20);
  }
  assert.equal((await rpc('status')).ready,false);
  const envelope=(from,to)=>'QQCOLLAB/1\n'+JSON.stringify({id:randomUUID(),event:randomUUID(),
    from,to,at:Date.now(),type:'note',data:{text:'test'}});
  const incoming=envelope('202','101'), wait=rpc('collab_wait',{after:0,timeout_ms:2000});
  const timestamp=Math.floor(Date.now()/1000);
  child.send({op:'fixture-push',row:{chatType:1,peerUid:'u_202',peerUin:'202',senderUid:'u_202',senderUin:'202',
    msgId:'11',msgSeq:'1',msgTime:String(timestamp),elements:[{elementType:1,textElement:{atType:0,content:incoming}}]}});
  assert.deepEqual((await wait).event,{text:incoming,messageId:'11',time:timestamp,cursor:1});
  const outgoing={text:envelope('101','202'),request_id:'same-id'};
  await rpc('collab_send',outgoing);await rpc('collab_send',outgoing);
  delete settings.collaborationContact;fs.writeFileSync(settingsFile,JSON.stringify(settings));
  await assert.rejects(rpc('collab_send',{...outgoing,request_id:'new'}),/pairing changed/);
  await assert.rejects(rpc('collab_wait',{after:0,timeout_ms:0}),/pairing changed/);
  const sent=fs.readFileSync(path.join(root,'test-sends.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(sent,[{from:'101',to:'u_202',text:outgoing.text}]);
  await assert.rejects(rpc('choose_group',{id:'999'}),/Invalid group choice/);
  assert.equal((await rpc('choose_group',{id:'900'})).selected,'900');
  assert.equal((await rpc('status')).ready,true);
});
