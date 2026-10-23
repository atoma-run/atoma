import sqlite3,json,pathlib,collections,sys
run='1622e44b-8d9f-41dc-8827-a1af7cb38353'
start=int(sys.argv[1]) if len(sys.argv)>1 else 0
limit=min(int(sys.argv[2]),500) if len(sys.argv)>2 else 250
assert start>=0 and 0<limit<=500
d=sqlite3.connect('file:/home/atoma/state/atoma.db?mode=ro',uri=True);d.execute('PRAGMA query_only=ON')
r=d.execute('select status,runs_path,ended_at from project_runs where project_run_id=? and project_id=? and org_id=?',(run,'07864f7c-d8f2-4023-9fca-afd8a7a51e52','d28f40d2-14d7-45c7-bce3-928dcb0041a6')).fetchone()
assert r, 'known receipt absent'
p=pathlib.Path(r[1])/(run+'.json')
if not p.exists():
 print(json.dumps({'runId':run,'status':r[0],'endedAt':r[2],'traceAvailable':False}));d.close();raise SystemExit(0)
t=json.loads(p.read_text());assert t.get('id')==run

import re,urllib.parse
es=t.get('events',[])
assert t.get('endedAt'), 'Terminal trace required'
models=[e for e in es if e.get('kind')=='llm']
writes=[e for e in es if e.get('kind')=='tool' and e.get('name') in ('edit_file','write_file') and (e.get('result') or {}).get('ok')]
first=min(e['ts'] for e in writes)
before=[e for e in models if e.get('ts',0)+e.get('durationMs',0)<=first]
reviews=[e for e in models if e.get('role') in ('validate-plan','validate-result')]
judgments=[]
for e in reviews:
 try:v=json.loads(e.get('response',''))
 except (ValueError,TypeError):continue
 judgments.append((e,v))
negative=[e for e,v in judgments if v.get('approved') is False]
windows=[]
for e,v in judgments:
 if v.get('approved') is not False:continue
 bid=e.get('branchId');start=es.index(e)
 end=next((j for j in range(start+1,len(es)) if es[j].get('kind')=='llm' and es[j].get('role') in ('validate-plan','validate-result') and es[j].get('branchId')==bid),len(es))
 scoped=[z for z in es[start+1:end] if z.get('branchId')==bid and z.get('kind')=='llm']
 windows.append({'reviewId':e['id'],'branchId':bid,'fromIndex':start,'untilIndex':end,'sameBranchCompletedModelCalls':len(scoped),'sameBranchEquivalentUsd':sum(z.get('costUsd',0) for z in scoped),'wallMs':max(0,(es[end].get('ts',e['ts']) if end<len(es) else es[-1]['ts'])-e['ts'])})
print(json.dumps({'kind':'totals','eventCount':len(es),'completedModelCalls':len(models),'firstExplicitWriteTs':first,'completedCallsBeforeFirstWrite':len(before),'equivalentBeforeFirstWrite':sum(e.get('costUsd',0) for e in before),'reviews':len(judgments),'negativePlan':sum(e.get('role')=='validate-plan' for e in negative),'negativeResult':sum(e.get('role')=='validate-result' for e in negative),'sameBranchRetryWindows':windows,'retryCaveat':'Exclusive branch-local windows, omit descendants and in-flight calls. Wall windows may overlap parallel work. Do not sum wall time or claim cap attribution.'}))
for i,e in enumerate(es):
 if e.get('kind')!='tool':continue
 z=e.get('result') or {};a=e.get('args') or {}
 if not isinstance(z,dict):z={}
 if e.get('name') not in ('record_probe','run_shell'):continue
 lines=(str(z.get('stdout',''))+'\n'+str(z.get('stderr',''))+'\n'+str(e.get('error',''))).splitlines()
 diag=[]
 for line in lines:
  if re.search(r'authorization|bearer|access.token|api.key|cookie|password',line,re.I):continue
  if re.search(r'error TS[0-9]+|AssertionError|ERR_ASSERTION|^Error:|^TypeError:|^SyntaxError:|^ FAIL |Permission denied|not found|Tests .*passed|Test Files .*passed|expected .*(?:received|to be)| +[×✖]',line,re.I):diag.append(line[:220])
 print(json.dumps({'kind':'command','index':i,'id':e['id'],'name':e['name'],'exitCode':z.get('exitCode'),'errorPresent':bool(e.get('error') or z.get('error')),'diagnostics':diag[:6],'diagnosticsOmitted':max(0,len(diag)-6),'stdoutChars':len(str(z.get('stdout',''))),'stderrChars':len(str(z.get('stderr','')))}))
d.close()
