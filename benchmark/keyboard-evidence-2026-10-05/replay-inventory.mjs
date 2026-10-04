import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {renderBrowserInputs} from '../../src/contracts/attestation.ts';
import {parseVerdict} from '../../src/atoms/json.ts';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const protocol=JSON.parse(readFileSync(root+'inventory-protocol.json'));
const base=JSON.parse(gunzipSync(readFileSync(root+'requests.json.gz'))).find(r=>r.arm==='executed-actions').request;
const fixture=JSON.parse(readFileSync(root+'fixture.json'));
const guidance=readFileSync(root+'guidance.txt','utf8').trim();
const inventory=renderBrowserInputs(fixture.records);
const requests=protocol.arms.map(arm=>{
 const request={...base};
 if(arm==='terra-actions')request.model='gpt-5.6-terra';
 else request.userContent=request.userContent.replace(/(BROWSER LAYOUTS OBSERVED[^\n]*)/, '$1\n\n'+inventory);
 if(arm==='luna-inventory-guidance')request.systemPrompt+='\n\n'+guidance;
 return {arm,request,sha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
});
const output=root+'inventory-responses.jsonl';
const previous=existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
for(const row of previous)if(requests.find(r=>r.arm===row.arm)?.sha256!==row.requestSha256)throw Error('Inputs changed; preserve this series.');
writeFileSync(root+'inventory-requests.json.gz',gzipSync(JSON.stringify(requests,null,2)+'\n'));
if(!process.argv.includes('--live')){console.log('Prepared; --live sends nine verdicts.');process.exit(0);}
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


for(let repeat=0;repeat<3;repeat++)for(let i=0;i<3;i++){
 const c=requests[(repeat+i)%3];const key=repeat+':'+c.arm;
 if(previous.some(r=>r.key===key&&!r.error))continue;
 let row={key,repeat,arm:c.arm,requestSha256:c.sha256,startedAt:new Date().toISOString()};
 const start=Date.now();
 try{const response=await client.complete({...c.request,signal:AbortSignal.timeout(65000)});row={...row,response};
  try{row.verdict=parseVerdict(response.text);}catch(error){row.parseError=String(error);}
 }catch(error){row.error=String(error);}
 row.durationMs=Date.now()-start;appendFileSync(output,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({key,error:row.error,criterion:row.verdict?.criteria?.find(c=>c.id==='c11')}));
 if(row.error)process.exit(1);
}
