'use strict';
// Test-only preload for the two service processes. Even a broken test cannot invoke a paid model.
const cp = require('node:child_process');
const fs = require('node:fs');
const {setTimeout:sleep} = require('node:timers/promises');

if (require.main!==module) {
  const spawn = cp.spawn;
  cp.spawn = (binary,args,options) => {
    if (binary!==process.execPath || args[0]!=='--no-daemon') throw Error('Unexpected service subprocess in offline test');
    return spawn(process.execPath,[__filename,...args],options);
  };
} else {
  run().catch(err=>{console.error(err.message);process.exitCode=1;});
}

async function run() {
  const args=process.argv.slice(2);
  const argument=key=>args[args.indexOf(key)+1];
  const {properties}=JSON.parse(fs.readFileSync(argument('--output-schema'),'utf8'));
  const data=JSON.parse(fs.readFileSync(0,'utf8').split('\n\n').at(-1));
  let result;
  if (properties.verdict) {
    const wrong=data.answer.includes('合计 0 ms');
    result={verdict:wrong?'revise':'accept',reason:wrong?'请修正结尾：总计必须使用两个串行阶段之和。':'总计与两个阶段相符。'};
  } else if (properties.assignment) {
    result={lead:data.localEvidence.trim(),assignment:'补入另一段所需时间，供合计串行预算。'};
  } else if (properties.passage) {
    result={passage:'第二段依据：'+data.localEvidence.trim(),evidence:data.localEvidence.trim()};
  } else if (properties.conclusion) {
    const time=text=>text.match(/(\d+) ms/)[0];
    const leadQuote=time(data.lead), passageQuote=time(data.passage);
    const total=parseInt(leadQuote,10)+parseInt(passageQuote,10);
    if(data.task.includes('演练退修') && data.notes.length && !data.previousManuscript?.includes('合计 0 ms'))
      throw Error('The editor did not receive the actual manuscript sent back for correction');
    if(data.task.includes('演练退修') && !data.notes.length){
      result={leadQuote,passageQuote,conclusion:leadQuote+' 和 '+passageQuote+'，合计 0 ms。',rationale:'初次编辑'};
    }else result={leadQuote,passageQuote,conclusion:leadQuote+' + '+passageQuote+' = '+total+' ms，超出预算 '+(total-300)+' ms。',
      rationale:['合并两个串行阶段后与预算比较。',...data.notes].join(' ')};
    result.opening='第一阶段记录为 '+leadQuote+'。';
    result.section='第二阶段记录为 '+passageQuote+'。';
  } else if (properties.question) {
    result={draft:'本端观测：'+data.localEvidence.trim(),question:'对端的观测支持同样的结论吗？'};
  } else if (properties.finding) {
    if (process.env.QQ_FIXTURE_GATE) {
      const until=Date.now()+15000;
      while (!fs.existsSync(process.env.QQ_FIXTURE_GATE)) {
        if (Date.now()>until) throw Error('Fixture gate did not open');
        await sleep(15);
      }
    }
    result={finding:'需要使用第二台设备的独立观测。',evidence:data.localEvidence.trim(),
      suggestion:['在最终结论中列出两个平台的数据。',...data.notes].join(' ')};
  } else {
    result={answer:data.draft+' 另一端补充：'+data.review.evidence,disposition:'adopted',
      rationale:['依据两份观测修订。',...data.notes].join(' ')};
  }
  fs.writeFileSync(argument('-o'),JSON.stringify(result));
}
