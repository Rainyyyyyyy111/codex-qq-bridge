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
  if (properties.question) {
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
