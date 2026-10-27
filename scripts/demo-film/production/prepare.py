"""Build a local, replaceable guide voice and a timing/evidence manifest.
Uses macOS Daniel; no text or production data is sent to a voice service.
"""
import array, json, os, pathlib, subprocess, wave
ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / 'screenshots/demo-film-v2'
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
story = json.loads(pathlib.Path(__file__).with_name('story.json').read_text())
voice = OUT / 'voice'; voice.mkdir(exist_ok=True)
rate = 48000
track = array.array('h'); cursor = 0
for scene in story:
    stem = voice / scene['id']
    subprocess.run(['/usr/bin/say', '-v', 'Daniel', '-r', '155', '-o', str(stem)+'.aiff', scene['say']], check=True)
    subprocess.run([FFMPEG, '-loglevel','error','-y','-i',str(stem)+'.aiff','-ar',str(rate),'-ac','1',str(stem)+'.wav'],check=True)
    with wave.open(str(stem)+'.wav') as w:
        pcm=array.array('h',w.readframes(w.getnframes()))
    duration=len(pcm)/rate
    if duration < 1: raise RuntimeError("Guide voice is empty; run macOS speech outside the restricted sandbox")
    scene.update(start=cursor, voiceStart=cursor+.5, voiceDuration=duration)
    tail=4.2 if scene.get('sound') else .7
    scene['duration']=max(scene['min'],duration+.5+tail)
    total=round(scene['duration']*rate)
    segment=array.array('h',[0])*total
    segment[int(.5*rate):int(.5*rate)+len(pcm)] = pcm
    if scene.get('sound'):
        with wave.open(str(OUT/'production/welcome.wav')) as w:
            stereo=array.array('h',w.readframes(w.getnframes()))
        cue=array.array('h',((stereo[i]+stereo[i+1])//2 for i in range(0,len(stereo),2)))
        pos=round((duration+.8)*rate); segment[pos:pos+len(cue)] = cue
        scene['cueStart']=duration+.8
        scene['waveform']=[max(abs(x) for x in cue[i:i+960])/32768 for i in range(0,len(cue),960)]
    track.extend(segment); cursor+=scene['duration']
with wave.open(str(OUT/'narration.wav'),'wb') as w:
    w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(track.tobytes())
manifest={'width':1920,'height':1080,'fps':30,'duration':cursor,'voice':'macOS Daniel — temporary guide voice','captureDate':'2026-10-26','scenes':story}
(OUT/'timeline.json').write_text(json.dumps(manifest,indent=2))
def srt_time(t):
    ms=round(t*1000); return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
subs=[]
for i,s in enumerate(story):
    subs.append(f"{i+1}\n{srt_time(s['voiceStart'])} --> {srt_time(s['voiceStart']+s['voiceDuration'])}\n{s['say']}\n")
(OUT/'atoma-production.srt').write_text('\n'.join(subs))
print(f'{cursor:.2f}s; {len(story)} scenes; guide voice generated locally')
