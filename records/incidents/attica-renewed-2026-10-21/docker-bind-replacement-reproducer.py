import pathlib,tempfile,os,subprocess,json,shutil
image='atoma-worker:parent-snapshot-203fe75a'
results=[]
for mode in ['volume','mount']:
 root=pathlib.Path(tempfile.mkdtemp(prefix='docker-bind-replacement-',dir='/private/tmp'));current=root/'workspace';archive=root/'archive';current.mkdir()
 def run(name,body):
  bind=['-v',str(current)+':/workspace'] if mode=='volume' else ['--mount','type=bind,src='+str(current)+',dst=/workspace']
  a=['docker','run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--user',str(os.getuid())+':'+str(os.getgid()),'--entrypoint','node',*bind,image,'-e',"require('node:fs').writeFileSync('/workspace/"+name+"',"+json.dumps(body)+")"]
  subprocess.run(a,check=True,capture_output=True,text=True,timeout=30)
 try:
  run('before.txt','before');assert (current/'before.txt').read_text()=='before'
  current.rename(archive);current.mkdir();run('after.txt','after')
  results.append({'mode':mode,'currentFiles':sorted(p.name for p in current.iterdir()),'archiveFiles':sorted(p.name for p in archive.iterdir()),'correct':(current/'after.txt').exists() and not (archive/'after.txt').exists()})
 finally:shutil.rmtree(root)
print(json.dumps({'scope':'Plain Docker CLI with node filesystem writes; no Atoma code or tools executed','results':results},indent=2))
