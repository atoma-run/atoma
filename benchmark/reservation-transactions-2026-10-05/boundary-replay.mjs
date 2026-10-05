// Paired diagnostic and complete first-refusal inventory. --live spends quota.
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
import {llmVerdict} from '../../src/atoms/verdict.ts';
import {reviewAcceptanceCriteria} from '../../src/atoms/criteriaReview.ts';
const root=new URL('.',import.meta.url), file=name=>new URL(`boundary-${name}`,root);
const archive=JSON.parse(gunzipSync(readFileSync(new URL('seventh-attempt.json.gz',root))));
const baseline=JSON.parse(readFileSync(file('baseline-guidance.json')));
// Preserve this rejected prompt candidate after removing it from production.
const ASSERTION_EVIDENCE_GUIDANCE=JSON.parse(readFileSync(file('candidate-guidance.json')));
const request=JSON.parse(readFileSync(new URL('seventh-request.json',root)));
const live=process.argv.includes('--live');
process.env.ATOMA_MODEL_L1='sub:openai:gpt-5.6-luna';
const rows=existsSync(file('responses.jsonl'))?readFileSync(file('responses.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const binary=live?realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY):undefined;
const env={...process.env};delete env.ATOMA_CODEX_MODEL;
const client=live?new CodexCliLlmClient({env,callTimeoutMs:120000,spawnFn:(args,input,childEnv,cwd)=>{
 const adjusted=args.map(a=>a.startsWith('permissions.atoma-text-only.filesystem=')?a.slice(0,-1)+','+JSON.stringify(binary)+'="read"}':a);
 const child=spawn(binary,adjusted,{env:childEnv,cwd,detached:true,stdio:['pipe','pipe','pipe']});child.stdin.end(input);return child;
}}):undefined;
const cases=['11433302-20b8-4ef0-a86c-e3bd08f5bfe7','0ab3a946-26e9-4f0d-81d4-67c92c8925ba'].map(id=>({id,event:archive.events.find(e=>e.id===id),expected:null}));
const description='Verify inclusive expiration at exactly expiresAt=clockAtReservation+ttl, using executed assertions. For example at clock 0, ttl 5 expires at 5. No particular starting clock is required.';
const evidence='Host records: GET state clock=10, available=1, holds=[]. Reserve h with ttl=5 succeeds and GET asserts h.expiresAt=15, status=held, available=0. Advance to 15 succeeds and GET asserts clock=15, h.status=expired, available=1. The script asserts each response and stated field, exit 0, no subsequent writes.';
cases.push(
 {id:'shifted-exact-boundary',task:{description},evidence,expected:true},
 {id:'past-boundary-not-equality',task:{description},evidence:evidence.replaceAll('Advance to 15','Advance to 16').replaceAll('clock=15','clock=16'),expected:false},
 {id:'unknown-derived-boundary',task:{description},evidence:'Host observed reserve ttl=5 and later advance to 15 succeed, then asserted status=expired. Starting clock and expiresAt were not read or asserted. Script exit 0.',expected:false},
 {id:'explicit-absolute-value',task:{description:'The acceptance fixture MUST start at clock 0, reserve ttl=5, and advance exactly to 5. Execute and assert this exact input sequence.'},evidence,expected:false},
);
const requests=[],results=[];
async function complete(key,req){
 const request={model:'gpt-5.6-luna',systemPrompt:req.systemPrompt,userContent:req.userContent,params:req.params};
 const sha256=createHash('sha256').update(JSON.stringify(request)).digest('hex');requests.push({key,sha256,request});
 const saved=rows.find(r=>r.key===key&&r.response);if(saved&&saved.sha256!==sha256)throw Error('Input drift '+key);
 if(saved)return saved.response;if(!live)throw Error('Missing response '+key);
 const row={key,sha256,startedAt:new Date().toISOString()};
 try{row.response=await client.complete({...request,signal:AbortSignal.timeout(125000)});}catch(error){row.error=String(error);}
 appendFileSync(file('responses.jsonl'),JSON.stringify(row)+'\n');writeFileSync(file('requests.json.gz'),gzipSync(JSON.stringify(requests),{mtime:0}));
 if(row.error)throw Error(row.error);return row.response;
}
for(const[index,fixture]of cases.entries())for(const arm of index%2?['candidate','baseline']:['baseline','candidate']){
 const verdict=await llmVerdict({ctx:{llm:{complete:async rendered=>{
  const base=fixture.event?{...rendered,systemPrompt:fixture.event.systemPrompt,userContent:fixture.event.userContent}:rendered;
  const system=base.systemPrompt.replace(ASSERTION_EVIDENCE_GUIDANCE,baseline);
  if(!system.includes(baseline))throw Error('No baseline guidance');
  return complete(`${fixture.id}:${arm}`,{...base,systemPrompt:arm==='candidate'?system.replace(baseline,ASSERTION_EVIDENCE_GUIDANCE):system});
 }},signal:new AbortController().signal},model:'gpt-5.6-luna',supervisorName:'Cell',supervisorTier:2,subject:'RESULT',
 child:{name:'Molecule',tier:1,toolNames:()=>['read_file','write_file','run_shell'],isFallbackMode:()=>false},
 task:fixture.task??{description:'Archived exact task supplied by recorded request'},payload:{output:'done',summary:'completed'},groundTruthBlock:fixture.evidence??'Archived evidence'});
 const row={id:fixture.id,arm,expected:fixture.expected,matchesExpected:fixture.expected===null?null:verdict.approved===fixture.expected,verdict};results.push(row);console.log(JSON.stringify(row));writeFileSync(file('results.json'),JSON.stringify(results,null,2)+'\n');
}
// The early focused inventory sees the original task and host evidence, never
// the success report or global refusal. This is the actual production helper.
const first=cases[0].event;
const at=first.userContent.indexOf('== GROUND-TRUTH EVIDENCE');if(at<0)throw Error('Missing evidence boundary');
let batch=0;
const focused=await reviewAcceptanceCriteria({ctx:{llm:{complete:req=>complete(`first-refusal-inventory:${batch++}`,req)},signal:new AbortController().signal},
 task:{description:request.goal},checklist:request.acceptanceCriteria.map((behaviour,i)=>({id:`c${i+1}`,behaviour,check:{kind:'review'}})),evidence:first.userContent.slice(at)});
console.log(JSON.stringify({id:'first-refusal-inventory',focused}));writeFileSync(file('inventory.json'),JSON.stringify(focused,null,2)+'\n');
writeFileSync(file('requests.json.gz'),gzipSync(JSON.stringify(requests),{mtime:0}));
