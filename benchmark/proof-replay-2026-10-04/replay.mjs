import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {L1Atom} from '../../src/atoms/L1Atom.ts';
import {llmVerdict,renderTransportEvidence,MAX_TOOL_EVIDENCE_CHARS,MAX_BROWSER_EVIDENCE_LINES} from '../../src/atoms/verdict.ts';
import {parseExecutionObservation,renderObservations} from '../../src/contracts/attestation.ts';
import {parseVerdict} from '../../src/atoms/json.ts';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
import {makeCtx} from '../../tests/helpers.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const TEST_EVIDENCE_GUIDANCE=readFileSync(root+'guidance.txt','utf8');
const cases=JSON.parse(readFileSync(root+'cases.json','utf8'));
const protocol=JSON.parse(readFileSync(root+'protocol.json','utf8'));
function oldRender(observed){
 const ids=new Set(observed.filter(w=>w.tool==='validate_html').slice(-MAX_BROWSER_EVIDENCE_LINES).map(w=>w.eventId));
 let chars=observed.filter(w=>ids.has(w.eventId)).reduce((n,w)=>n+w.eventId.length+2+w.observed.length,0);
 for(const w of [...observed].reverse()){
  if(w.tool==='validate_html')continue;
  const length=w.eventId.length+2+w.observed.length;
  if(chars+length>MAX_TOOL_EVIDENCE_CHARS)break;
  ids.add(w.eventId);chars+=length;
 }
 const lines=observed.filter(w=>ids.has(w.eventId)).map(w=>`${w.eventId}: ${w.observed}`);
 return {lines,omitted:observed.length-lines.length};
}
const requests=[];
for(const c of cases){
 const records=[];
 function add(tool,args,result){records.push({eventId:'e'+records.length,tool,attempt:1,branchId:'verification',observation:parseExecutionObservation(tool,args,result)});}
 for(const f of c.files)add('read_file',{path:f.path},{path:f.path,content:f.content});
 if(c.id!=='original')add('read_file',{path:'helper.cjs'},{path:'helper.cjs',content:c.helper});
 for(let i=0;i<120;i++)add('fetch_url',{url:'http://localhost:4000/api/books',method:'GET'},{ok:true,status:200,body:JSON.stringify({note:'catalogue snapshot',padding:'x'.repeat(500)})});
 add('run_shell',{cmd:'node --test '+c.files.map(f=>f.path).join(' ')},{exitCode:c.exitCode,stdout:c.stdout,stderr:c.stderr});
 const lines=renderObservations(records);
 const evidence=records.map((r,i)=>({source:'transport-observed',eventId:r.eventId,tool:r.tool,observed:lines[i]}));
 const ctx=makeCtx();ctx.llm.enqueueText(JSON.stringify({approved:true,reasoning:'capture only'}));
 const child=new L1Atom({name:'CarbonDioxide',ordinal:1,model:protocol.model,systemPrompt:'Verify the library',tools:['read_file','run_shell','fetch_url'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}})),params:{}});
 await llmVerdict({ctx,model:protocol.model,supervisorName:'run-root',supervisorTier:3,subject:'RESULT',child,
  task:{description:'Verify the existing library application and its automated regression tests for these three requirements only: premium members may hold at most five active loans, so a sixth loan of an otherwise available copy is refused; renewal moves the existing due date exactly 14 days later; unpaid fines of exactly 5.00 do not block borrowing (only amounts greater than 5.00 block it). Tests must detect a violation of each of these rules and all tests must pass. Repair failures as necessary. Other requirements are outside this verification phase.'},
  payload:{output:'Verification complete',summary:'All three rules and their regression tests have been verified.'},evidence,groundTruthBlock:''});
 const req=ctx.llm.calls.at(-1);
 const prefix=req.userContent.slice(0,req.userContent.indexOf('== TRANSPORT-OBSERVED TOOL EVIDENCE =='));
 const newBlock=req.userContent.slice(prefix.length);
 const header=newBlock.split('\n').slice(0,2).join('\n');
 for(const arm of protocol.arms){
  const rendered=arm.startsWith('new-')?renderTransportEvidence(evidence):oldRender(evidence);
  const systemPrompt=arm.endsWith('/new-guidance')?req.systemPrompt.replace('If Subject kind is RESULT:\n','If Subject kind is RESULT:\n'+TEST_EVIDENCE_GUIDANCE+'\n'):req.systemPrompt;
  const userContent=prefix+header+'\n'+(rendered.omitted?`${rendered.omitted} earlier observations omitted; absence here does not prove they did not run.\n`:'')+rendered.lines.join('\n');
  requests.push({id:c.id,arm,expected:c.expected,request:{...req,signal:undefined,systemPrompt,userContent},sha256:createHash('sha256').update(systemPrompt+'\n'+userContent).digest('hex')});
 }
}
if(existsSync(root+'responses.jsonl')){
 const recorded=readFileSync(root+'responses.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const row of recorded){
  const current=requests.find(r=>r.id===row.id&&r.arm===row.arm);
  if(!current||current.sha256!==row.requestSha256)throw Error('Requests differ from recorded answers; preserve this series and use a new directory.');
 }
}
writeFileSync(root+'requests.json.gz',gzipSync(JSON.stringify(requests,null,2)+'\n'));
if(!process.argv.includes('--live')){console.log('Prepared '+requests.length+' requests; --live sends the preregistered 60 calls.');process.exit(0);}
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
const output=root+'responses.jsonl';
const previous=existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const done=new Set(previous.filter(r=>!r.error).map(r=>r.key));
for(let repeat=0;repeat<protocol.repeats;repeat++)for(let ci=0;ci<cases.length;ci++)for(let ai=0;ai<4;ai++){
 const arm=protocol.arms[(ai+ci+repeat)%4];const c=requests.find(r=>r.id===cases[ci].id&&r.arm===arm);
 const key=[repeat,c.id,arm].join(':');if(done.has(key))continue;
 const start=Date.now();let row={key,repeat,id:c.id,arm,expected:c.expected,requestSha256:c.sha256,startedAt:new Date().toISOString()};
 try{
  const response=await client.complete({...c.request,signal:AbortSignal.timeout(65000)});
  row={...row,response};
  try{row.verdict=parseVerdict(response.text);row.correct=row.verdict.approved===c.expected;}catch(error){row.parseError=String(error);}
 }catch(error){row.error=String(error);}
 row.durationMs=Date.now()-start;appendFileSync(output,JSON.stringify(row)+'\n');
 console.log(JSON.stringify({key,correct:row.correct,error:row.error,parseError:row.parseError,durationMs:row.durationMs}));
 if(row.error)process.exitCode=1;
 // A transport error is not a wrong judgment. Stop rather than spend the batch on a broken connection.
 if(row.error)process.exit(1);
}
