/** Render only local captured assets; never signs in to or drives production. */
/* global window */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../../../screenshots/demo-film-v2');
const ffmpeg=process.env.FFMPEG||'ffmpeg';
const film=JSON.parse(await readFile(path.join(out,'timeline.json'),'utf8'));
const assets={};
for(const file of ['coastal_plate.svg','attica-live.jpg','attica-chat.jpg','auralis-result.jpg','auralis-trace.jpg','pelagic-result.jpg']){
 const sub=file.endsWith('.svg')?'production':'captures';
 const bytes=await readFile(path.join(out,sub,file));
 assets[file]=`data:${file.endsWith('.svg')?'image/svg+xml':'image/jpeg'};base64,${bytes.toString('base64')}`;
}
const browser=await puppeteer.launch({headless:true,args:['--allow-file-access-from-files']});
try{
 const page=await browser.newPage();await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
 await page.goto(pathToFileURL(path.join(here,'stage.html')).href);
 await page.evaluate(async(f,a)=>window.setup(f,a),film,assets);
 await mkdir(path.join(out,'review'),{recursive:true});
 for(const [i,scene] of film.scenes.entries()){
  const jpg=await page.evaluate(t=>window.draw(t),scene.start+Math.min(3,scene.duration/2));
  await writeFile(path.join(out,'review',`${i+1}-${scene.id}.jpg`),Buffer.from(jpg,'base64'));
 }
 if(!process.argv.includes('--stills')){
 const p=spawn(ffmpeg,['-y','-loglevel','warning','-f','image2pipe','-framerate',String(film.fps),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(out,'narration.wav'),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-af','loudnorm=I=-16:TP=-1.5:LRA=11','-t',String(film.duration),'-movflags','+faststart',path.join(out,'atoma-production-v1.mp4')],{stdio:['pipe','ignore','inherit']});
 const done=once(p,'exit');p.stdin.on('error',e=>{if(e.code!=='EPIPE')throw e});
 const count=Math.ceil(film.duration*film.fps);
 for(let f=0;f<count;f++){
  const jpg=await page.evaluate(t=>window.draw(t),f/film.fps);
  if(!p.stdin.write(Buffer.from(jpg,'base64')))await once(p.stdin,'drain');
  if(f%300===0)console.log(`${f}/${count} frames`);
 }
 p.stdin.end();const [code]=await done;if(code!==0)throw Error(`ffmpeg exited ${code}`);
 console.log(`Rendered ${film.duration.toFixed(2)}s to ${out}/atoma-production-v1.mp4`);
 }
}finally{await browser.close()}
