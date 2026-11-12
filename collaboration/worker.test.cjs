'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createWorker} = require('./worker.cjs');

// Runs as a real subprocess for stdin, schema, encoding, timeout and filesystem checks.
// Its response is deterministic. It never invokes Codex, QQ, a model, or the network.
const fixtureCLI = `
const fs = require('node:fs'), args = process.argv.slice(1);
const value = name => args[args.indexOf(name)+1];
const schema = JSON.parse(fs.readFileSync(value('--output-schema'),'utf8'));
const prompt = fs.readFileSync(0,'utf8');
const data = JSON.parse(prompt.split('\\n\\n').at(-1));
if (process.env.QQ_FIXTURE_WAIT) setTimeout(()=>{},30000);
else {
  let out;
  if (process.env.QQ_FIXTURE_RESPONSE) out = JSON.parse(process.env.QQ_FIXTURE_RESPONSE);
  else if (schema.properties.question)
    out = {draft:'Windows 实测 80 ms，建议全平台预算 100 ms。',question:'Mac 的实测结果是否满足 100 ms？'};
  else if (schema.properties.finding)
    out = {finding:'草稿的统一预算会遗漏 Mac 的冷启动。',evidence:data.localEvidence.trim(),
      suggestion:'按设备给出观测延迟；采用补充说明中的修订方式：'+data.notes.join(' ')};
  else
    out = {answer:'Windows 实测 80 ms。'+data.review.evidence+'；分别报告常态与冷启动。',disposition:'adopted',
      rationale:'此次审阅补充了 Mac 数据。'+data.notes.join(' ')};
  fs.writeFileSync(value('-o'), JSON.stringify(out));
}
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'qq-review-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const workspace = path.join(root,'worker');
  const evidenceFile = path.join(root,'chosen.txt');
  const observation = 'Mac 冷启动实测 240 ms。';
  await fs.writeFile(evidenceFile,observation);
  const invocations = [];
  function worker({response,wait,evidence=true,timeoutMs}={}) {
    return createWorker({
      workspace, evidenceFile:evidence ? evidenceFile : undefined, codexPath:process.execPath,
      timeoutMs, spawnProcess(exe,args,options) {
        invocations.push({exe,args,options});
        const env = {...process.env,QQ_FIXTURE_RESPONSE:response ? JSON.stringify(response) : '',QQ_FIXTURE_WAIT:wait ? '1' : ''};
        return spawn(exe,['-e',fixtureCLI,'--',...args],{...options,env});
      },
    });
  }
  return {workspace,evidenceFile,observation,invocations,worker};
}

const task = '核对两种设备启动延迟，并给出建议。';
const input = {task,draft:'单机草稿',question:'请核对这里的结论。'};
const review = {finding:'缺少观测',evidence:'已观测到独立数据',suggestion:'补充另一端结果'};

test('an independent observation changes a single-device draft and the revision accounts for the review',async t=>{
  const f = await fixture(t);
  const initiator = f.worker({evidence:false}), respondent = f.worker();
  const draft = await initiator.draft({task});
  const peerNote = '保留按设备拆分的结论。';
  const result = await respondent.review({task,...draft,notes:[peerNote]});
  const revision = await initiator.revise({task,...draft,review:result,notes:['注明这是一次采样。']});
  assert.ok(!draft.draft.includes(f.observation));
  assert.equal(result.evidence,f.observation);
  assert.match(result.suggestion,/按设备拆分/);
  assert.equal(revision.disposition,'adopted');
  assert.ok(revision.answer.includes(f.observation));
  assert.match(revision.answer,/Windows 实测 80 ms/);
  assert.match(revision.rationale,/一次采样/);
  assert.notEqual(revision.answer,draft.draft);
  assert.equal(f.invocations.length,3);
  for (const {args,options} of f.invocations) {
    assert.equal(options.shell,false);
    assert.equal(options.windowsHide,true);
    assert.deepEqual(args.slice(0,4),['--no-daemon','-a','never','exec']);
    assert.ok(args.includes('--ephemeral') && args.includes('--ignore-user-config'));
    assert.ok(args.includes('mcp_servers={}') && args.includes('web_search="disabled"'));
    assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
    for (const feature of ['apps','plugins','shell_tool','unified_exec','computer_use','view_image','goals','hooks','multi_agent']) {
      assert.equal(args[args.indexOf(feature)-1],'--disable');
    }
    assert.equal(args.at(-1),'-');
    assert.ok(!args.includes(task) && !args.includes(f.evidenceFile));
  }
  assert.equal(new Set(f.invocations.map(x=>x.options.cwd)).size,3);
  assert.deepEqual(await fs.readdir(f.workspace),[]);
});

test('an invented quotation cannot become peer evidence',async t=>{
  const f = await fixture(t);
  await assert.rejects(f.worker({response:review}).review(input),/must quote/);
  assert.deepEqual(await fs.readdir(f.workspace),[]);
});

test('input and output limits count UTF-16 units and fail before forwarding payloads',async t=>{
  const f = await fixture(t), worker = f.worker();
  await assert.rejects(worker.draft({task:'😀'.repeat(301)}),/field: task/);
  await assert.rejects(worker.review({...input,notes:Array(5).fill('x')}),/notes/);
  assert.equal(f.invocations.length,0);
  await assert.rejects(f.worker({response:{draft:'x'.repeat(1001),question:'ask'}}).draft({task}),/field: draft/);
});

test('reviewed revisions cannot ignore the cited evidence or claim adoption of an unchanged draft',async t=>{
  const f = await fixture(t);
  const revise = response => f.worker({response}).revise({...input,review});
  await assert.rejects(revise({answer:'new',disposition:'adopted',rationale:'没看审阅'}),/cited evidence/);
  await assert.rejects(revise({answer:input.draft,disposition:'partial',rationale:review.evidence}),/revised answer/);
  await assert.rejects(revise({answer:'new',disposition:'wrong',rationale:review.evidence}),/disposition/);
  const rejected = await revise({answer:input.draft,disposition:'declined',rationale:review.evidence+' 与此次实验对象不同'});
  assert.equal(rejected.disposition,'declined');
});

test('private profile paths and credentials fail closed, including in selected local evidence',async t=>{
  const f = await fixture(t);
  for (const secret of ['C:\\Users\\operator\\secret','/Users/operator/private','Bearer abcdefghijklmnop']) {
    await assert.rejects(f.worker().draft({task:secret}),/private path or credential/);
    await assert.rejects(f.worker({response:{draft:secret,question:'ok'}}).draft({task}),/private path or credential/);
  }
  await fs.writeFile(f.evidenceFile,'a'.repeat(8193));
  await assert.rejects(f.worker().review(input),/bounded UTF-8 file/);
  await fs.writeFile(f.evidenceFile,'/Users/operator/private-note.txt');
  await assert.rejects(f.worker().review(input),/private path or credential/);
  // A per-message path is never accepted as a new source of local evidence.
  const peer = f.worker({evidence:false,response:{finding:'some',evidence:'private-note.txt',suggestion:'x'}});
  await assert.rejects(peer.review({...input,evidenceFile:f.evidenceFile}),/must quote/);
});

test('CLI timeout terminates the subprocess and removes the request-specific files',async t=>{
  const f = await fixture(t);
  await assert.rejects(f.worker({wait:true,timeoutMs:250}).draft({task}),/deadline/);
  assert.deepEqual(await fs.readdir(f.workspace),[]);
});
