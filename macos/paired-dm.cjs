'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createDirect, resolvePeer } = require('./direct.cjs');
const { checkedResult, checkArgs, validateText } = require('./native.cjs');

const prefix = 'QQCOLLAB/1\n';
const pageSize = 32;
const digest = value => createHash('sha256').update(value).digest('hex');
function scopedFrame(text, from, to) {
  if (typeof text !== 'string' || text.length > 4000 || !text.startsWith(prefix)) return false;
  try {
    const wire=JSON.parse(text.slice(prefix.length));
    return wire?.from === from && wire?.to === to;
  } catch { return false; }
}
const decimal = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const s = String(value ?? '');
  return /^-?[1-9][0-9]{0,30}$/.test(s) ? s : '';
};

// One writer holds the native profile lock. The event is durable before a waiter wakes.
// A crash between the event, native-ID marker and head writes replays that last commit.
function openJournal(root, accountUin, peerUin, read, write, now) {
  const dir = 'collab-inbox-' + digest(accountUin + '/' + peerUin);
  fs.mkdirSync(path.join(root, dir), { recursive:true, mode:0o700 });
  const key = name => dir + '/' + name;
  let meta = read(key('head.json'));
  if (!meta) {
    meta = { accountUin, peerUin, streamId:randomUUID(), enabledAt:Math.floor(now()/1000), head:0, historySeq:null };
    write(key('head.json'), meta);
  }
  if (meta.accountUin !== accountUin || meta.peerUin !== peerUin || !Number.isSafeInteger(meta.head) || meta.head<0)
    throw Error('Invalid paired inbox binding or cursor');
  function commit(patch) {
    const next = { ...meta, ...patch };
    write(key('head.json'), next);
    meta = next;
  }
  if (meta.streamId === undefined) commit({streamId:randomUUID()});
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.streamId))
    throw Error('Invalid paired inbox stream identity');
  function advance(record) {
    if (record.cursor !== meta.head+1 || !decimal(record.messageId)) throw Error('Invalid paired inbox record');
    write(key('msg-' + record.messageId + '.json'), record.cursor);
    commit({ head:record.cursor });
  }
  function next(after) { return read(key('event-' + (after+1) + '.json')); }
  function recover() {
    for (let record; (record = next(meta.head));) advance(record);
  }
  recover();
  return {
    get meta() { return meta; },
    next(after) {
      if (!Number.isSafeInteger(after) || after<0 || after>meta.head) throw Error('Invalid paired inbox cursor');
      if (after===meta.head) return null;
      const item=next(after);
      if (!item || item.cursor!==after+1) throw Error('Paired inbox record missing');
      return item;
    },
    append(event) {
      recover();
      if (event.time<meta.enabledAt || read(key('msg-' + event.messageId + '.json')) !== undefined) return false;
      const record = { ...event, cursor:meta.head+1 };
      write(key('event-' + record.cursor + '.json'),record);
      advance(record);
      return true;
    },
    checkpoint(seq) { if (meta.historySeq !== seq) commit({historySeq:seq}); },
  };
}

function createPairedDM({root, self, settings, currentSettings, session, callbacks, readJSON, writeJSON,
                         now=Date.now, intervalMs=5000, onDisconnect=()=>{}}) {
  const alias = settings.collaborationContact;
  const peerUin = settings.peers.get(alias);
  function authorize() {
    const current = currentSettings();
    if (!alias || !peerUin || current.collaborationContact !== alias || current.accountUin !== self.uin ||
        current.peers.get(alias) !== peerUin) throw Error('Local cooperation pairing changed');
  }
  authorize();
  const journal = openJournal(root, self.uin, peerUin, readJSON, writeJSON, now);
  const direct = createDirect(session,self,settings,readJSON,writeJSON,authorize);
  const service = session.getMsgService();
  const waiters = new Set();
  let peer, resolving, listener, subscribed=false, timer, syncing, stopped=false, history='starting';
  let lastInbound=null;
  const scope = { accountUin:self.uin, peerUin };
  const samePeer = m => m?.chatType===1 && m.peerUid===peer?.peerUid &&
    (!m.peerUin || String(m.peerUin)==='0' || String(m.peerUin)===peerUin);
  function receive(row,source) {
    if (stopped || !peer || !samePeer(row) || row.senderUid!==peer.peerUid || row.senderUid===self.uid ||
        (row.senderUin && String(row.senderUin)!=='0' && String(row.senderUin)!==peerUin)) return;
    const id = decimal(row.msgId), time=Number(row.msgTime);
    if (!id || !Number.isSafeInteger(time) || time<=0 || !Array.isArray(row.elements) || row.elements.length!==1) return;
    const item = row.elements[0], t=item?.textElement;
    if (item?.elementType!==1 || ![0,'0'].includes(t?.atType) || !scopedFrame(t?.content,peerUin,self.uin)) return;
    authorize();
    if (journal.append({messageId:id, time, text:t.content})) {
      lastInbound={source,nativeTime:time,localTime:now()};
      for (const wake of [...waiters]) wake();
    }
  }
  const push = rows => {
    if (!Array.isArray(rows) || stopped) return;
    try { rows.forEach(row=>receive(row,'push')); }
    catch { history='receive-error'; }
  };
  function attach() {
    if (subscribed || typeof service.addKernelMsgListener!=='function') return;
    try {
      listener=service.addKernelMsgListener(callbacks({onRecvMsg:push,onMsgInfoListUpdate:push,onKickedOffLine:onDisconnect}));
      subscribed=true;
    } catch { /* Reconcile through history if the native build lacks this callback. */ }
  }
  function sorted(rows) {
    return rows.filter(samePeer).map(row => ({row,seq:decimal(row.msgSeq)}))
      .filter(x=>x.seq && !x.seq.startsWith('-')).sort((a,b) => a.seq===b.seq ? 0 : BigInt(a.seq)<BigInt(b.seq) ? -1 : 1);
  }
  async function ensurePeer() {
    if (!peer) {
      if(!resolving) resolving=resolvePeer(session,self,peerUin).finally(()=>{resolving=undefined;});
      const target=await resolving;
      authorize();
      if(stopped)throw Error('Paired inbox stopped');
      peer=target;
    }
    return peer;
  }
  async function syncHistory() {
    authorize();
    await ensurePeer();
    if (stopped) return;
    attach();
    const tail=await service.getAioFirstViewLatestMsgs(peer,pageSize);
    checkedResult('DM latest',tail);
    if (!Array.isArray(tail.msgList)) throw Error('Missing DM history page');
    authorize();
    if (stopped) return;
    const ordered=sorted(tail.msgList);
    let cursor=journal.meta.historySeq;
    const gap=cursor && ordered.length && BigInt(ordered[0].seq)>BigInt(cursor)+1n;
    if (gap && typeof service.getMsgsBySeqAndCount==='function') {
      // Bound each catch-up pass; native callbacks continue to wake clients during pagination.
      for (let n=0;n<8 && BigInt(cursor)+1n < BigInt(ordered[0].seq);n++) {
        let page;
        try {
          page=await service.getMsgsBySeqAndCount(peer,String(BigInt(cursor)+1n),pageSize,false,true);
          checkedResult('DM history range',page);
          if (!Array.isArray(page.msgList)) break;
        } catch { break; } // Process available tail records; retain the durable gap for a later retry.
        authorize();
        if (stopped) return;
        const fresh=sorted(page.msgList).filter(x=>BigInt(x.seq)>BigInt(cursor));
        if (!fresh.length) break;
        fresh.forEach(x=>receive(x.row,'backfill'));
        cursor=fresh.at(-1).seq;
        journal.checkpoint(cursor);
      }
    }
    // Pages without native sequence numbers can still be deduplicated by native ID.
    const sortedRows=[...tail.msgList].sort((a,b)=>{
      const sa=decimal(a?.msgSeq), sb=decimal(b?.msgSeq);
      return sa && sb ? (sa===sb ? 0 : BigInt(sa)<BigInt(sb) ? -1 : 1) : Number(a?.msgTime)-Number(b?.msgTime);
    });
    sortedRows.forEach(row=>receive(row,'backfill'));
    if (ordered.length && (!cursor || BigInt(ordered[0].seq)<=BigInt(cursor)+1n)) {
      const last=ordered.at(-1).seq;
      if (!cursor || BigInt(last)>BigInt(cursor)) journal.checkpoint(last);
      history='current';
    } else history=gap ? 'history-gap' : 'recent-window';
  }
  function sync() {
    if (!syncing && !stopped) syncing=syncHistory().catch(()=>{history='history-unavailable';}).finally(()=>{syncing=undefined;});
    return syncing;
  }
  function start() {
    if (!timer && !stopped) {
      timer=setInterval(sync,intervalMs);
      timer.unref?.();
    }
    return sync();
  }
  function stop() {
    if (stopped) return;
    stopped=true;
    clearInterval(timer);
    if (subscribed) {
      try { service.removeKernelMsgListener(listener); } catch {}
    }
    for (const wake of [...waiters]) wake();
  }
  async function call(name,args,signal) {
    authorize();
    if (stopped) throw Error('Paired inbox stopped');
    if (name==='collab_info') {
      checkArgs(args,[]);
      await ensurePeer();
      if (!subscribed && !['current','recent-window','history-gap'].includes(history)) {
        await sync();
        authorize();
        if (stopped || (!subscribed && !['current','recent-window','history-gap'].includes(history)))
          throw Error('Paired QQ contact resolved but neither push nor private history is ready');
      }
      return {...scope, streamId:journal.meta.streamId,push:subscribed, history, cursor:journal.meta.head,lastInbound};
    }
    if (name==='dm_latest' || name==='dm_send') {
      const sending=name==='dm_send';
      checkArgs(args,sending?['expected','text','request_id']:['expected']);
      if (args.expected?.accountUin!==scope.accountUin || args.expected?.peerUin!==scope.peerUin) throw Error('Manual DM pairing changed');
      if (sending && (typeof args.text!=='string' || args.text.startsWith(prefix))) throw Error('Manual DM must contain ordinary text');
      const input=sending?{contact:alias,text:args.text,request_id:args.request_id}:{contact:alias};
      const result=await direct(sending?'send_dm_text':'read_dm_latest',input,scope);
      if(!sending)authorize();
      return result;
    }
    if (name==='collab_send') {
      checkArgs(args,['text','request_id']);
      validateText(args.text,args.request_id);
      if (!scopedFrame(args.text,self.uin,peerUin)) throw Error('Cooperation envelope does not match the local pair');
      return direct('send_dm_text',{ contact:alias, text:args.text, request_id:'coop-'+digest(args.request_id) },scope);
    }
    if (name!=='collab_wait') throw Error('Unknown paired operation');
    checkArgs(args,['after','timeout_ms']);
    const ms=args.timeout_ms ?? 30000;
    if (!Number.isInteger(ms) || ms<0 || ms>30000) throw Error('Invalid paired wait timeout');
    let event=journal.next(args.after);
    if (!event && ms) {
      await new Promise(resolve=>{
        const wake=()=>{waiters.delete(wake);clearTimeout(timeout);signal?.removeEventListener('abort',wake);resolve();};
        const timeout=setTimeout(wake,ms);
        waiters.add(wake);
        signal?.addEventListener('abort',wake,{once:true});
        if (signal?.aborted) wake();
      });
      authorize();
      if (stopped) throw Error('Paired inbox stopped');
      event=journal.next(args.after);
    }
    return {event};
  }
  return {start, sync, stop, call};
}

module.exports={createPairedDM};
