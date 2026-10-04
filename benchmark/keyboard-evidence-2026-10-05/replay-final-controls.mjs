import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {renderBrowserInputs} from '../../src/contracts/attestation.ts';
import {parseVerdict} from '../../src/atoms/json.ts';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const protocol=JSON.parse(readFileSync(root+'final-controls-protocol.json','utf8'));
const archived=JSON.parse(gunzipSync(readFileSync(root+'requests.json.gz')));
const guidance=readFileSync(root+'guidance.txt','utf8').trim();
const cases=JSON.parse(readFileSync(root+'cases.json','utf8'));
const requests=[];
for(const c of cases){
 const record={eventId:c.id,tool:'validate_html',observation:c.observation};
 const request={model:protocol.model??'gpt-5.6-luna',systemPrompt:archived[0].request.systemPrompt+'\n\n'+guidance,params:{temperature:0,maxTokens:2048},role:'validate-result',userContent:
 'Subject kind: RESULT\nTask: '+c.task+'\nChild declared tools: validate_html\nChild report (not proof): verified successfully.\nTRANSPORT-OBSERVED TOOL EVIDENCE:\n'+c.line+'\n'+renderBrowserInputs([record])+'\nCriterion c1: '+c.task+'\nReturn a Verdict JSON with approved, reasoning and criteria [{id:"c1",met:true|false,reason:string}].'};
 requests.push({id:c.id,expected:c.expected,request});
}
const recovered=structuredClone(requests.find(r=>r.id==='keyboard-pass'));
recovered.id='recovered-keyboard';
recovered.request.userContent=recovered.request.userContent.replace('TRANSPORT-OBSERVED TOOL EVIDENCE:',
 'Earlier attempt, before the control was repaired (historical, not the current delivery):\n'+cases.find(c=>c.id==='keyboard-failure').line+'\nCurrent delivery, after repair, tested with a fresh browser:\nTRANSPORT-OBSERVED TOOL EVIDENCE:');
requests.push(recovered);
for(const r of requests)r.sha256=createHash('sha256').update(JSON.stringify(r.request)).digest('hex');
const output=root+'final-controls-responses.jsonl';
const previous=existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
for(const row of previous)if(requests.find(r=>r.id===row.id)?.sha256!==row.requestSha256)throw Error('Inputs changed; preserve this series.');
writeFileSync(root+'final-controls-requests.json.gz',gzipSync(JSON.stringify(requests,null,2)+'\n'));
if(!process.argv.includes('--live')){console.log('Prepared requests; --live sends 14 tool-free judgments.');process.exit(0);}
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
for(let repeat=0;repeat<2;repeat++)for(const c of requests)jobs.push({repeat,c});
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
