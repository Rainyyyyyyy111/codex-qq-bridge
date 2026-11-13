'use strict';
const {randomUUID, createHash} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

const {writingLimits} = require('./writing.cjs');
const PREFIX = 'QQCOLLAB/1\n';
const TTL = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UIN = /^[1-9][0-9]{0,19}$/;
function stableEvent(...parts){
  const hex=createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
}
function validRequestKey(key){
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(key))throw Error('Invalid request_id');
  return key;
}
const stages = {draft_needed:'drafting', review_needed:'reviewing', revision_needed:'revising',check_needed:'checking'};
const active = s => !['complete','failed','expired'].includes(s);
const fields = {
  brief:{task:600,lead:writingLimits.lead,assignment:writingLimits.assignment},
  contribution:{passage:writingLimits.passage,evidence:writingLimits.evidence},
  request:{task:600,draft:1000,question:350}, received:{}, review:{finding:650,evidence:650,suggestion:650},
  final:{answer:1500,disposition:100,rationale:600}, closed:{}, amend:{}, note:{text:350}, failed:{reason:160}
};
const extraFields = {final:['revision','noteIds'],closed:['finalEvent'],amend:['finalEvent','notes']};
const validUuid = id => typeof id==='string' && UUID.test(id);
const finalText = d => ({answer:d.answer,disposition:d.disposition,rationale:d.rationale});
const finalHash = saved => createHash('sha256').update(saved,'utf8').digest('hex');
const platforms = new Set(['win32','darwin','linux','freebsd','openbsd','aix','sunos','android','netbsd','haiku','cygwin']);
function validReceipt(value){
  return value && typeof value==='object' && Object.keys(value).length===3 &&
    platforms.has(value.platform) && Number.isInteger(value.revision) && value.revision>=1 && value.revision<=3 &&
    typeof value.finalSha256==='string' && /^[a-f0-9]{64}$/.test(value.finalSha256);
}
function payload(type,data) {
  const spec=typeof type==='string' && Object.hasOwn(fields,type) ? fields[type] : null;
  if (!spec || !data || typeof data!=='object' || Array.isArray(data) ||
      Object.keys(data).length!==Object.keys(spec).length+(extraFields[type]?.length??0)) throw Error('Invalid collaboration fields');
  const out={};
  for(const [key,limit] of Object.entries(spec)){
    const value=data[key];
    if(typeof value!=='string' || !value.trim() || value.length>limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error('Invalid '+type+' field: '+key);
    out[key]=value;
  }
  if(type==='final') {
    if (!['adopted','partial','declined','confirmed'].includes(out.disposition)) throw Error('Invalid peer-review disposition');
    if (!Number.isInteger(data.revision) || data.revision<1 || data.revision>3 ||
        !Array.isArray(data.noteIds) || data.noteIds.length>4 || !data.noteIds.every(validUuid) ||
        new Set(data.noteIds).size!==data.noteIds.length) throw Error('Invalid final revision or note snapshot');
    out.revision=data.revision; out.noteIds=[...data.noteIds];
  }
  if(type==='closed' || type==='amend'){
    if(!validUuid(data.finalEvent))throw Error('Invalid final receipt reference');
    out.finalEvent=data.finalEvent;
  }
  if(type==='amend'){
    if(!Array.isArray(data.notes) || data.notes.length<1 || data.notes.length>2)throw Error('Invalid amendment notes');
    out.notes=data.notes.map(n=>{
      if(!n || Object.keys(n).length!==2 || !validUuid(n.id))throw Error('Invalid amendment note identity');
      return {id:n.id,...payload('note',{text:n.text})};
    });
    if(new Set(out.notes.map(n=>n.id)).size!==out.notes.length)throw Error('Duplicate amendment note');
  }
  return out;
}
function decode(text,self,peer,now,nativeTime) {
  if(typeof text!=='string'||text.length>4000||!text.startsWith(PREFIX)) return null;
  try {
    const m=JSON.parse(text.slice(PREFIX.length));
    if(!m || typeof m.id!=='string'||typeof m.event!=='string'||!UUID.test(m.id)||!UUID.test(m.event)||m.from!==peer||m.to!==self ||
       !Number.isSafeInteger(m.at)||m.at>now+300000||m.at<now-TTL ||
       !Number.isSafeInteger(nativeTime)||nativeTime<1||nativeTime*1000<now-TTL||nativeTime*1000>now+300000) return null;
    // Keep the old closed.data schema on the wire so an older owner can still close the round.
    if(Object.hasOwn(m,'receipt') && (m.type!=='closed' || !validReceipt(m.receipt)))return null;
    return {id:m.id,event:m.event,from:m.from,to:m.to,at:m.at,type:m.type,data:payload(m.type,m.data),
      receipt:m.receipt??null};
  } catch { return null; }
}
class Engine {
  constructor(file, {accountUin:self,peerUin:peer}, clock=Date.now) {
    if(!UIN.test(self)||!UIN.test(peer)||typeof self!=='string'||typeof peer!=='string'||self===peer) throw Error('Invalid QQ pair');
    this.self=self; this.peer=peer; this.clock=clock;
    const db=this.db=new DatabaseSync(file);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS binding(slot INTEGER PRIMARY KEY CHECK(slot=1),self TEXT,peer TEXT,cursor INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, role TEXT, phase TEXT, created INTEGER, updated INTEGER,
          task TEXT,draft TEXT,question TEXT,review TEXT,final TEXT,reason TEXT,source_hash TEXT,peer_received INTEGER);
        CREATE TABLE IF NOT EXISTS events(event TEXT PRIMARY KEY,job_id TEXT,dir TEXT,type TEXT,data TEXT,at INTEGER,
          state TEXT,tries INTEGER DEFAULT 0,next_try INTEGER DEFAULT 0);
        CREATE INDEX IF NOT EXISTS job_events ON events(job_id,dir,type);
        CREATE INDEX IF NOT EXISTS pending_mail ON events(dir,state,next_try);`);
      if (!db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='mode'))
        db.exec("ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'review'");
      db.prepare('INSERT OR IGNORE INTO binding(slot,self,peer) VALUES(1,?,?)').run(self,peer);
      const pair=db.prepare('SELECT self,peer FROM binding WHERE slot=1').get();
      if(pair.self!==self||pair.peer!==peer) throw Error('This state directory belongs to another pair');
      if(!db.prepare('PRAGMA table_info(binding)').all().some(c=>c.name==='stream_id'))db.exec('ALTER TABLE binding ADD COLUMN stream_id TEXT');
      if(!db.prepare('PRAGMA table_info(events)').all().some(c=>c.name==='observed'))db.exec('ALTER TABLE events ADD COLUMN observed INTEGER');
      if(!db.prepare('PRAGMA table_info(events)').all().some(c=>c.name==='receipt'))db.exec('ALTER TABLE events ADD COLUMN receipt TEXT');
    } catch(e) { db.close(); throw e; }
  }
  close(){this.db.close();}
  txn(fn){this.db.exec('BEGIN IMMEDIATE'); try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  cursor(){return this.db.prepare('SELECT cursor FROM binding WHERE slot=1').get().cursor;}
  syncStream(info){
    if(info.accountUin!==this.self || info.peerUin!==this.peer)throw Error('QQ pair changed; original round is suspended');
    if(info.streamId===undefined)return;
    if(typeof info.streamId!=='string'||!info.streamId||info.streamId.length>256)throw Error('Invalid transport stream ID');
    this.db.prepare('UPDATE binding SET cursor=0,stream_id=? WHERE slot=1 AND stream_id IS NOT ?').run(info.streamId,info.streamId);
  }
  row(id){return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);}
  emit(id,type,data,event=randomUUID(),receipt=null){
    const at=this.clock(), clean=payload(type,data);
    if(receipt!==null && (type!=='closed' || !validReceipt(receipt)))throw Error('Invalid final receipt');
    const text=PREFIX+JSON.stringify({id,event,from:this.self,to:this.peer,at,type,data:clean,...(receipt?{receipt}:{})});
    if(text.length>4000) throw Error('Serialized private message exceeds the QQ limit');
    this.db.prepare("INSERT INTO events(event,job_id,dir,type,data,at,state,receipt) VALUES(?,?,'out',?,?,?,'pending',?)")
      .run(event,id,type,JSON.stringify(clean),at,receipt?JSON.stringify(receipt):null);
  }
  setPhase(id,phase){this.db.prepare('UPDATE jobs SET phase=?,updated=? WHERE id=?').run(phase,this.clock(),id);}
  noteSnapshot(id){
    const rows=this.db.prepare("SELECT event,dir,data FROM events WHERE job_id=? AND type='note' AND ((dir='in' AND state='applied') OR dir='out') ORDER BY rowid").all(id);
    return {noteIds:rows.map(r=>r.event),notes:rows.map(r=>(r.dir==='out'?'本端：':'对端：')+JSON.parse(r.data).text)};
  }
  loggedNotes(id){return this.noteSnapshot(id).notes;}
  latestFinal(id,dir){
    const row=this.db.prepare("SELECT event,data FROM events WHERE job_id=? AND dir=? AND type='final' AND (dir='out' OR state='applied') ORDER BY rowid DESC LIMIT 1").get(id,dir);
    if(!row)return null;
    const data=JSON.parse(row.data);
    return {event:row.event,revision:data.revision??1,noteIds:data.noteIds??[],finalSha256:finalHash(JSON.stringify(finalText(data)))};
  }
  start(input, auto=false, mode='review'){
    const key=Object.hasOwn(input,'request_id')?validRequestKey(input.request_id):undefined;
    const id=input.id??(key===undefined?randomUUID():stableEvent('round',this.self,this.peer,key));
    if(typeof id!=='string'||!UUID.test(id)) throw Error('Expected a UUIDv4 collaboration ID');
    const writing=mode==='write';
    const data=writing && !auto ? payload('brief',{task:input.task,lead:input.lead,assignment:input.assignment}) : auto ? {task:payload('request',{task:input.task,draft:'-',question:'-'}).task} :
      payload('request',{task:input.task,draft:input.draft,question:input.question});
    const hash=createHash('sha256').update(JSON.stringify(writing ? {mode,data} : data)).digest('hex');
    return this.txn(()=>{
      const old=this.row(id);
      if(old){if(old.role!=='owner'||old.source_hash!==hash) throw Error('Collaboration ID already in use'); return id;}
      const at=this.clock();
      this.db.prepare("INSERT INTO jobs(id,role,phase,created,updated,task,draft,question,source_hash,mode) VALUES(?,'owner',?,?,?,?,?,?,?,?)")
        .run(id,auto?'draft_needed':'awaiting_review',at,at,data.task,data.draft??data.lead??null,data.question??data.assignment??null,hash,mode);
      if(!auto)this.emit(id,writing?'brief':'request',data);
      return id;
    });
  }
  note(id,text,key){
    return this.txn(()=>{
      const event=key===undefined?randomUUID():stableEvent('note',this.self,this.peer,id,validRequestKey(key));
      const prior=this.db.prepare('SELECT data FROM events WHERE event=?').get(event);
      if(prior){if(JSON.parse(prior.data).text!==text)throw Error('Conflicting note request_id');return;}
      const job=this.row(id);
      if(!job||!active(job.phase)||job.phase==='awaiting_close') throw Error('No open collaboration for a note');
      const count=this.db.prepare("SELECT count(*) n FROM events WHERE job_id=? AND type='note' AND dir='out'").get(id).n;
      if(count>=2)throw Error('Two local notes have already been attached to this round');
      this.emit(id,'note',{text},event);
    });
  }
  consume({cursor,text,time}){
    if(!Number.isSafeInteger(cursor)||cursor<1)throw Error('Invalid transport cursor');
    return this.txn(()=>{
      if(cursor<=this.cursor())return false;
      const m=decode(text,this.self,this.peer,this.clock(),time);
      let changed=false;
      if(m && this.canRecord(m)){
        const inserted=this.db.prepare("INSERT OR IGNORE INTO events(event,job_id,dir,type,data,at,state,observed,receipt) VALUES(?,?,'in',?,?,?,'waiting',?,?)")
          .run(m.event,m.id,m.type,JSON.stringify(m.data),m.at,this.clock(),m.receipt?JSON.stringify(m.receipt):null).changes;
        if(inserted){this.applyWaiting(m.id);changed=true;}
      }
      this.db.prepare('UPDATE binding SET cursor=? WHERE slot=1').run(cursor);
      return changed;
    });
  }
  canRecord(m){
    const job=this.row(m.id);
    if(!job && !['brief','request','note'].includes(m.type))return false;
    if(job && (m.type==='contribution' || m.type==='review') &&
       (job.role!=='owner' || job.phase!=='awaiting_review' || (m.type==='contribution')!==(job.mode==='write')))return false;
    if(job && !active(job.phase)){
      // The owner can reference a note in a final before QQ delivers the original
      // note to the reviewer. Retain its wording later without reopening a job.
      if(m.type!=='note' || job.phase!=='complete' || job.role!=='reviewer' ||
         !this.latestFinal(m.id,'in')?.noteIds.includes(m.event))return false;
    }
    // Only a receipt for the current actual artifact can close or reopen the round.
    if(m.type==='closed'||m.type==='amend'){
      if(job.role!=='owner' || job.phase!=='awaiting_close')return false;
      const current=this.latestFinal(m.id,'out');
      if(current?.event!==m.data.finalEvent)return false;
      if(m.type==='closed'){
        if(!m.receipt)return job.mode==='review'; // Legacy review peers sent only the event ID.
        return m.receipt.revision===current.revision && m.receipt.finalSha256===current.finalSha256 &&
          typeof job.final==='string' && m.receipt.finalSha256===finalHash(job.final);
      }
      if(current.revision>=3 || m.data.notes.some(n=>current.noteIds.includes(n.id) || n.id===m.event))return false;
      const inbound=this.db.prepare("SELECT count(*) n FROM events WHERE job_id=? AND dir='in' AND type='note'").get(m.id).n;
      let extra=0;
      for(const n of m.data.notes){
        const prior=this.db.prepare('SELECT job_id,dir,type,data FROM events WHERE event=?').get(n.id);
        if(!prior)extra++;
        else if(prior.job_id!==m.id || prior.dir!=='in' || prior.type!=='note' || JSON.parse(prior.data).text!==n.text)return false;
      }
      return inbound+extra<=2;
    }
    if(m.type==='final'){
      if(job.role!=='reviewer' || job.phase!=='awaiting_final')return false;
      const prior=this.latestFinal(m.id,'in');
      if(m.data.revision!==(prior?.revision??0)+1)return false;
      if(!prior)return true;
      const amendments=this.db.prepare("SELECT data FROM events WHERE job_id=? AND dir='out' AND type='amend'").all(m.id);
      const previous=amendments.map(row=>JSON.parse(row.data)).find(a=>a.finalEvent===prior.event);
      return !!previous && [...prior.noteIds,...previous.notes.map(n=>n.id)].every(id=>m.data.noteIds.includes(id));
    }
    const n=this.db.prepare("SELECT count(*) n FROM events WHERE job_id=? AND dir='in' AND type=?").get(m.id,m.type).n;
    if(n>=(m.type==='note'?2:1))return false;
    if(!job && m.type==='note'){
      const orphans=this.db.prepare("SELECT count(*) n FROM events WHERE dir='in' AND type='note' AND state='waiting'").get().n;
      if(orphans>=64)return false;
    }
    return true;
  }
  applyWaiting(id){
    // A QQ update may arrive before the request it refers to. Commit the whole batch with its receive cursor.
    const waiting=this.db.prepare("SELECT event,type,data,at FROM events WHERE job_id=? AND dir='in' AND state='waiting' ORDER BY CASE WHEN type IN ('request','brief') THEN 0 ELSE 1 END,rowid").all(id);
    for(const msg of waiting){
      const d=JSON.parse(msg.data),job=this.row(id),now=this.clock();
      let state='applied';
      const opening=msg.type==='request' || msg.type==='brief';
      if(!job && !opening) continue;
      if(opening && !job){
        this.db.prepare("INSERT INTO jobs(id,role,phase,created,updated,task,draft,question,mode) VALUES(?,'reviewer','review_needed',?,?,?,?,?,?)")
          .run(id,now,now,d.task,d.draft??d.lead,d.question??d.assignment,msg.type==='brief'?'write':'review');
        this.emit(id,'received',{});
      } else if(!active(job.phase) && msg.type!=='note')state='ignored';
      else if(msg.type==='received' && job.role==='owner'){
        this.db.prepare('UPDATE jobs SET peer_received=coalesce(peer_received,?) WHERE id=?').run(now,id);
      } else if((msg.type==='review'||msg.type==='contribution') && job.role==='owner' && job.phase==='awaiting_review'){
        this.db.prepare('UPDATE jobs SET review=?,peer_received=coalesce(peer_received,?) WHERE id=?').run(msg.data,now,id);
        this.setPhase(id,'revision_needed');
      } else if(msg.type==='final' && job.role==='reviewer' && job.phase==='awaiting_final'){
        this.db.prepare('UPDATE jobs SET final=? WHERE id=?').run(JSON.stringify(finalText(d)),id);
        this.settleFinal(id,msg.event,d,job.mode==='write'?'required':null);
      } else if(msg.type==='closed' && job.role==='owner' && job.phase==='awaiting_close'){
        this.setPhase(id,'complete');
      } else if(msg.type==='amend'){
        for(const n of d.notes){
          // A correction can overtake its original note over QQ. Both carry the same
          // logical note UUID, so history replay or a later push cannot count it twice.
          this.db.prepare(`INSERT INTO events(event,job_id,dir,type,data,at,state,observed) VALUES(?,?,'in','note',?,?,'applied',?)
            ON CONFLICT(event) DO UPDATE SET state='applied'`).run(n.id,id,JSON.stringify({text:n.text}),msg.at,now);
        }
        this.setPhase(id,'revision_needed');
      } else if(msg.type==='note'){
        const count=this.db.prepare("SELECT count(*) n FROM events WHERE job_id=? AND dir='in' AND type='note' AND state='applied'").get(id).n;
        if(count>=2)state='ignored';
      } else if(msg.type==='failed'){
        this.db.prepare('UPDATE jobs SET reason=? WHERE id=?').run(d.reason,id);
        this.setPhase(id,'failed');
      } else state='ignored';
      this.db.prepare('UPDATE events SET state=? WHERE event=?').run(state,msg.event);
    }
  }
  settleFinal(id,event,{revision,noteIds},check){
    const own=this.db.prepare("SELECT event,data FROM events WHERE job_id=? AND type='note' AND dir='out' ORDER BY rowid").all(id);
    const missing=own.filter(n=>!noteIds.includes(n.event)).map(n=>({id:n.event,text:JSON.parse(n.data).text}));
    // Apply any outstanding note before judging a manuscript that does not include it.
    if(!missing.length && check==='required'){
      this.setPhase(id,'check_needed');
      return;
    }
    if(!missing.length && check?.verdict==='revise'){
      if(revision>=3 || own.length>=2){
        const reason='合稿仍有分歧：'+check.reason.slice(0,145);
        this.db.prepare('UPDATE jobs SET reason=? WHERE id=?').run(reason,id);
        this.setPhase(id,'failed');
        this.emit(id,'failed',{reason});
        return;
      }
      const noteId=randomUUID();
      this.emit(id,'note',{text:check.reason},noteId);
      missing.push({id:noteId,text:check.reason});
    }
    if(missing.length){
      this.emit(id,'amend',{finalEvent:event,notes:missing});
      this.setPhase(id,'awaiting_final');
    } else {
      this.emit(id,'closed',{finalEvent:event},randomUUID(),{
        revision,platform:process.platform,finalSha256:finalHash(this.row(id).final)
      });
      this.setPhase(id,'complete');
    }
  }
  recover(){
    this.txn(()=>{
      for(const [ready,running] of Object.entries(stages))this.db.prepare('UPDATE jobs SET phase=? WHERE phase=?').run(ready,running);
      this.db.prepare("UPDATE events SET state='pending' WHERE dir='out' AND state='sending'").run();
    });
  }
  claim(){
    return this.txn(()=>{
      const job=this.db.prepare("SELECT * FROM jobs WHERE phase IN ('draft_needed','review_needed','revision_needed','check_needed') ORDER BY updated,id LIMIT 1").get();
      if(!job)return null;
      const phase=stages[job.phase];this.setPhase(job.id,phase);
      return {id:job.id,phase,mode:job.mode,task:job.task,draft:job.draft,question:job.question,
        review:job.review?JSON.parse(job.review):null,final:job.final?JSON.parse(job.final):null,...this.noteSnapshot(job.id)};
    });
  }
  finish(job,result){
    return this.txn(()=>{
      if(this.row(job.id)?.phase!==job.phase)return;
      if(job.phase==='drafting'){
        if(job.mode==='write'){
          this.emit(job.id,'brief',{task:job.task,lead:result.lead,assignment:result.assignment});
          this.db.prepare('UPDATE jobs SET draft=?,question=? WHERE id=?').run(result.lead,result.assignment,job.id);
          this.setPhase(job.id,'awaiting_review');
          return;
        }
        const request=payload('request',{task:job.task,draft:result.draft,question:result.question});
        this.emit(job.id,'request',request);
        this.db.prepare('UPDATE jobs SET draft=?,question=? WHERE id=?').run(request.draft,request.question,job.id);
        this.setPhase(job.id,'awaiting_review');
      } else if(job.phase==='reviewing'){
        const type=job.mode==='write'?'contribution':'review';
        const review=payload(type,result);this.emit(job.id,type,review);
        this.db.prepare('UPDATE jobs SET review=? WHERE id=?').run(JSON.stringify(review),job.id);
        this.setPhase(job.id,'awaiting_final');
      } else if(job.phase==='revising'){
        const {noteIds}=this.noteSnapshot(job.id);
        if(!Array.isArray(job.noteIds)||job.noteIds.length!==noteIds.length||job.noteIds.some((value,i)=>value!==noteIds[i])){
          this.setPhase(job.id,'revision_needed');
          return;
        }
        const revision=(this.latestFinal(job.id,'out')?.revision??0)+1;
        this.emit(job.id,'final',{...result,revision,noteIds});
        this.db.prepare('UPDATE jobs SET final=? WHERE id=?').run(JSON.stringify(finalText(result)),job.id);
        this.setPhase(job.id,'awaiting_close');
      } else if(job.phase==='checking'){
        const last=this.latestFinal(job.id,'in');
        if(!['accept','revise'].includes(result.verdict))throw Error('Unknown co-author verdict');
        this.settleFinal(job.id,last.event,last,result);
      } else throw Error('Unexpected work phase');
    });
  }
  fail(job){
    return this.txn(()=>{
      if(this.row(job.id)?.phase!==job.phase)return;
      const reason='本端执行器未能完成此轮，请检查本地运行状态。';
      this.db.prepare("UPDATE jobs SET phase='failed',updated=?,reason=? WHERE id=?").run(this.clock(),reason,job.id);
      if(job.phase!=='drafting')this.emit(job.id,'failed',{reason});
    });
  }
  takeMail(){
    return this.txn(()=>{
      const now=this.clock();
      const row=this.db.prepare(`SELECT e.*,j.phase FROM events e JOIN jobs j ON j.id=e.job_id
        WHERE e.dir='out' AND e.state='pending' AND e.next_try<=? AND e.at>=? AND j.phase<>'expired'
        AND (e.type<>'final' OR (j.phase='awaiting_close' AND e.rowid=(
          SELECT max(f.rowid) FROM events f WHERE f.job_id=j.id AND f.type='final' AND f.dir='out')))
        AND (e.type<>'amend' OR j.phase='awaiting_final')
        AND (j.phase<>'failed' OR e.type='failed') ORDER BY e.rowid LIMIT 1`).get(now,now-TTL);
      if(!row)return null;
      this.db.prepare("UPDATE events SET state='sending',tries=tries+1 WHERE event=?").run(row.event);
      return {request_id:'cc-'+row.event,text:PREFIX+JSON.stringify({id:row.job_id,event:row.event,from:this.self,to:this.peer,
        at:row.at,type:row.type,data:JSON.parse(row.data),...(row.receipt?{receipt:JSON.parse(row.receipt)}:{})})};
    });
  }
  sent(mail,outcome){
    const id=mail.request_id.slice(3);
    const row=this.db.prepare("SELECT tries FROM events WHERE event=? AND dir='out' AND state='sending'").get(id);
    if(!row)return;
    const state=['accepted','confirmed','sent','observed_in_dm'].includes(outcome)?'accepted':outcome==='retry'?'pending':'uncertain';
    this.db.prepare('UPDATE events SET state=?,next_try=? WHERE event=?').run(state,this.clock()+Math.min(30000,250*2**Math.min(row.tries,7)),id);
  }
  expire(){
    const now=this.clock();
    this.txn(()=>{
      this.db.prepare("UPDATE jobs SET phase='expired',updated=? WHERE phase NOT IN ('failed','complete','expired') AND created<?").run(now,now-TTL);
      this.db.prepare("DELETE FROM events WHERE dir='in' AND state='waiting' AND at<?").run(now-TTL);
    });
  }
  writingRevisions(id,role){
    const dir=role==='owner'?'out':'in';
    const finals=this.db.prepare("SELECT event,data FROM events WHERE job_id=? AND dir=? AND type='final' AND (dir='out' OR state='applied') ORDER BY rowid").all(id,dir);
    const feedback=this.db.prepare("SELECT data FROM events WHERE job_id=? AND dir<>? AND type='amend' AND (dir='out' OR state='applied')").all(id,dir)
      .map(row=>JSON.parse(row.data));
    return finals.map(row=>{
      const {revision,answer}=JSON.parse(row.data);
      return {revision,answer,corrections:feedback.find(f=>f.finalEvent===row.event)?.notes.map(n=>n.text)??[]};
    });
  }
  status(id){
    if(!id)return this.db.prepare('SELECT id,role,mode,phase,created,updated FROM jobs ORDER BY created DESC LIMIT 30').all();
    const j=this.row(id);if(!j)throw Error('Unknown collaboration ID');
    const events=this.db.prepare('SELECT dir,type,state,at,observed FROM events WHERE job_id=? ORDER BY rowid').all(id);
    const close=j.role==='owner' && j.phase==='complete' && this.db.prepare(
      "SELECT data,receipt FROM events WHERE job_id=? AND dir='in' AND type='closed' AND state='applied' AND receipt IS NOT NULL"
    ).get(id);
    const writing=j.mode==='write';
    const contribution=j.review?JSON.parse(j.review):null;
    return {id,role:j.role,mode:j.mode,phase:j.phase,
      ...(writing?{writing:{lead:j.draft,assignment:j.question,contribution,revisions:this.writingRevisions(id,j.role)}}:{}),task:j.task,draft:j.draft,question:j.question,review:writing?null:contribution,
      finalReceipt:this.latestFinal(id,j.role==='owner'?'out':'in'),
      peerReceipt:close?{finalEvent:JSON.parse(close.data).finalEvent,...JSON.parse(close.receipt)}:null,
      final:j.final?JSON.parse(j.final):null,reason:j.reason,peerReceivedAt:j.peer_received,notes:this.loggedNotes(id),events};
  }
}
module.exports={Engine,PREFIX,TTL,active,decode};
