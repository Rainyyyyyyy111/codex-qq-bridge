#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {randomBytes,randomUUID,timingSafeEqual} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {setTimeout:sleep} = require('node:timers/promises');
const {Engine,active} = require('./engine.cjs');
const {nativeClient,request} = require('./transport.cjs');
const {createWorker} = require('./worker.cjs');

class Pulse {
  constructor(){this.version=0;this.listeners=new Set();}
  fire(){this.version++;for(const notify of [...this.listeners])notify();}
  wait(version,ms){
    if(version!==this.version)return Promise.resolve();
    return new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);this.listeners.delete(done);resolve();};
      const timer=setTimeout(done,ms);
      this.listeners.add(done);
    });
  }
}

async function serve(options) {
  const state=options.state;
  const rpc=nativeClient(options),worker=createWorker(options);
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  // A separate SQLite writer lock is released by the OS on process death.
  const lock=new DatabaseSync(path.join(state,'daemon-lock.sqlite'));
  try {lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}
  catch {lock.close();throw Error('The collaboration service already owns this state directory');}
  const endpointFile=path.join(state,'control.json');
  const token=randomBytes(32).toString('hex');
  const pulse=new Pulse(), stop=new AbortController();
  let engine,ready=false,lastError=null,closing=false,transportState=null;
  let activityTail,activityPage;
  const errorText=e=>String(e?.message??e).slice(0,220);
  const warn=e=>{const next=errorText(e);if(next!==lastError)console.error('QQ collaboration: '+next);lastError=next;};
  function health(){return {ready,paired:!!engine,transport:transportState,lastError,processId:process.pid};}
  async function currentPair(){
    try{
      const pair=await rpc('collab_info',{},3500,stop.signal);
      if(!engine){
        engine=new Engine(path.join(state,'rounds.sqlite'),pair);
        engine.recover();engine.expire();
        const db=engine.db;
        const existing=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity'").get();
        engine.txn(()=>{
          db.exec(`CREATE TABLE IF NOT EXISTS activity(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT UNIQUE);
            CREATE TRIGGER IF NOT EXISTS received_activity AFTER UPDATE OF state ON events
              WHEN NEW.dir='in' AND NEW.state='applied' AND OLD.state<>'applied'
              BEGIN INSERT OR IGNORE INTO activity(event) VALUES(NEW.event); END;
            CREATE TRIGGER IF NOT EXISTS inserted_activity AFTER INSERT ON events
              WHEN NEW.dir='in' AND NEW.state='applied'
              BEGIN INSERT OR IGNORE INTO activity(event) VALUES(NEW.event); END;`);
          if(!existing)db.exec("INSERT INTO activity(event) SELECT event FROM events WHERE dir='in' AND state='applied' ORDER BY rowid");
        });
        activityTail=db.prepare('SELECT coalesce(max(cursor),0) AS n FROM activity');
        activityPage=db.prepare(`SELECT a.cursor,e.job_id AS id,e.type,e.observed AS receivedAt
          FROM activity a JOIN events e ON e.event=a.event WHERE a.cursor>? ORDER BY a.cursor LIMIT 32`);
      }
      engine.syncStream(pair);
      transportState={history:pair.history??null,historyDetail:pair.historyDetail??null,pushSubscribed:pair.push??pair.pushSubscribed??null,
        cursor:engine.cursor(),lastInbound:pair.lastInbound??null};
      ready=true;lastError=null;
      return pair.streamId;
    }catch(e){ready=false;if(!closing)warn(e);throw e;}
  }
  async function receiveLoop(){
    let delay=200;
    while(!closing){
      try {
        const wasReady=ready, stream=await currentPair();
        delay=200;if(!wasReady)pulse.fire();
        const page=await rpc('collab_wait',{after:engine.cursor(),timeout_ms:25000},30000,stop.signal);
        if(page.event){if(await currentPair()===stream)engine.consume(page.event);pulse.fire();}
        else if(page.event!==null)throw Error('Invalid native wait response');
        else await sleep(15); // also tolerate adapter reconnects returning an empty wait immediately
      } catch(e){
        if(closing)break;
        ready=false;warn(e);pulse.fire();await sleep(delay);delay=Math.min(5000,delay*2);
      }
    }
  }
  async function sendLoop(){
    while(!closing){
      const version=pulse.version, mail=ready && engine.takeMail();
      if(!mail){await pulse.wait(version,500);continue;}
      try{
        const receipt=await rpc('collab_send',mail,20000,stop.signal);
        engine.sent(mail,receipt?.state);pulse.fire();
      }catch(e){
        if(closing)break;
        // Same request_id goes back to an adapter with a durable reservation.
        engine.sent(mail,'retry');warn(e);pulse.fire();await sleep(100);
      }
    }
  }
  async function workLoop(){
    while(!closing){
      const version=pulse.version, job=ready && engine.claim();
      if(!job){await pulse.wait(version,5000);continue;}
      pulse.fire();
      const method=job.mode==='write' ? {drafting:'plan',reviewing:'contribute',revising:'synthesize',checking:'check'}[job.phase] : {drafting:'draft',reviewing:'review',revising:'revise'}[job.phase];
      try{
        let result;
        for(;;){
          result=await worker[method](job);
          if(closing)return;
          const latest=engine.noteSnapshot(job.id);
          if(method==='draft'||latest.noteIds.join(',')===job.noteIds.join(',')||engine.row(job.id).phase!==job.phase)break;
          // Each participant has two notes. Use a note that arrived during generation before submitting the result.
          Object.assign(job,latest);
        }
        engine.finish(job,result);
      }catch(e){if(!closing){console.error('Collaboration '+method+': '+errorText(e));engine.fail(job);}}
      pulse.fire();
    }
  }
  async function handle(name,args,alive){
    if(name==='health'){try{await currentPair();}catch{}return health();}
    if(!engine)throw Error('QQ pair is unavailable. Check health and the paired QQ listener.');
    if(name==='status')return engine.status(args.id);
    if(name==='listen'){
      const after=args.after??activityTail.get().n, ms=args.timeout_ms??30000;
      if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(ms)||ms<0||ms>300000)throw Error('Invalid listen options');
      const deadline=Date.now()+ms;
      for(;;){
        const version=pulse.version, events=activityPage.all(after);
        if(events.length||Date.now()>=deadline||closing||!alive())return {cursor:events.at(-1)?.cursor??after,events};
        await pulse.wait(version,Math.min(1000,deadline-Date.now()));
      }
    }
    if(name==='wait'){
      if(typeof args.id!=='string')throw Error('wait requires id');
      const ms=args.timeout_ms??30000, after=args.after;
      if(!Number.isInteger(ms)||ms<0||ms>300000||(after!==undefined && (!Number.isInteger(after)||after<0)))throw Error('Invalid wait options');
      const deadline=Date.now()+ms;
      for(;;){
        const version=pulse.version, snapshot=engine.status(args.id);
        if(!active(snapshot.phase)||Date.now()>=deadline||closing||!alive()||
           (after!==undefined && snapshot.events.length>after))return snapshot;
        await pulse.wait(version,Math.min(1000,deadline-Date.now()));
      }
    }
    // A long wait can outlive a local unpair. Recheck the actual account immediately before accepting new work.
    await currentPair();
    if(name==='peer-read'||name==='peer-send'){
      const expected={accountUin:engine.self,peerUin:engine.peer};
      if(name==='peer-read')return rpc('dm_latest',{expected});
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>4000||args.text.startsWith('QQCOLLAB/1')||
         typeof args.request_id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(args.request_id))throw Error('Invalid manual private message');
      return rpc('dm_send',{expected,request_id:args.request_id,text:args.text});
    }
    let id;
    if(name==='write'){
      if((args.lead===undefined)!==(args.assignment===undefined))throw Error('Supply both lead and assignment');
      id=engine.start(args,args.lead===undefined,'write');
    } else if(name==='submit'||name==='start')id=engine.start(args,name==='start');
    else if(name==='note'){id=args.id;engine.note(id,args.text,args.request_id);}
    else throw Error('Unknown collaboration command');
    pulse.fire();return {id,phase:engine.status(id).phase};
  }
  const openSockets=new Set();
  const server=net.createServer(socket=>{
    openSockets.add(socket);socket.on('close',()=>openSockets.delete(socket));socket.on('error',()=>socket.destroy());
    socket.setEncoding('utf8');socket.setTimeout(310000,()=>socket.destroy());
    let buffer='',started=false;
    socket.on('data',async chunk=>{
      if(started)return;buffer+=chunk;if(buffer.length>12000){socket.destroy();return;}
      if(!buffer.includes('\n'))return;started=true;
      try{
        const packet=JSON.parse(buffer);
        const supplied=Buffer.from(typeof packet.token==='string'?packet.token:'');
        if(supplied.length!==token.length||!timingSafeEqual(supplied,Buffer.from(token)))throw Error('Invalid local credential');
        const value=await handle(packet.name,packet.args??{},()=>!socket.destroyed);
        if(!socket.destroyed)socket.end(JSON.stringify({value})+'\n');
      }catch(e){if(!socket.destroyed)socket.end(JSON.stringify({error:errorText(e)})+'\n');}
    });
  });
  const temp=endpointFile+'.'+process.pid;
  let timer,published=false;
  const finish=()=>{if(closing)return;closing=true;stop.abort();pulse.fire();if(server.listening)server.close();for(const s of openSockets)s.destroy();};
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    fs.writeFileSync(temp,JSON.stringify({port:server.address().port,token}),{mode:0o600,flag:'wx'});
    fs.renameSync(temp,endpointFile);published=true;
    timer=setInterval(()=>{if(engine){engine.expire();pulse.fire();}},30000);
    process.once('SIGINT',finish);process.once('SIGTERM',finish);
    await Promise.all([receiveLoop(),sendLoop(),workLoop()]);
  }finally{
    finish();clearInterval(timer);
    try{
      if(published)fs.rmSync(endpointFile,{force:true});
      fs.rmSync(temp,{force:true});
    }finally{
      engine?.close();lock.close();
      process.removeListener('SIGINT',finish);process.removeListener('SIGTERM',finish);
    }
  }
}
async function localCall(state,name,args){
  const {port,token}=JSON.parse(fs.readFileSync(path.join(state,'control.json'),'utf8'));
  if(!Number.isInteger(port)||port<1||port>65535||!/^\w{64}$/.test(token))throw Error('Invalid service endpoint');
  return request({host:'127.0.0.1',port},{token,name,args},['wait','listen'].includes(name)?(args.timeout_ms??30000)+5000:5000);
}
function optionsFrom(argv){
  const [cmd,...rest]=argv, args={};
  const names=['state','socket','bridge-dir','token-file','codex','evidence-file','id','timeout-ms','after'];
  for(let i=0;i<rest.length;i+=2){
    const key=rest[i].slice(2);
    if(!rest[i].startsWith('--')||!names.includes(key)||!rest[i+1]||Object.hasOwn(args,key))throw Error('Invalid CLI options');
    args[key]=rest[i+1];
  }
  if(!args.state)throw Error('Specify --state DIR');
  return {cmd,args};
}
async function main(){
  const {cmd,args}=optionsFrom(process.argv.slice(2)),state=path.resolve(args.state);
  if(cmd==='serve'){
    if(!args.socket)throw Error('Specify --socket bridge.sock or the Windows pipe');
    const opts={state,socket:args.socket,tokenFile:args['token-file']&&path.resolve(args['token-file']),
      codexPath:args.codex,evidenceFile:args['evidence-file']&&path.resolve(args['evidence-file'])};
    if(args['bridge-dir'])process.chdir(path.resolve(args['bridge-dir']));
    return serve(opts);
  }
  let input={};
  if(['submit','start','write','note','peer-send'].includes(cmd)){
    let buf='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin){buf+=chunk;if(buf.length>12000)throw Error('Local request too large');}
    input=JSON.parse(buf);if(!input||Array.isArray(input)||typeof input!=='object')throw Error('Expected JSON object');
  }else if(!['status','wait','listen','health','peer-read'].includes(cmd))throw Error('Unknown collaboration command');
  if(args.id)input.id=args.id;
  if((cmd==='start'||cmd==='submit') && !Object.hasOwn(input,'request_id'))input.id??=randomUUID();
  if(args['timeout-ms'])input.timeout_ms=Number(args['timeout-ms']);
  if(args.after)input.after=Number(args.after);
  const value=await localCall(state,cmd,input);
  process.stdout.write(JSON.stringify(value,null,2)+'\n');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={serve,localCall};
