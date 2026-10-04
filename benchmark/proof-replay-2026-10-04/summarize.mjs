import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const protocol=JSON.parse(readFileSync(root+'protocol.json','utf8'));
const rows=readFileSync(root+'responses.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const judgments=rows.filter(row=>row.verdict);
if(new Set(judgments.map(r=>r.key)).size!==judgments.length)throw Error('Duplicate scored key');
const arms=protocol.arms.map(arm=>{
 const scored=judgments.filter(r=>r.arm===arm);
 return {arm,scored:scored.length,falseApprovals:scored.filter(r=>!r.expected&&r.verdict.approved).length,falseRefusals:scored.filter(r=>r.expected&&!r.verdict.approved).length,
  cases:protocol.labels.map(c=>({id:c.id,expected:c.expected,verdicts:scored.filter(r=>r.id===c.id).map(r=>r.verdict.approved)}))};
});
const result={complete:judgments.length===protocol.calls,scored:judgments.length,planned:protocol.calls,transportErrors:rows.filter(r=>r.error).length,parseErrors:rows.filter(r=>r.parseError).length,modelsServed:[...new Set(judgments.map(r=>r.response.servedModel))],inputTokens:judgments.reduce((n,r)=>n+r.response.usage.inputTokens,0),outputTokens:judgments.reduce((n,r)=>n+r.response.usage.outputTokens,0),arms,metricMeaning:'falseRefusals counts rejection of the oracle-conforming artifact. Some rejections ask for evidence absent from the bounded prompt; these are not automatically fabricated defects. Inspect the recorded reasoning separately.',caveat:'Three repetitions per case; controlled reconstruction, not a production end-to-end run or a guarantee of future accuracy. Oracle labels assess only the three scoped rules. Transport diagnostics excluded from model error rates.'};
writeFileSync(root+'summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
