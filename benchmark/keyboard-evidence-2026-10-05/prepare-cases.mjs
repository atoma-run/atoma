import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ToolSandbox} from '../../src/tools/sandbox.ts';
import {startStaticServerTool,validateHtmlTool} from '../../src/tools/builtin.ts';
import {parseBrowserObservation,renderObservation} from '../../src/contracts/attestation.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'atoma-keyboard-cases-'));
const sandbox=new ToolSandbox(dir), origins=new Map();
const page='<button id="borrow" onclick="document.querySelector(\'#count\').textContent=\'1\'">Borrow</button><output id="count">0</output>';
const smoke="(() => {const checks={focused:document.activeElement.id==='borrow',borrowed:document.querySelector('#count').textContent==='1'};return {ok:Object.values(checks).every(Boolean),checks};})()";
const keyboardTask='Verify the Borrow action can be reached with the keyboard alone and activated with Enter, displaying count 1. Only this action is in scope.';
const cases=[
 {id:'click-only',task:keyboardTask,html:page,interactions:[{type:'click',selector:'#borrow'}],expected:false},
 {id:'forced-focus',task:keyboardTask,html:page.replace('<button ','<button tabindex="-1" '),interactions:[{type:'keypress',selector:'#borrow',key:'Enter'}],expected:false},
 {id:'keyboard-pass',task:keyboardTask,html:page,interactions:[{type:'keypress',key:'Tab'},{type:'keypress',key:'Enter'}],expected:true},
 {id:'keyboard-failure',task:keyboardTask,html:page.replace('<button ','<div role="button" tabindex="0" ').replace('</button>','</div>'),interactions:[{type:'keypress',key:'Tab'},{type:'keypress',key:'Enter'}],expected:false},
 {id:'click-requested',task:'Verify clicking Borrow displays count 1. Keyboard behaviour is outside this task.',html:page,interactions:[{type:'click',selector:'#borrow'}],expected:true},
 {id:'shortcut-only',task:'Verify Enter activates the already focused Borrow control and displays count 1. Keyboard navigation to the control is outside this task.',html:page.replace('<button ','<button tabindex="-1" '),interactions:[{type:'keypress',selector:'#borrow',key:'Enter'}],expected:true},
];
try{
 const {url}=await startStaticServerTool({sandbox,servedOrigins:origins}).execute({});
 const validate=validateHtmlTool({sandbox,servedOrigins:origins});
 for(const c of cases){
  writeFileSync(join(dir,'index.html'),c.html);
  c.args={url,interactions:c.interactions,smoke};
  c.result=await validate.execute(c.args);
  c.observation=parseBrowserObservation(c.args,c.result);
  if(!c.observation)throw Error('No executed observation: '+c.id);
  if(c.result.ok!==(c.id!=='keyboard-failure'))throw Error('Unexpected browser outcome '+JSON.stringify(c));
  c.line=renderObservation({eventId:c.id,tool:'validate_html',observation:c.observation});
  console.log(c.id,JSON.stringify(c.result.interactionLog),JSON.stringify(c.result.smokeResult));
 }
 writeFileSync(root+'cases.json',JSON.stringify(cases,null,2)+'\n');
}finally{await sandbox.cleanup();rmSync(dir,{recursive:true,force:true});}
