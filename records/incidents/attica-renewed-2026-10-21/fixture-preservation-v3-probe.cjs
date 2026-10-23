'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {once}=require('node:events');
const root=process.argv[2];
(async()=>{
 const fixture=require(path.join(root,'fixtures/xe-browser-server.js'));const server=fixture.server();
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try {
  const denial=await fetch(base+'/page/2?scenario=denial');
  const denialApproved=await fetch(base+'/page/2?scenario=denial',{headers:{cookie:'xe_fixture=approved'}});
  const defaultPage2Challenges=/human\s+verification/i.test(fixture.page(2));
  const normalPage2Challenges=/human\s+verification/i.test(fixture.page(2,'normal'));
  const challenge=await fetch(base+'/page/2?scenario=challenge');const body=await challenge.text();
  const requests=[], handlers=[];
  const ids=new Map([...body.matchAll(/\bid=["']([^"']+)["']/g)].map(match=>[match[1],{addEventListener:(event,callback)=>{if(event==='click')handlers.push(callback);}}]));
  const context={fetch:async url=>{requests.push(url);return{};},location:'unchanged',window:{location:{href:'unchanged'}},document:{getElementById:id=>ids.get(id)||null}};
  const inline=body.match(/onclick="([^"]*)"/)?.[1];
  if(inline)handlers.push(()=>vm.runInNewContext(inline,context,{timeout:1000}));
  for(const script of body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))vm.runInNewContext(script[1],context,{timeout:1000});
  for(const click of handlers)await click();
  await new Promise(r=>setImmediate(r));
  const handler=handlers.length>0;
  const location=context.window.location.href!=='unchanged'?context.window.location.href:context.location;
  const approved=await fetch(base+'/page/2',{headers:{cookie:'xe_fixture=approved'}});
  const approvedBody=await approved.text();
  const approvedPageHasListings=approved.status===200&&!/human\s+verification/i.test(approvedBody)&&/data-json-data/.test(approvedBody);
  const results={root,denialStatus:denial.status,denialApprovedStatus:denialApproved.status,defaultPage2Challenges,normalPage2Challenges,challengeStatus:challenge.status,approvalHandlerPresent:!!handler,syntheticHandlerRequests:requests,syntheticHandlerLocation:location,approvedPageHasListings,scope:'Synthetic HTTP and handler execution, no real DOM or human interaction'};
  console.log(JSON.stringify(results,null,2));if(process.argv.includes('--assert')&&(denial.status!==403||denialApproved.status!==403||!defaultPage2Challenges||!normalPage2Challenges||challenge.status!==200||requests[0]!=='/approve'||location!=='/page/2'||!approvedPageHasListings))process.exitCode=1;
 }finally{server.close();await once(server,'close');}
})().catch(e=>{console.error(e);process.exitCode=2;});
