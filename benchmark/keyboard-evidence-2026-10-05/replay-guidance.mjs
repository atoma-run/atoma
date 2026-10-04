import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseVerdict} from '../../src/atoms/json.ts';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const protocol=JSON.parse(readFileSync(root+'guidance-protocol.json','utf8'));
const archived=JSON.parse(gunzipSync(readFileSync(root+'requests.json.gz')));
const guidance=readFileSync(root+'guidance.txt','utf8').trim();
const cases=JSON.parse(readFileSync(root+'cases.json','utf8'));
const requests=[];
for(const c of cases)for(const arm of protocol.arms){
 const request={model:protocol.model,systemPrompt:archived[0].request.systemPrompt+(arm==='actions-and-guidance'?'\n\n'+guidance:''),params:{temperature:0,maxTokens:2048},role:'validate-result',userContent:
 'Subject kind: RESULT\nTask: '+c.task+'\nChild declared tools: validate_html\nChild report (not proof): verified successfully.\nTRANSPORT-OBSERVED TOOL EVIDENCE:\n'+c.line+'\nCriterion c1: '+c.task+'\nReturn a Verdict JSON with approved, reasoning and criteria [{id:"c1",met:true|false,reason:string}].'};
 requests.push({id:c.id,arm,expected:c.expected,request,sha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')});
}
const request={...archived.find(r=>r.arm==='executed-actions').request};request.systemPrompt+='\n\n'+guidance;
requests.push({id:'production',arm:'actions-and-guidance',expected:false,request,sha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')});
const output=root+'guidance-responses.jsonl';
const previous=existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
for(const row of previous)if(requests.find(r=>r.id===row.id&&r.arm===row.arm)?.sha256!==row.requestSha256)throw Error('Inputs changed; preserve this series.');
writeFileSync(root+'guidance-requests.json.gz',gzipSync(JSON.stringify(requests,null,2)+'\n'));
if(!process.argv.includes('--live')){console.log('Prepared requests; --live sends 27 tool-free judgments.');process.exit(0);}
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
for(let repeat=0;repeat<2;repeat++)for(let ci=0;ci<cases.length;ci++)for(let ai=0;ai<2;ai++)jobs.push({repeat,c:requests.find(r=>r.id===cases[ci].id&&r.arm===protocol.arms[(ai+ci+repeat)%2])});
for(let repeat=0;repeat<3;repeat++)jobs.push({repeat,c:requests.find(r=>r.id==='production')});
for(const {repeat,c} of jobs){
 const key=[repeat,c.id,c.arm].join(':');if(previous.some(r=>r.key===key&&!r.error))continue;
 let row={key,repeat,id:c.id,arm:c.arm,expected:c.expected,requestSha256:c.sha256,startedAt:new Date().toISOString()};
 const start=Date.now();
 try{const response=await client.complete({...c.request,signal:AbortSignal.timeout(65000)});row={...row,response};
  try{row.verdict=parseVerdict(response.text);}catch(error){row.parseError=String(error);}
 }catch(error){row.error=String(error);}
 row.durationMs=Date.now()-start;appendFileSync(output,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({key,error:row.error,approved:row.verdict?.approved,criteria:row.verdict?.criteria}));
 if(row.error)process.exit(1);
}
