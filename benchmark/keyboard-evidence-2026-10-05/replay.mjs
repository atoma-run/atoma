import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {renderObservation} from '../../src/contracts/attestation.ts';
import {parseVerdict} from '../../src/atoms/json.ts';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const fixture=JSON.parse(readFileSync(root+'fixture.json','utf8'));
const protocol=JSON.parse(readFileSync(root+'protocol.json','utf8'));
let changed=0;
const updated=fixture.userContent.split('\n').map(line=>{
 const record=fixture.records.find(r=>line.startsWith(r.eventId+': validate_html:'));
 if(!record)return line;
 const action=renderObservation(record).split('executedActions=')[1].split(', smoke=')[0].split(', smokeResult=')[0];
 changed++;
 // Preserve the original smoke deduplication and every other byte.
 const beforeSmoke=line.indexOf(', smoke=');
 return line.slice(0,beforeSmoke)+', executedActions='+action+line.slice(beforeSmoke);
}).join('\n');
if(changed!==8)throw Error('Expected exactly eight archived browser lines');
const requests=protocol.arms.map(arm=>{
 const request={model:protocol.model,systemPrompt:fixture.systemPrompt,userContent:arm==='original'?fixture.userContent:updated,params:{temperature:0,maxTokens:2048},role:'validate-result'};
 return {arm,request,sha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
});
const output=root+'responses.jsonl';
const previous=existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
for(const row of previous)if(requests.find(r=>r.arm===row.arm)?.sha256!==row.requestSha256)throw Error('Inputs changed; preserve results in this directory.');
writeFileSync(root+'requests.json.gz',gzipSync(JSON.stringify(requests,null,2)+'\n'));
if(!process.argv.includes('--live')){console.log('Prepared 2 requests; --live makes six tool-free judgments.');process.exit(0);}
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

for(let repeat=0;repeat<protocol.repeats;repeat++)for(let i=0;i<2;i++){
 const c=requests[(repeat+i)%2];const key=repeat+':'+c.arm;
 if(previous.some(r=>r.key===key&&!r.error))continue;
 let row={key,repeat,arm:c.arm,requestSha256:c.sha256,startedAt:new Date().toISOString()};
 const start=Date.now();
 try{const response=await client.complete({...c.request,signal:AbortSignal.timeout(65000)});row={...row,response};
  try{row.verdict=parseVerdict(response.text);}catch(error){row.parseError=String(error);}
 }catch(error){row.error=String(error);}
 row.durationMs=Date.now()-start;appendFileSync(output,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({key,error:row.error,verdict:row.verdict}));
 if(row.error)process.exit(1);
}
