import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('.',import.meta.url));
const fixtures=JSON.parse(readFileSync(root+'fixtures.json','utf8'));
const source=fixtures['server.cjs'];
const variants=[['original',false,null],['corrected',true,null],['premium',false,["(m.type==='premium'?5:3)","(m.type==='premium'?999:3)"]],['renewal',false,['l.dueDate=add(l.dueDate,14)','l.dueDate=add(l.dueDate,13)']],['threshold',false,['fine(m)>500','fine(m)>=500']]];
const cases=[];
for(const [id,expected,mutation] of variants){
 const dir=mkdtempSync(tmpdir()+'/atoma-proof-replay-');
 try{
  for(const [path,content] of Object.entries(fixtures)){mkdirSync(dirname(dir+'/'+path),{recursive:true});writeFileSync(dir+'/'+path,content);}
  const code=mutation?source.replace(...mutation):source;
  if(mutation&&code===source)throw Error('mutation not applied');
  writeFileSync(dir+'/server.js',code);
  const files=id==='original'?['original.cjs']:['premium.cjs','renewal.cjs','threshold.cjs'];
  const run=spawnSync(process.execPath,['--test',...files],{cwd:dir,encoding:'utf8',timeout:20000});
  if(run.error)throw run.error;
  if(run.status!==(mutation?1:0))throw Error('Unexpected oracle: '+id+run.stdout+run.stderr);
  const legacy=mutation?spawnSync(process.execPath,['--test','original.cjs'],{cwd:dir,encoding:'utf8',timeout:20000}):null;
  if(legacy&&(legacy.error||legacy.status!==0))throw Error('Legacy suite should miss mutation');
  cases.push({id,expected,mutation,serverSha256:createHash('sha256').update(code).digest('hex'),files:files.map(path=>({path,content:readFileSync(dir+'/'+path,'utf8')})),helper:readFileSync(dir+'/helper.cjs','utf8'),exitCode:run.status,stdout:run.stdout,stderr:run.stderr,legacy:legacy?{exitCode:legacy.status,stdout:legacy.stdout}:null});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
if(existsSync(root+'responses.jsonl')){
 const archived=JSON.parse(readFileSync(root+'cases.json','utf8'));
 for(const c of cases){
  const old=archived.find(item=>item.id===c.id);
  if(!old||old.expected!==c.expected||old.exitCode!==c.exitCode||old.serverSha256!==c.serverSha256||JSON.stringify(old.files)!==JSON.stringify(c.files))throw Error('Fixtures differ from the measured series; preserve it and use a new directory.');
 }
 console.log('Independent fixture outcomes reproduced; measured evidence left intact.');process.exit(0);
}
writeFileSync(root+'cases.json',JSON.stringify(cases,null,2)+'\n');
const protocol={schema:2,registeredAt:new Date().toISOString(),model:'gpt-5.6-luna',repeats:3,arms:['old-evidence/old-guidance','new-evidence/old-guidance','old-evidence/new-guidance','new-evidence/new-guidance'],calls:60,scope:'Controlled reconstruction of a result validation, limited to three lending rules and their regression coverage; not a replay of the entire production run.',rules:['premium five-loan limit with available sixth copy','renewal advances existing due date exactly fourteen days','exactly 500 cents permits borrowing'],labels:cases.map(c=>({id:c.id,expected:c.expected})),oracle:'Actual Node test execution on isolated fresh data. Original suite passes all three mutants; repaired suite fails each mutant and passes original server.',padding:'120 bounded synthetic historical GET observations after source reads, followed by the actual test receipt; identical within each case across arms. This stress-tests the observed evidence-eviction failure.',decision:'Exploratory: compare false approvals, false refusals and transport/parse errors separately. No promotion from mocked tests or a tiny positive sample. No automated deployment.',ordering:'Rotate arm order across case and repeat; serial model calls, no tools, no store or trust mutation.'};
writeFileSync(root+'protocol.json',JSON.stringify(protocol,null,2)+'\n');
console.log(cases.map(c=>({id:c.id,expected:c.expected,exit:c.exitCode,legacyExit:c.legacy?.exitCode})));
