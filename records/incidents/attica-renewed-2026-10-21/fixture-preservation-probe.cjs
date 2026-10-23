'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {once}=require('node:events');
const root=process.argv[2];
(async()=>{
 const fixture=require(path.join(root,'fixtures/xe-browser-server.js'));const server=fixture.server();
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try {
  const denial=await fetch(base+'/page/2?scenario=denial');
  const challenge=await fetch(base+'/page/2?scenario=challenge');const body=await challenge.text();
  const handler=body.match(/onclick="([^"]*)"/)?.[1];const requests=[];const context={fetch:async url=>{requests.push(url);return{};},location:'unchanged'};
  if(handler){vm.runInNewContext(handler,context,{timeout:1000});await new Promise(r=>setImmediate(r));}
  const results={root,denialStatus:denial.status,challengeStatus:challenge.status,approvalHandlerPresent:!!handler,syntheticHandlerRequests:requests,syntheticHandlerLocation:context.location,scope:'Synthetic HTTP and handler execution, no real DOM or human interaction'};
  console.log(JSON.stringify(results,null,2));if(process.argv.includes('--assert')&&(denial.status!==403||challenge.status!==200||requests[0]!=='/approve'||context.location!=='/page/2'))process.exitCode=1;
 }finally{server.close();await once(server,'close');}
})().catch(e=>{console.error(e);process.exitCode=2;});
