import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const entry=resolve(process.argv[2],'stock-reconcile.js');
let failed=0;
for(const out of ['.','alias']) {
 const d=mkdtempSync(join(tmpdir(),'warehouse-valid-'));
 const opening='sku,onHand\nA,10\n',events='id,sku,type,quantity,ref\ne,A,RECEIVE,1,\n';
 let observed;
 try {
  writeFileSync(join(d,'opening.csv'),opening);writeFileSync(join(d,'events.csv'),events);
  if(out==='alias')symlinkSync(d,join(d,'alias'),'dir');
  const r=spawnSync(process.execPath,[entry,'--opening','opening.csv','--events','events.csv','--out',out],{cwd:d,encoding:'utf8',timeout:10000});
  observed={exitCode:r.status,stderr:r.stderr};assert.ifError(r.error);assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(join(d,'opening.csv'),'utf8'),opening);assert.equal(readFileSync(join(d,'events.csv'),'utf8'),events);
  assert.equal(readFileSync(join(d,'stock.csv'),'utf8'),'sku,onHand,reserved,available\nA,11,0,11\n');
  assert.equal(JSON.parse(readFileSync(join(d,'audit.json'))).applied,1);
  console.log(JSON.stringify({name:'safe-output-directory-'+out,passed:true,...observed}));
 } catch(error){failed++;console.log(JSON.stringify({name:'safe-output-directory-'+out,passed:false,...observed,error:String(error)}));}
 finally{rmSync(d,{recursive:true,force:true});}
}
if(failed)process.exitCode=1;
