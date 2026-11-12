'use strict';
const net = require('node:net');
const fs = require('node:fs');

function request(address, envelope, timeoutMs=5000, signal) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(typeof address==='string'?{path:address}:address);
    let data='', done=false;
    function finish(error, value){
      if(done)return;done=true;
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      socket.destroy();
      if(error)reject(error);else resolve(value);
    }
    const abort=()=>finish(Error('Request cancelled'));
    const timer=setTimeout(()=>finish(Error('Local RPC timed out')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    socket.setEncoding('utf8');
    socket.on('error',e=>finish(e));
    socket.on('connect',()=>socket.write(JSON.stringify(envelope)+'\n'));
    socket.on('data',chunk=>{
      data+=chunk;if(data.length>200000) return finish(Error('Oversized local reply'));
      if(data.includes('\n'))parse();
    });
    function parse(){
      try{
        const reply=JSON.parse(data);
        if(reply.error)throw Error(String(reply.error));
        if(!Object.hasOwn(reply,'value'))throw Error('Invalid local reply');
        finish(null,reply.value);
      }catch(e){finish(e);}
    }
    socket.on('close',()=>{if(!done)parse();});
  });
}
function nativeClient({socket,tokenFile}){
  return (name,args={},timeout=5000,signal)=>{
    const envelope={name,args};
    if(tokenFile){const token=fs.readFileSync(tokenFile,'utf8').trim();
      if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid local QQ transport credential');
      envelope.token=token;
    }
    return request(socket,envelope,timeout,signal);
  };
}
module.exports={request,nativeClient};
