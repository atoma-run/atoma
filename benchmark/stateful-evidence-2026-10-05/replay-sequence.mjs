import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CodexCliLlmClient } from '../../src/core/llmCodexCli.ts';
import { parseVerdict } from '../../src/atoms/json.ts';
import { VALIDATION_SYSTEM_PROMPT } from '../../src/atoms/verdict.ts';
import { STATEFUL_EVIDENCE_GUIDANCE, STATEFUL_EVIDENCE_REVIEW } from '../../src/atoms/prompts.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const fixture=JSON.parse(readFileSync(root+'fixture.json','utf8'));
const protocol=JSON.parse(readFileSync(root+'sequence-protocol.json','utf8'));
const baseline=VALIDATION_SYSTEM_PROMPT.slice(0,-('\n\n'+STATEFUL_EVIDENCE_GUIDANCE).length);
if(!VALIDATION_SYSTEM_PROMPT.endsWith('\n\n'+STATEFUL_EVIDENCE_GUIDANCE))throw Error('Candidate prompt boundary changed');
const cap='Verify that an account may hold at most five active leases. Creating a lease at the limit must be refused with 409; creation below the limit succeeds with 201 when capacity is available.';
const cases=[
 {id:'failed-setup',expected:false,diagnosis:'unverified, not a demonstrated limit defect',evidence:'Initial state: account A has zero active leases, capacity available. Create 1 -> 201 id=L1. Create 2 -> 201 id=L2. Create 3 -> 201 id=L3. Create 4 -> 201 id=L4. Create labelled "lease 5" -> 409 capacity unavailable, no lease created. Next create labelled "sixth refusal" -> 201 id=L5. No other changes. Child claims: limit verified.'},
 {id:'real-violation',expected:false,diagnosis:'demonstrated limit defect',evidence:'State read immediately before request: A has five active leases L1 through L5, capacity available. POST create -> 201 id=L6; state read after request: A has six active leases. No other changes. Child claims: limit verified.'},
 {id:'verified-limit',expected:true,diagnosis:'verified',evidence:'Isolated setup starts at zero leases; five sequential creates each returned 201 with distinct IDs L1 through L5. State read: five active leases, capacity available. Next POST create -> 409 error=active lease limit. State read after refusal: same five leases. Child claims: limit verified.'},
 {id:'wrong-refusal-cause',expected:false,diagnosis:'unverified',evidence:'A has four active leases. The next request, labelled "sixth refusal", returns 409 error=capacity unavailable. No check at five active leases was executed. Child claims: limit verified because status was 409.'},
 {id:'unknown-initial-state',expected:false,diagnosis:'unverified, do not infer empty initial state',evidence:'Initial active count unknown. Two observed creations succeed with IDs L8 and L9. Next request labelled "sixth refusal" returns 409 error=lease refused. No state read or other setup evidence. Child claims: limit verified.'},
 {id:'existing-state',expected:true,diagnosis:'verified; do not demand reset',evidence:'Existing user data is retained. Test account A has four active leases according to immediate state read. Capacity available. Create -> 201 id=L5; state read shows five leases. Next create -> 409 error=active lease limit with capacity still available. Final state shows same five leases. No intervening changes. Child claims: limit verified.'},
];
const requests=[];
for(const arm of protocol.arms){
 const systemPrompt=arm==='baseline'?baseline:VALIDATION_SYSTEM_PROMPT;
 requests.push({id:'production',arm,request:{model:protocol.model,systemPrompt,userContent:fixture.validator.userContent,role:'validate-result',params:{temperature:0,maxTokens:2048}}});
 for(const c of cases)requests.push({id:c.id,arm,expected:c.expected,diagnosis:c.diagnosis,request:{model:protocol.model,systemPrompt,userContent:'Subject kind: RESULT\nTask: '+cap+'\nChild report: verification complete.\nTransport-observed sequence:\n'+c.evidence+'\nJudge whether this verification is complete. If not, distinguish an invalid or incomplete check from an implementation defect in reasoning and remediation.',role:'validate-result',params:{temperature:0,maxTokens:2048}}});
}
for(const r of requests)if(r.arm==='stateful-guidance'){
 if(r.id==='production')r.request.userContent=r.request.userContent.replace(/These are historical observations[^\n]*/, line=>line+' '+STATEFUL_EVIDENCE_REVIEW);
 else r.request.userContent=r.request.userContent.replace('Transport-observed sequence:', 'Transport-observed sequence:\n'+STATEFUL_EVIDENCE_REVIEW);
}
for(const r of requests)r.sha256=createHash('sha256').update(JSON.stringify(r.request)).digest('hex');
const output=root+'sequence-responses.jsonl';
const previous=existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
for(const row of previous)if(requests.find(r=>r.id===row.id&&r.arm===row.arm)?.sha256!==row.requestSha256)throw Error('Inputs changed; preserve measured series.');
writeFileSync(root+'sequence-requests.json.gz',gzipSync(JSON.stringify(requests,null,2)+'\n'));
writeFileSync(root+'sequence-review.txt',STATEFUL_EVIDENCE_REVIEW+'\n');
if(!process.argv.includes('--live')){console.log('Prepared; --live spends quota on 9 tool-free judgments.');process.exit(0);}
const env={...process.env};delete env.ATOMA_CODEX_MODEL;
// macOS needs the CLI executable itself inside the read-only runtime surface.
// Keep every production denial and disabled capability; reopen only this file.
const executable=process.env.ATOMA_REPLAY_CODEX_BINARY;
const spawnFn=executable?(args,stdin,childEnv,cwd)=>{
 const binary=realpathSync(executable);
 const adjusted=args.map(a=>a.startsWith('permissions.atoma-text-only.filesystem=')
  ?a.slice(0,-1)+','+JSON.stringify(binary)+'="read"}':a);
 const child=spawn(binary,adjusted,{env:childEnv,cwd,detached:true,stdio:['pipe','pipe','pipe']});
 child.stdin.end(stdin);return child;
}:undefined;
const client=new CodexCliLlmClient({env,callTimeoutMs:60000,...(spawnFn?{spawnFn}:{})});
const jobs=[];
for(let repeat=0;repeat<3;repeat++)for(const arm of ['stateful-guidance'])jobs.push({repeat,c:requests.find(r=>r.id==='production'&&r.arm===arm)});
for(let i=0;i<cases.length;i++)for(const arm of ['stateful-guidance'])jobs.push({repeat:0,c:requests.find(r=>r.id===cases[i].id&&r.arm===arm)});
for(const {repeat,c} of jobs){
 const key=[repeat,c.id,c.arm].join(':');if(previous.some(r=>r.key===key&&!r.error))continue;
 let row={key,repeat,id:c.id,arm:c.arm,expected:c.expected,diagnosis:c.diagnosis,requestSha256:c.sha256,startedAt:new Date().toISOString()};
 const start=Date.now();
 try{const response=await client.complete({...c.request,signal:AbortSignal.timeout(65000)});row={...row,response};try{row.verdict=parseVerdict(response.text);}catch(error){row.parseError=String(error);}}
 catch(error){row.error=String(error);}
 row.durationMs=Date.now()-start;appendFileSync(output,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({key,error:row.error,verdict:row.verdict}));
 if(row.error)process.exit(1);
}
