'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const root = process.argv[2];
assert(root && path.isAbsolute(root));
const { createServer } = require(path.join(root, 'dist/browser/control-server.js'));
const { AtticaStore } = require(path.join(root, 'dist/browser/attica-store.js'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = 'http://127.0.0.1:1';
const target = origin + '/page/1';
const row = id => ({id, url: origin + '/detail/' + id, type:'apartment', transaction_type:'SALE', location:'Attica', price:100000, surface:50, description:'Controlled synthetic property'});
function html(payload) { return '<!doctype html><html><body><div data-json-data="' + JSON.stringify(payload).replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '"></div></body></html>'; }
function search(empty=false) { return html({results: empty ? [] : [row('101')], selected_values:{transaction_name:'buy',selected_locations:[{geo_place_id:'fixture-place'}],pagination:{current_page:1,total_pages:1},page_url:target}}); }
const detail = id => html({results:[row(id)]});
async function scenario(mode) {
 const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(),'attica-independent-document-'));
 const stage = mode.includes('search') ? 'search' : 'detail';
 let resolved = false, override = null, currentUrl = 'about:blank', closed = false;
 const navigation = [];
 const context = {pages:()=>[page],newPage:async()=>{throw new Error('Unexpected replacement page');},route:async()=>{}};
 const page = {context:()=>context,isClosed:()=>closed,close:async()=>{closed=true;},url:()=>currentUrl,
  goto:async url=>{navigation.push(url);currentUrl=url;return {status:()=>200,headers:async()=>({}),url:()=>currentUrl};},
  content:async()=>{if(override!==null)return override; if(!resolved && (stage==='search'||currentUrl.includes('/detail/')))return '<html><body>Human verification required</body></html>';return currentUrl.includes('/detail/')?detail('101'):search();},
  locator:()=>({click:async()=>{}})};
 const session={page,context,owned:false,browser:null};
 const server=createServer({runtimeRoot,hosted:true,fixture:true,target,session,pacing:{detailDelayMs:0,pageDelayMs:0,navigationSettleMs:0}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 async function post(route,body={}) {const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const store=new AtticaStore(runtimeRoot);
 async function idle(){for(let n=0;n<400;n++){const s=await(await fetch(base+'/api/status')).json();if(!s.progress.active)return;await wait(10);}throw new Error('Collection still active');}
 try {
  assert.equal((await post('/api/start',{target,maxPages:1})).status,202);await idle();
  assert.equal(store.loadPause().pauseType,'captcha');
  assert.equal(navigation.length,stage==='search'?1:2);
  assert.equal((await post('/api/verify-access')).status,403);
  resolved=true;
  if(mode==='empty-search')override=search(true);
  if(mode==='legit-detail-brand')override=html({results:[{...row('101'),description:'Apartment near the Cloudflare office'}]});
  if(mode==='legit-detail-raw-brand')override=JSON.stringify({results:[{...row('101'),description:'Apartment near the Cloudflare office'}]});
  if(mode==='legit-detail-visible-brand')override=html({results:[{...row('101'),description:'Apartment near the Cloudflare office'}]})+'<article><p>Apartment near the Cloudflare office</p></article>';
  if(mode==='legit-detail-common-word')override=html({results:[{...row('101'),description:'A renovation challenge with an entrance turnstile'}]});
  if(mode==='legit-search-brand')override=search().replace('Controlled synthetic property','Apartment near the Cloudflare office');
  if(mode==='challenge-with-detail-metadata')override='<html><head><title>Human verification required</title></head><body><form id="challenge-form">Verify you are human</form>'+detail('101')+'</body></html>';
  if(mode==='challenge-with-search-metadata')override='<html><head><title>Human verification required</title></head><body><form id="challenge-form">Verify you are human</form>'+search()+'</body></html>';
  if(mode==='unrelated-article')override='<html><body><h1>Unrelated</h1><article>price surface</article></body></html>';
  if(mode==='marker-only')override='<html><body><div data-detail-id="101">nothing else</div></body></html>';
  if(mode==='mismatched-detail')override=detail('999');
  if(mode==='wrong-origin-with-valid-detail')currentUrl='https://unrelated.invalid/detail/101';
  const before=navigation.length;
  const verifiedDocumentUrl=currentUrl;
  const verified=await post('/api/verify-access');
  const after=navigation.length;
  const pauseAfter=store.loadPause().pauseType;
  const expected=mode.startsWith('legit-')||mode==='empty-search'?200:403;
  let resumed=null;
  if(expected===200&&verified.status===200){override=null;const response=await post('/api/resume');await idle();resumed={status:response.status,newNavigations:navigation.length-after};}
  return {mode,currentUrl:verifiedDocumentUrl,expected,status:verified.status,pauseAfter,navigationBefore:before,navigationAfter:after,resumed,pass:verified.status===expected&&before===after&&(expected===200?pauseAfter===null&&resumed?.status===202&&resumed.newNavigations>0:pauseAfter==='captcha')};
 } finally {await idle();server.close();await once(server,'close');fs.rmSync(runtimeRoot,{recursive:true,force:true});}
}
(async()=>{const results=[];for(const mode of ['legit-detail-brand','legit-detail-raw-brand','legit-detail-visible-brand','legit-detail-common-word','legit-search-brand','challenge-with-detail-metadata','challenge-with-search-metadata'])results.push(await scenario(mode));console.log(JSON.stringify({root,results},null,2));if(process.argv.includes('--assert')&&results.some(r=>!r.pass))process.exitCode=1;})().catch(e=>{console.error(e);process.exitCode=2;});
