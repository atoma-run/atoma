"""Post-run checks motivated by source inspection; not part of the frozen 64-case score."""
import copy,json,subprocess,sys,tempfile
from pathlib import Path
entry=Path(sys.argv[1]).resolve()/'invoice-reconcile.js'
base={'invoices':[{'id':'I','currency':'EUR','lines':[{'quantity':1,'unitPrice':'1.000'}],'taxBps':0}],'credits':[],'payments':[]}
cases=[]
x=copy.deepcopy(base);x['invoices'][0]['currency']=['EUR'];cases.append(('invoice-currency-array',x,False))
x=copy.deepcopy(base);x['payments']=[{'id':'P','currency':['EUR'],'amount':'1.00','allocations':[]}];cases.append(('payment-currency-array',x,False))
x=copy.deepcopy(base);x['invoices'][0]['lines'][0]['unitPrice']='1.000\n';cases.append(('unit-price-final-newline',x,False))
x=copy.deepcopy(base);x['payments']=[{'id':'P','currency':'EUR','amount':'1.0\n','allocations':[]}];cases.append(('payment-final-newline',x,False))
x=copy.deepcopy(base);x['invoices'][0]['currency']='JPY';x['payments']=[{'id':'P','currency':'JPY','amount':'1\n','allocations':[]}];cases.append(('jpy-payment-final-newline',x,False))
cases.append(('valid-canonical-decimal-control',base,True))
failed=0
for name,data,valid in cases:
 with tempfile.TemporaryDirectory(prefix='atoma-invoice-exploratory-') as d:
  p=Path(d);original=json.dumps(data);(p/'in.json').write_text(original);(p/'out.json').write_text('KEEP')
  r=subprocess.run([sys.argv[2],str(entry),'--input',str(p/'in.json'),'--out',str(p/'out.json')],capture_output=True,text=True,timeout=10)
  output=(p/'out.json').read_text();passed=(r.returncode==0)==valid and (p/'in.json').read_text()==original
  if not valid:passed=passed and output=='KEEP' and bool(r.stderr.strip())
  else:passed=passed and json.loads(output)['invoices'][0]['total']=='1.00'
  failed+=not passed
  print(json.dumps(dict(name=name,passed=passed,expectedSuccess=valid,exitCode=r.returncode,output=output,stderr=r.stderr)))
sys.exit(1 if failed else 0)
