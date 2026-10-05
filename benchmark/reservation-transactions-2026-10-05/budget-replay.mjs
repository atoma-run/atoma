// Paired evidence replay; no tool execution. --live explicitly spends quota.
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {CodexCliLlmClient} from '../../src/core/llmCodexCli.ts';
import {llmVerdict,VALIDATION_SYSTEM_PROMPT} from '../../src/atoms/verdict.ts';
import {criteriaFilesBlock} from '../../src/atoms/fileEvidence.ts';
const root=new URL('.',import.meta.url), file=name=>new URL(`budget-${name}`,root);
const archive=JSON.parse(gunzipSync(readFileSync(new URL('eighth-attempt.json.gz',root))));
const event=archive.events.find(e=>e.id==='80e8a962-b419-40dd-9570-f843a4bc15de');
const focused=archive.events.find(e=>e.id==='a7a1081e-1b52-47a6-a142-8c7ad1e08d39');
const files=Object.fromEntries(['server.js','test-api.js','README.md'].map(n=>[n,readFileSync(new URL('eighth-draft/'+n+'.txt',root),'utf8')]));
const required=archive.request.acceptanceCriteria.map((behaviour,i)=>({id:'c'+(i+1),behaviour,check:{kind:'review'}}));
const live=process.argv.includes('--live');
const rows=existsSync(file('responses.jsonl'))?readFileSync(file('responses.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const binary=live?realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY):undefined;
const env={...process.env};delete env.ATOMA_CODEX_MODEL;
const client=live?new CodexCliLlmClient({env,callTimeoutMs:120000,spawnFn:(args,input,childEnv,cwd)=>{
 const adjusted=args.map(a=>a.startsWith('permissions.atoma-text-only.filesystem=')?a.slice(0,-1)+','+JSON.stringify(binary)+'="read"}':a);
 const child=spawn(binary,adjusted,{env:childEnv,cwd,detached:true,stdio:['pipe','pipe','pipe']});child.stdin.end(input);return child;
}}):undefined;
const setup='// startup helper\n'+' '.repeat(6500)+'\n';
const correct=setup+"import assert from 'node:assert/strict'; import {price} from './price.mjs'; assert.equal(price(100),95);\n";
const task={description:'Implement price(n): apply a 10% discount BEFORE adding a fee of 5. Execute test.js asserting price(100)===95, distinguishing fee-before-discount (94.5). No other artifact is required.'};
const cases=[
 {id:'archived-final-root',event,expected:null},
 {id:'archived-final-receipts',event:focused,expected:null},
 {id:'archived-final-concurrency',event:archive.events.find(e=>e.id==='af729eba-7b65-42f4-9397-6ebb4bec20c3'),expected:null},
 {id:'current-assertion-executed',body:correct,expected:true},
 {id:'wrong-assertion-executed',body:correct.replace('95);','94.5);'),expected:false},
 {id:'assertion-never-executed',body:correct,expected:false,noExecution:true},
 {id:'assertion-edited-after-execution',body:correct,expected:false,editedAfter:true},
];
const requests=[],results=[];
for(const [index,fixture] of cases.entries())for(const arm of index%2?['candidate','baseline']:['baseline','candidate']){
 const current=fixture.event ? await criteriaFilesBlock({tools:{has:n=>n==='read_file',execute:async(_n,args)=>({content:files[args.path]})}},required,['test-api.js','.atoma-probes.json'],archive.request.goal) : await criteriaFilesBlock({tools:{has:n=>n==='read_file',execute:async()=>({content:fixture.body})}},[],['test.js'],task.description);
 const base="Host current entire price.mjs: export function price(n) { return n * 0.9 + 5; }\nOld test.js read: STALE, superseded contents omitted. Current test.js exists, only its setup head was shown.\n"+
  (fixture.noExecution?'No test command was executed.':fixture.editedAfter?'Host ran node test.js BEFORE its last edit; no execution of the new assertions.':'Host ran node test.js AFTER its last edit, exit 0, no subsequent writes.');
 const complete=async rendered=>{
  const request={model:'gpt-5.6-luna',systemPrompt:fixture.event?.systemPrompt??VALIDATION_SYSTEM_PROMPT,userContent:fixture.event?.userContent??rendered.userContent,params:rendered.params};
  if(arm==='candidate') {
   if(fixture.event){const start=request.userContent.indexOf('FILES THE CRITERIA'),end=request.userContent.indexOf('\n\nSTARTING WORKSPACE',start);if(start<0||end<0)throw Error('Missing readback boundary');request.userContent=request.userContent.slice(0,start)+current+request.userContent.slice(end);}
   else request.userContent+='\n\n'+current;
  }
  const key=`${fixture.id}:${arm}`,sha256=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  requests.push({key,sha256,request});
  const saved=rows.find(r=>r.key===key&&r.response);if(saved&&saved.sha256!==sha256)throw Error('Input drift '+key);
  if(saved)return saved.response;if(!live)throw Error('Missing response '+key);
  const row={key,sha256,startedAt:new Date().toISOString()};
  try{row.response=await client.complete({...request,signal:AbortSignal.timeout(125000)});}catch(error){row.error=String(error);}
  appendFileSync(file('responses.jsonl'),JSON.stringify(row)+'\n');writeFileSync(file('requests.json.gz'),gzipSync(JSON.stringify(requests),{mtime:0}));
  if(row.error)throw Error(row.error);return row.response;
 };
 const verdict=await llmVerdict({ctx:{llm:{complete},signal:new AbortController().signal},model:'gpt-5.6-luna',supervisorName:'Cell',supervisorTier:2,subject:'RESULT',
  child:{name:'Molecule',tier:1,toolNames:()=>['read_file','write_file','run_shell'],isFallbackMode:()=>false},task,payload:{output:'done',summary:'completed'},groundTruthBlock:base});
 const row={id:fixture.id,arm,expected:fixture.expected,matchesExpected:fixture.expected===null?null:verdict.approved===fixture.expected,verdict};
 results.push(row);console.log(JSON.stringify(row));writeFileSync(file('results.json'),JSON.stringify(results,null,2)+'\n');
}
writeFileSync(file('requests.json.gz'),gzipSync(JSON.stringify(requests),{mtime:0}));
