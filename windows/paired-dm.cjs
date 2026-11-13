'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {createHash, randomBytes, timingSafeEqual} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');

const prefix = 'QQCOLLAB/1\n';
const pageSize = 32;
const idPattern = /^[1-9]\d{0,19}$/;
const isAccount = value => typeof value==='string' && idPattern.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
function addressed(text, from, to) {
  if (typeof text!=='string' || !text.startsWith(prefix) || text.length>4000) return false;
  try {const frame=JSON.parse(text.slice(prefix.length));return frame?.from===from && frame?.to===to;}
  catch{return false;}
}
function paths(dataDir) {
  const dir = path.join(path.resolve(dataDir),'paired-dm');
  return {dir,config:path.join(dir,'pair.json'),tokenFile:path.join(dir,'ipc.token')};
}
function replace(file, value) {
  const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(tmp,value,{mode:0o600,flag:'wx'});
  try { fs.renameSync(tmp,file); } finally { fs.rmSync(tmp,{force:true}); }
}
function privateDir(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if (process.platform !== 'win32') return;
  const sys = path.join(process.env.SystemRoot,'System32');
  const user = execFileSync(path.join(sys,'whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
  const sid = user.match(/S-1-(?:\d+-)*\d+/i)?.[0];
  if (!sid) throw Error('Cannot determine local user SID');
  execFileSync(path.join(sys,'icacls.exe'),[dir,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],{windowsHide:true,stdio:'pipe'});
}
function readPair(dataDir) {
  const files = paths(dataDir);
  if (!fs.existsSync(files.config)) return null;
  const cfg = JSON.parse(fs.readFileSync(files.config,'utf8'));
  if (cfg.enabled === false) return null;
  if (cfg.enabled!==true || !isAccount(cfg.accountUin) || !isAccount(cfg.peerUin) ||
      cfg.accountUin===cfg.peerUin || !Number.isSafeInteger(cfg.since) || cfg.since<=0 ||
      !/^[a-f0-9]{32}$/.test(cfg.generation)) throw Error('Invalid local DM pairing');
  const token = fs.readFileSync(files.tokenFile,'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid local IPC token');
  const key=digest([files.dir,os.userInfo().username,cfg.generation,token].join('\0')).slice(0,32);
  const socket = process.platform==='win32' ? '\\\\.\\pipe\\qq-collab-'+key : path.join(os.tmpdir(),'qq-collab-'+key+'.sock');
  return {...cfg,...files,socket,token,dbFile:path.join(files.dir,'dm-'+cfg.generation+'.sqlite')};
}
function configurePair(dataDir, accountUin, peerUin) {
  if (!isAccount(accountUin)||!isAccount(peerUin)||accountUin===peerUin) throw Error('Two distinct numeric QQ accounts required');
  const files=paths(dataDir);
  privateDir(files.dir);
  const previous=readPair(dataDir);
  if (previous) {
    if (previous.accountUin===accountUin && previous.peerUin===peerUin) return previous;
    throw Error('Disable the existing pair before selecting another account');
  }
  replace(files.tokenFile,randomBytes(32).toString('hex'));
  replace(files.config,JSON.stringify({enabled:true,accountUin,peerUin,since:Math.floor(Date.now()/1000),generation:randomBytes(16).toString('hex')}));
  return readPair(dataDir);
}
function validNativeId(value) {
  return !(typeof value==='number' && !Number.isSafeInteger(value)) && /^-?[1-9]\d{0,29}$/.test(String(value));
}
function rowFor(raw, self, cfg, peer) {
  if (!raw || raw.chatType!==1 || raw.peerUid!==peer.peerUid ||
      (raw.peerUin && String(raw.peerUin)!=='0' && String(raw.peerUin)!==cfg.peerUin)) return null;
  const own=raw.senderUid===self.uid;
  if (!own && raw.senderUid!==peer.peerUid) return null;
  const expected=own ? cfg.accountUin : cfg.peerUin;
  if (raw.senderUin && String(raw.senderUin)!=='0' && String(raw.senderUin)!==expected) return null;
  const time=Number(raw.msgTime);
  if (!validNativeId(raw.msgId) || !Number.isSafeInteger(time) || time<=0) return null;
  return {id:String(raw.msgId),time,own,raw};
}
function plain(row) {
  const only = row.raw.elements?.length===1 && row.raw.elements[0];
  const value = only?.textElement;
  return only?.elementType===1 && Number(value?.atType??0)===0 && typeof value?.content==='string' ? value.content : null;
}
function checked(result) {
  if (String(result?.result)!=='0' || !Array.isArray(result.msgList)) {
    const err=Error('Native DM history unavailable');
    err.diagnostic='history-result:'+(/^-?\d{1,9}$/.test(String(result?.result)) ? result.result : 'missing')+
      (Array.isArray(result?.msgList) ? ':list' : ':no-list');
    throw err;
  }
  return result.msgList;
}
function createAdapter({session,self,cfg,current,subscribed=()=>false}) {
  if (String(self.uin)!==cfg.accountUin || typeof self.uid!=='string' || !self.uid) throw Error('Logged-in QQ differs from local DM pairing');
  const db=new DatabaseSync(cfg.dbFile);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT UNIQUE NOT NULL,time INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(request_id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity(slot INTEGER PRIMARY KEY CHECK(slot=1),self_uid TEXT NOT NULL,peer_uid TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_buffer(message_id TEXT PRIMARY KEY,time INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TEMP TABLE replay(message_id TEXT PRIMARY KEY,time INTEGER NOT NULL,body TEXT NOT NULL,page INTEGER,ordinal INTEGER);
    CREATE TABLE IF NOT EXISTS sync(slot INTEGER PRIMARY KEY CHECK(slot=1),anchor TEXT NOT NULL);`);
  const insert=db.prepare('INSERT OR IGNORE INTO events(message_id,time,body) VALUES(?,?,?)');
  const next=db.prepare('SELECT cursor,message_id AS messageId,time,body AS text FROM events WHERE cursor>? ORDER BY cursor LIMIT 1');
  const receipts=db.prepare('SELECT hash,state FROM outbox WHERE request_id=?');
  const waiters=new Set();
  const native=session.getMsgService();
  let peer, resolving, syncing, closed=false, bootstrapping=true, historyState='initializing', historyDetail=null;
  const usable=()=>{
    if (closed || !current()) throw Error('DM pairing revoked or changed');
  };
  async function resolvePeer() {
    usable();
    if (!resolving) resolving=(async()=>{
      const result=await session.getProfileService().getUidByUin('FriendsServiceImpl',[cfg.peerUin]);
      const uid=result.get(cfg.peerUin);
      if (typeof uid!=='string' || !/^u_[a-zA-Z0-9_-]+$/.test(uid) || uid===self.uid) {
        peer=null;throw Error('Unable to verify paired QQ friend');
      }
      usable();
      db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?,?)').run(self.uid,uid);
      const pin=db.prepare('SELECT self_uid,peer_uid FROM identity WHERE slot=1').get();
      if (pin.self_uid!==self.uid || pin.peer_uid!==uid) {
        peer=null;throw Error('Paired native QQ identity changed; verify and pair again');
      }
      return peer={chatType:1,peerUid:uid,guildId:''};
    })().finally(()=>{resolving=null;});
    return resolving;
  }
  function content(row) {
    if (!row || row.own || row.time<cfg.since) return null;
    const text=plain(row);
    return addressed(text,cfg.peerUin,cfg.accountUin) ? text : null;
  }
  const hold=db.prepare('INSERT OR IGNORE INTO push_buffer VALUES(?,?,?)');
  function wakeAll() {for (const wake of [...waiters]) wake();}
  function ingest(rows) {
    if (closed || !peer) return;
    let changed=false;
    for (const raw of rows??[]) {
      const row=rowFor(raw,self,cfg,peer);
      const text=content(row);
      if (!text) continue;
      usable();
      if ((bootstrapping ? hold : insert).run(row.id,row.time,text).changes) changed=true;
    }
    if (changed && !bootstrapping) wakeAll();
  }
  const stage=db.prepare('INSERT OR IGNORE INTO replay VALUES(?,?,?,?,?)');
  async function latestRows(target,count) {
    try {return checked(await native.getAioFirstViewLatestMsgs(target,count));}
    catch(initialError) {
      usable();
      if(typeof native.getMsgsIncludeSelf!=='function') throw initialError;
      return checked(await native.getMsgsIncludeSelf(target,'0',count,false));
    }
  }
  function publish(anchor) {
    usable();
    db.exec('BEGIN IMMEDIATE');
    let added;
    try {
      added=db.prepare('INSERT OR IGNORE INTO events(message_id,time,body) SELECT message_id,time,body FROM replay ORDER BY page DESC,ordinal').run().changes;
      added+=db.prepare('INSERT OR IGNORE INTO events(message_id,time,body) SELECT message_id,time,body FROM push_buffer ORDER BY rowid').run().changes;
      db.exec('DELETE FROM push_buffer; DELETE FROM replay');
      if (anchor) db.prepare('INSERT OR REPLACE INTO sync VALUES(1,?)').run(anchor);
      db.exec('COMMIT');
    } catch(err){db.exec('ROLLBACK');throw err;}
    bootstrapping=false;if (added) wakeAll();
  }
  async function refresh() {
    if (syncing) return syncing;
    syncing=(async()=>{
      const target=await resolvePeer();
      const anchor=db.prepare('SELECT anchor FROM sync WHERE slot=1').get()?.anchor;
      let raw=await latestRows(target,pageSize);
      usable();
      const boundaries=new Set();
      let newest, found=!anchor, pageIndex=0;
      while (raw.length) {
        if (raw.length>pageSize) throw Error('Oversize native history page');
        const page=raw.map(m=>rowFor(m,self,cfg,target));
        if (page.some(row=>!row)) {
          const m=raw[page.findIndex(r=>!r)] || {};
          const err=Error('Foreign or invalid native history page');
          // Diagnostic labels expose neither message contents nor native identifiers.
          err.diagnostic=['invalid-row',m.chatType===1?'dm':'non-dm',
            m.peerUid===target.peerUid?'paired-peer':'other-peer',
            !m.peerUin||String(m.peerUin)==='0'||String(m.peerUin)===cfg.peerUin?'peer-account-ok':'other-peer-account',
            m.senderUid===self.uid?'self-sender':m.senderUid===target.peerUid?'peer-sender':'other-sender',
            validNativeId(m.msgId)?'id-ok':'bad-id',Number(m.msgTime)>0?'time-ok':'bad-time'].join(':');
          throw err;
        }
        // Sort per page using QQ time and sequence, preserving opaque string message IDs.
        page.sort((a,b)=>{
          if(a.time!==b.time) return a.time-b.time;
          const seq=x=>/^\d{1,30}$/.test(String(x.raw.msgSeq)) ? BigInt(x.raw.msgSeq) : 0n;
          return Number(seq(a)-seq(b));
        });
        if (!newest) newest=page.at(-1).id;
        const prev=page.findIndex(row=>row.id===anchor);
        if (prev>=0) found=true;
        for (let i=prev>=0 ? prev+1 : 0;i<page.length;i++) {
          const row=page[i], text=content(row);
          if (text) stage.run(row.id,row.time,text,pageIndex,i);
        }
        if (prev>=0 || page[0].time<cfg.since || page.length<pageSize) break;
        if (boundaries.has(page[0].id)) throw Error('Native DM history cursor did not progress');
        boundaries.add(page[0].id);
        const older=checked(await native.getMsgsIncludeSelf(target,page[0].id,pageSize,false));
        usable();
        raw=older;pageIndex++;
      }
      publish(found ? newest : null);
      historyState=found ? 'ready' : 'history-gap';
      historyDetail=found ? null : 'missing-previous-anchor';
    })().catch(err=>{
      historyState='history-unavailable';
      historyDetail=err.diagnostic || (peer ? 'native-history-call-failed' : 'friend-identity-unavailable');
      if (!closed && current()) publish(null); // Deliver verified partial history and buffered push; retain anchor.
      throw err;
    }).finally(()=>{syncing=null;});
    return syncing;
  }
  async function send(args, protocol) {
    const {text,request_id:id}=args;
    if (typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof text!=='string'||!text.trim()||text.length>4000 ||
        (protocol ? !addressed(text,cfg.accountUin,cfg.peerUin) : text.startsWith(prefix))) throw Error('Invalid scoped DM send');
    const hash=digest(text);
    const existing=()=>{
      const r=receipts.get(id); if (r && r.hash!==hash) throw Error('DM request ID already binds different text');
      return r && {requestId:id,state:r.state};
    };
    const old=existing(); if (old) return old;
    const target=await resolvePeer();
    usable();
    const raced=existing(); if (raced) return raced;
    db.prepare("INSERT INTO outbox VALUES(?,?,'unknown')").run(id,hash);
    const item={elementType:1,elementId:'',textElement:{content:text,atType:0,atUid:'',atTinyId:'',atNtUid:''}};
    let result;
    try {result=await native.sendMsg('0',target,[item],new Map());} catch {return {requestId:id,state:'unknown'};}
    if (closed || !current()) return {requestId:id,state:'unknown'};
    const state=String(result?.result)==='0' ? 'accepted' : (result?.result==null ? 'unknown' : 'rejected');
    db.prepare('UPDATE outbox SET state=? WHERE request_id=?').run(state,id);
    return {requestId:id,state};
  }
  async function call(name,args={},signal) {
    usable();
    if ((name==='dm_latest'||name==='dm_send') && Object.hasOwn(args,'expected')) {
      if (args.expected?.accountUin!==cfg.accountUin || args.expected?.peerUin!==cfg.peerUin) throw Error('DM pair differs from expected scope');
    }
    if (name==='collab_info') {
      if (!peer) await resolvePeer();
      return {accountUin:cfg.accountUin,peerUin:cfg.peerUin,streamId:cfg.generation,history:historyState,
        historyDetail,pushSubscribed:subscribed()};
    }
    if (name==='collab_send' || name==='dm_send') return send(args,name==='collab_send');
    if (name==='dm_latest') {
      const target=await resolvePeer();
      const list=await latestRows(target,1);
      usable(); if (!list.length) return {message:null,replyPolicy:'none'};
      const row=list.length===1 && rowFor(list[0],self,cfg,target);
      if (!row) throw Error('Invalid latest DM');
      const body=plain(row);
      return {message:{messageId:row.id,time:row.time,fromSelf:row.own,text:body?.slice(0,4000)??null,
        truncated:(body?.length??0)>4000},replyPolicy:'none'};
    }
    if (name!=='collab_wait' || !Number.isSafeInteger(args.after)||args.after<0 || !Number.isInteger(args.timeout_ms) ||
        args.timeout_ms<0 || args.timeout_ms>30000) throw Error('Invalid DM request');
    const event=next.get(args.after);
    if (event || !args.timeout_ms || signal?.aborted) return {event:event??null};
    if (waiters.size>=16) throw Error('Too many DM waiters');
    await new Promise(resolve=>{
      const wake=()=>{clearTimeout(timer);waiters.delete(wake);signal?.removeEventListener('abort',wake);resolve();};
      const timer=setTimeout(wake,args.timeout_ms);
      waiters.add(wake);signal?.addEventListener('abort',wake,{once:true});
    });
    usable();return {event:next.get(args.after)??null};
  }
  function close() {
    if (closed) return;closed=true;
    for (const wake of [...waiters]) wake();
    db.close();
  }
  return {call,ingest,refresh,close};
}

function listen(cfg,call) {
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});
    const ctl=new AbortController();
    socket.on('close',()=>{sockets.delete(socket);ctl.abort();});
    socket.setTimeout(35000,()=>socket.destroy());
    socket.setEncoding('utf8');
    let input='',handling=false;
    socket.on('data',async chunk=>{
      if (handling) return;
      input+=chunk;
      if (Buffer.byteLength(input)>32768) return socket.destroy();
      const end=input.indexOf('\n');if (end<0) return;
      handling=true;
      try {
        const req=JSON.parse(input.slice(0,end));
        if (typeof req.token!=='string' || !/^[a-f0-9]{64}$/.test(req.token) ||
            !timingSafeEqual(Buffer.from(req.token),Buffer.from(cfg.token))) throw Error('Invalid local token');
        const value=await call(req.name,req.args,ctl.signal);
        if (!socket.destroyed) socket.end(JSON.stringify({value})+'\n');
      } catch (err) {
        if (!socket.destroyed) socket.end(JSON.stringify({error:err.message})+'\n');
      }
    });
  });
  server.maxConnections=32;
  const ready=new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(cfg.socket,()=>{server.removeListener('error',reject);resolve();});
  });
  function close(){for (const s of sockets)s.destroy();server.close();}
  return {ready,close};
}

async function startPairedDm({session,self,callbacks,dataDir,onReady=()=>{},onOffline=()=>{},onError=()=>{}}) {
  const cfg=readPair(dataDir);if (!cfg) return null;
  const current=()=>{
    try {const value=readPair(dataDir);return value?.generation===cfg.generation &&
      value?.accountUin===cfg.accountUin && value?.peerUin===cfg.peerUin && value?.token===cfg.token;}
    catch {return false;}
  };
  let listener,observing=false;
  const adapter=createAdapter({session,self,cfg,current,subscribed:()=>observing});
  const ipc=listen(cfg,adapter.call);
  try {await ipc.ready;} catch(err){adapter.close();throw err;}
  const native=session.getMsgService();
  function receive(rows){try {adapter.ingest(rows);} catch(err){onError(err);}}
  try {listener=native.addKernelMsgListener(callbacks({onRecvMsg:receive,onMsgInfoListUpdate:receive,onKickedOffLine:onOffline}));}
  catch (err) {ipc.close();adapter.close();throw err;}
  observing=true;
  // QT callbacks are the fast path. A periodic sweep catches missed push and outages.
  let notified=false;
  const reconcile=()=>adapter.refresh().then(()=>{if (!notified){notified=true;onReady();}}).catch(onError);
  const ready=reconcile();
  const timer=setInterval(reconcile,15000);timer.unref();
  return {ready,close(){clearInterval(timer);try {native.removeKernelMsgListener(listener);} finally {ipc.close();adapter.close();}}};
}

function request(cfg,name,args,timeout=35000) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect(cfg.socket);
    socket.once('connect',()=>socket.write(JSON.stringify({name,args,token:cfg.token})+'\n'));
    let body='';socket.setEncoding('utf8');
    socket.setTimeout(timeout,()=>socket.destroy(Error('DM request timed out; reuse the same request ID')));
    socket.on('error',reject);
    socket.on('data',s=>{body+=s;if (Buffer.byteLength(body)>65536)socket.destroy(Error('Oversized response'));});
    socket.on('end',()=>{try{const reply=JSON.parse(body);if(reply.error)throw Error(reply.error);resolve(reply.value);}catch(err){reject(err);}});
  });
}

async function cli() {
  const [dataDir,command,...rest]=process.argv.slice(2);
  const files=paths(dataDir);
  if (command==='unpair') {
    const cfg=readPair(dataDir);if (cfg) replace(files.config,JSON.stringify({enabled:false}));
    console.log(JSON.stringify({enabled:false}));return;
  }
  if (command==='pair' && rest.length===1) {
    const state=new DatabaseSync(path.join(dataDir,'target-inbox.sqlite'),{readOnly:true});
    try {rest.unshift(state.prepare('SELECT account FROM binding WHERE slot=1').get()?.account);}
    finally {state.close();}
  }
  const cfg=command==='pair' ? configurePair(dataDir,...rest) : readPair(dataDir);
  if (!cfg) {if (command==='info') {console.log(JSON.stringify({enabled:false}));return;}throw Error('Configure the local DM pair first');}
  if (command==='pair' || command==='info') {
    console.log(JSON.stringify({enabled:true,accountUin:cfg.accountUin,peerUin:cfg.peerUin,socket:cfg.socket,tokenFile:cfg.tokenFile,since:cfg.since}));
    return;
  }
  if (command==='health') {
    try {
      const info=await request(cfg,'collab_info',{},3500);
      console.log(JSON.stringify({friendVerified:info.accountUin===cfg.accountUin && info.peerUin===cfg.peerUin,
        pushSubscribed:info.pushSubscribed===true,history:info.history,historyDetail:info.historyDetail??null}));
    } catch {console.log(JSON.stringify({friendVerified:false}));}
    return;
  }
  if (command==='read') {console.log(JSON.stringify(await request(cfg,'dm_latest',{})));return;}
  if (command==='send') {
    const data=JSON.parse(fs.readFileSync(rest[0] || 0,'utf8').replace(/^\uFEFF/,''));
    console.log(JSON.stringify(await request(cfg,'dm_send',data)));return;
  }
  throw Error('Unknown DM command');
}
module.exports={listen,privateDir,replace,startPairedDm,createAdapter,configurePair,readPair,request,prefix};
if (require.main===module) cli().catch(err=>{console.error(err.message);process.exitCode=1;});
