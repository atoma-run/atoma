"""Overlay the Remotion frame-zero cover on the approved V11 master.

Render cover.png with `remotion still src/index.tsx AtomaFilm ... --frame=0`
first. FFMPEG may point to a local installation. No timing or audio changes.
"""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'screenshots/demo-film-v12'
OUT.mkdir(exist_ok=True)
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')

def run(args):
    env = dict(os.environ)
    if (Path(FFMPEG).parent / 'libavdevice.dylib').exists():
        env['DYLD_LIBRARY_PATH'] = str(Path(FFMPEG).parent)
    subprocess.run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error', *args], check=True, env=env)

run([
    '-i', str(ROOT / 'screenshots/demo-film-v11/atoma-presentation-v11-master-4444.mov'),
    '-loop', '1', '-framerate', '30', '-t', '2.2', '-i', str(OUT / 'cover.png'),
    '-filter_complex', '[1:v]format=rgba,fade=t=out:st=1.8:d=0.4:alpha=1[cover];[0:v][cover]overlay=eof_action=pass:repeatlast=0:format=auto,format=yuv420p[v]',
    '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow',
    '-c:a', 'aac', '-b:a', '224k', '-movflags', '+faststart', str(OUT / 'atoma-presentation-v12.mp4'),
])

# GitHub Free permits media attachments below 10 MB; keep the HQ export too.
for pass_number in (1, 2):
    run([
        '-i', str(OUT / 'atoma-presentation-v12.mp4'),
        '-c:v', 'libx264', '-b:v', '265k', '-preset', 'slow', '-pix_fmt', 'yuv420p',
        '-pass', str(pass_number), '-passlogfile', str(OUT / 'github-encode'),
        *(['-an', '-f', 'mp4', os.devnull] if pass_number == 1 else
          ['-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', str(OUT / 'atoma-presentation-v12-github.mp4')]),
    ])
assert (OUT / 'atoma-presentation-v12-github.mp4').stat().st_size < 10_000_000
