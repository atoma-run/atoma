import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const entry=resolve(process.argv[2],'stock-reconcile.js');
let failed=0;
for(const name of ['crlf-error-row','aliased-output-must-not-overwrite-input','second-output-publication-failure']) {
 const d=mkdtempSync(join(tmpdir(),'warehouse-boundary-'));
 try {
  const opening='sku,onHand\nA,10\n',events='id,sku,type,quantity,ref\ne,A,RECEIVE,1,\n';
  mkdirSync(join(d,'input'));mkdirSync(join(d,'out'));
  writeFileSync(join(d,'input','stock.csv'),opening);writeFileSync(join(d,'input','events.csv'),events);
  let out='out';
  if(name==='crlf-error-row')writeFileSync(join(d,'input','events.csv'),'id,sku,type,quantity,ref\r\ne,A,RECEIVE,1,\r\nbad,A,RECEIVE,00,\r\n');
  if(name==='aliased-output-must-not-overwrite-input'){symlinkSync(join(d,'input'),join(d,'alias'),'dir');out='alias';}
  if(name==='second-output-publication-failure'){writeFileSync(join(d,'out','stock.csv'),'existing-stock\n');mkdirSync(join(d,'out','audit.json'));writeFileSync(join(d,'out','audit.json','keep'),'existing-audit-directory\n');}
  const r=spawnSync(process.execPath,[entry,'--opening','input/stock.csv','--events','input/events.csv','--out',out],{cwd:d,encoding:'utf8',timeout:10000});
  assert.ifError(r.error);assert.notEqual(r.status,0,`unexpected success; stderr=${r.stderr}`);
  assert.equal(readFileSync(join(d,'input','stock.csv'),'utf8'),opening);
  if(name==='crlf-error-row')assert.match(r.stderr,/row 3\b/);
  if(name==='second-output-publication-failure'){assert.equal(readFileSync(join(d,'out','stock.csv'),'utf8'),'existing-stock\n');assert.equal(readFileSync(join(d,'out','audit.json','keep'),'utf8'),'existing-audit-directory\n');}
  console.log(JSON.stringify({name,passed:true,exitCode:r.status,stderr:r.stderr}));
 } catch(e){failed++;console.log(JSON.stringify({name,passed:false,error:String(e)}));}
 finally{rmSync(d,{recursive:true,force:true});}
}
if(failed)process.exitCode=1;
