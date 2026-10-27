from pathlib import Path
import json, subprocess
root=Path(__file__).resolve().parents[3]
source=root/'screenshots/demo-film-v3/captures'
out=Path(__file__).resolve().parent/'public/media'
ff='/private/tmp/atoma-demo-media/node_modules/ffmpeg-static/ffmpeg'
for name in ['runs-list','acceptance-overview','rejected','approved','app-all','app-filter','app-reload']:
 d=source/name; meta=json.loads((d/'frames.json').read_text()); f=meta['frames']; lines=[]
 for i,item in enumerate(f):
  end=f[i+1]['time'] if i+1<len(f) else meta['seconds']
  lines += [f"file '{d/item['file']}'",f"duration {max(.001,end-item['time']):.6f}"]
 lines += [f"file '{d/f[-1]['file']}'"]
 listing=d/'concat.txt'; listing.write_text('\n'.join(lines))
 subprocess.run([ff,'-y','-loglevel','error','-f','concat','-safe','0','-i',str(listing),'-vf','fps=30,scale=1920:1000:force_original_aspect_ratio=decrease,pad=1920:1000:(ow-iw)/2:(oh-ih)/2:color=0xF4F5F9','-c:v','libx264','-crf','18','-pix_fmt','yuv420p',str(out/(name+'.mp4'))],check=True)
 print(name,meta['seconds'])
