from pathlib import Path
import json,subprocess
root=Path('/Users/mgtf/dev/atoma');out=root/'scripts/demo-film/remotion/public/v5';cap=root/'screenshots/demo-film-v5';ff='/private/tmp/atoma-demo-media/node_modules/ffmpeg-static/ffmpeg'
for d in (cap/'captures').iterdir():
 if not d.is_dir():continue
 m=json.loads((d/'frames.json').read_text());f=m['frames'];lines=[]
 for i,x in enumerate(f):
  end=f[i+1]['time'] if i+1<len(f) else m['seconds']
  lines += [f"file '{d/x['file']}'",f"duration {max(.001,end-x['time']):.6f}"]
 lines += [f"file '{d/f[-1]['file']}'"]
 listing=d/'concat.txt';listing.write_text('\n'.join(lines))
 subprocess.run([ff,'-y','-loglevel','error','-f','concat','-safe','0','-i',str(listing),'-vf','fps=30,scale=1920:936','-c:v','libx264','-crf','18','-pix_fmt','yuv420p',str(out/(d.name+'.mp4'))],check=True)
for name,crop in [('costs','420:430:1460:350'),('models','740:215:620:625'),('mcp-setup','716:480:620:287')]:
 subprocess.run([ff,'-y','-loglevel','error','-i',str(cap/('production-'+name+'.png')),'-vf','crop='+crop,str(out/('production-'+name+'.png'))],check=True)
print('Captured clips and production crops ready')
