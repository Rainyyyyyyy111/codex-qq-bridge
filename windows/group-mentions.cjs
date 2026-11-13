'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomBytes,createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {listen,request,privateDir,replace} = require('./paired-dm.cjs');
const installed = path.join(__dirname,'mention-runtime');
const runtime = fs.existsSync(installed) ? installed : path.join(__dirname,'../macos');
const {createGroup} = require(path.join(runtime,'group.cjs'));
const configPath = data => path.join(path.resolve(data),'group-mentions','binding.json');
const validId = value => typeof value==='string' && /^[1-9]\d{0,19}$/.test(value);

function configuration(data) {
  const file=configPath(data);
  if (!fs.existsSync(file)) return null;
  const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  if (!cfg) return null;
  if (![cfg.account,cfg.group,cfg.owner].every(validId) || cfg.account===cfg.owner || !/^[a-f0-9]{64}$/.test(cfg.token))
    throw Error('Invalid local group mention binding');
  const key=createHash('sha256').update(cfg.token).digest('hex').slice(0,24);
  const endpoint='qq-group-'+key;
  return {...cfg,dir:path.join(path.dirname(file),key),socket:process.platform==='win32' ?
    '\\\\.\\pipe\\'+endpoint : path.join(os.tmpdir(),endpoint+'.sock')};
}
function enable(data,account,group,owner) {
  if (![account,group,owner].every(validId) || account===owner) throw Error('Supply bridge account, group and distinct controller QQ numbers');
  const file=configPath(data);
  privateDir(path.dirname(file));
  const old=configuration(data);
  if (old && (old.account!==account || old.group!==group || old.owner!==owner)) throw Error('Disable the old mention binding first');
  if (!old) replace(file,JSON.stringify({account,group,owner,token:randomBytes(32).toString('hex')}));
  return configuration(data);
}

// The legacy watcher owns login. Its private-only mode never enters this group hook.
async function startMentions({session,callbacks,self,dataDir,onError=e=>console.error('Group mentions:',e.message)}) {
  const cfg=configuration(dataDir);
  if (!cfg) return null;
  if (String(self.uin)!==cfg.account || !self.uid) throw Error('Logged-in account differs from mention binding');
  const current=()=>configuration(dataDir)?.token===cfg.token;
  const wake=path.join(cfg.dir,'mention-wake');
  for (const sub of [wake,path.join(cfg.dir,'outbox')]) fs.mkdirSync(sub,{recursive:true,mode:0o700});
  function read(name) {
    if (name==='owner.json') return current()?{uin:cfg.owner}:undefined;
    const file=path.join(cfg.dir,name);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,'utf8'));
  }
  const group=createGroup(session,{name:cfg.group,id:cfg.group,uin:cfg.account,uid:self.uid},read,
    (name,value)=>replace(path.join(cfg.dir,name),JSON.stringify(value)),
    (seq,id)=>fs.closeSync(fs.openSync(path.join(wake,seq+'_'+id),'a',0o600)),{mentionsOnly:true});
  const native=session.getMsgService();
  let listener,initialized=false,closed=false,refreshing;
  function refresh() {
    if (!refreshing) refreshing=(async()=>{
      if (closed || !current()) return;
      if (!initialized) {
        await group.initialize();
        if (closed || !current()) return;
        const receive=rows=>{try {group.receive(rows);} catch(error) {onError(error);}};
        listener=native.addKernelMsgListener(callbacks({onRecvMsg:receive,onMsgInfoListUpdate:receive}));
        initialized=true;
      }
      await group.sync();
    })().finally(()=>{refreshing=null;});
    return refreshing;
  }
  const ipc=listen(cfg,(name,args)=>{
    if (!initialized || !current()) throw Error('Group mention binding unavailable');
    if (!['trigger_page','reply_to_mention'].includes(name)) throw Error('Unknown group mention operation');
    return group.call(name,args);
  });
  await ipc.ready;
  const ready=refresh().catch(onError);
  const timer=setInterval(()=>refresh().catch(onError),5000);
  timer.unref();
  return {ready,refresh,close(){
    closed=true;clearInterval(timer);
    try {if (initialized) native.removeKernelMsgListener(listener);} finally {ipc.close();}
  }};
}

async function cli([data,cmd,...args]) {
  if (!data || !cmd) throw Error('Usage: group-mentions.cjs DATA enable ACCOUNT GROUP OWNER | disable | dispatch');
  if (cmd==='enable') {enable(data,...args);return;}
  const cfg=configuration(data);
  if (!cfg) throw Error('Group mentions disabled');
  if (cmd==='disable') {replace(configPath(data),'null');return;}
  if (cmd==='rpc') {
    if (cfg.dir!==process.env.QQ_BRIDGE_STATE) throw Error('Mention dispatcher binding changed');
    console.log(JSON.stringify(await request(cfg,args[0],JSON.parse(fs.readFileSync(0,'utf8')))));
    return;
  }
  if (cmd!=='dispatch') throw Error('Unknown group mention command');
  const env={...process.env,QQ_MENTION_ADAPTER:__filename,QQ_MENTION_NODE:process.execPath,QQ_MENTION_DATA:path.resolve(data),
    QQ_BRIDGE_COLLAB_STATE:process.env.QQ_BRIDGE_COLLAB_STATE || path.join(path.resolve(data),'collaboration-work'),
    QQ_MENTION_BINDING:configPath(data),QQ_BRIDGE_STATE:cfg.dir,QQ_BRIDGE_ROUTE:'win',PYTHONUTF8:'1'};
  for (const [name,...params] of [['triggerctl.py','arm'],['mention_dispatch.py','--watch']]) {
    const child=spawnSync(process.env.QQ_MENTION_PYTHON||'python',[path.join(runtime,name),...params],{env,stdio:'inherit'});
    if (child.error) throw child.error;
    if (child.status!==0) throw Error('Group dispatcher exited unsuccessfully');
  }
}
if (require.main===module) cli(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={enable,configuration,startMentions};
