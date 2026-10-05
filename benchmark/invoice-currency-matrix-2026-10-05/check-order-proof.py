"""Check whether the final suite distinguishes credit/payment loop order; never edit the artifact."""
import hashlib,json,shutil,subprocess,sys,tempfile
from pathlib import Path
source=Path(sys.argv[1]).resolve();node=sys.argv[2]
original=(source/'invoice-reconcile.js').read_text()
start=original.index(' const credits=[];for(')
middle=original.index(' const payments=[];for(',start)
end=original.index(' return {I,payments,duplicates:',middle)
mutant=original[:start]+original[middle:end]+original[start:middle]+original[end:]
with tempfile.TemporaryDirectory(prefix='atoma-invoice-order-mutation-') as tmp:
 root=Path(tmp)
 for name in ['invoice-reconcile.js','package.json','test/invoice-reconcile.test.js']:
  dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,dest)
 (root/'invoice-reconcile.js').write_text(mutant)
 result=subprocess.run([node,str(root/'test/invoice-reconcile.test.js')],cwd=root,capture_output=True,text=True,timeout=30)
 print(json.dumps({'mutation':'Move the complete payment loop before the complete credit loop, with no other changes','originalSha256':hashlib.sha256(original.encode()).hexdigest(),'mutantSha256':hashlib.sha256(mutant.encode()).hexdigest(),'suiteExitCode':result.returncode,'mutationSurvived':result.returncode==0,'stdout':result.stdout,'stderr':result.stderr}))
assert (source/'invoice-reconcile.js').read_text()==original
