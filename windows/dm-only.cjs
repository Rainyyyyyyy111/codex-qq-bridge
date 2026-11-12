'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {readPair,startPairedDm}=require('./paired-dm.cjs');

// Only called by the explicit private-only login mode.
function loginState(dataDir) {
  const pair=readPair(dataDir);
  if (!pair) throw Error('Enable the local QQ pair before private-only login');
  const file=path.join(pair.dir,'dm-only-status.json');
  function mark(phase) {
    const temp=file+'.'+process.pid+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({pid:process.pid,phase,at:Date.now()}),{mode:0o600});
    fs.renameSync(temp,file);
  }
  mark('connecting');
  return {
    accountUin:pair.accountUin,mark,
    start({session,self,callbacks,ready,offline}) {
      mark('verifying-friend');
      // QQ has already authenticated this specific account. Friend/history recovery
      // can continue even when the history service is temporarily offline.
      ready();
      return startPairedDm({session,self,callbacks,dataDir,
        onReady:()=>mark('ready'),onOffline:()=>{mark('offline');offline();},
        onError:()=>mark('friend-or-history-unavailable')});
    }
  };
}
module.exports={loginState};
