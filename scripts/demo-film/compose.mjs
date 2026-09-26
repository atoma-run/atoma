/* global window, document */
/**
 * `node scripts/demo-film/compose.mjs --frames <dir> --voice <dir> [--out film.mp4]`
 *
 * Turns the captured frames, the narration (`narrate.py` output) and the edit
 * list (`edit.mjs`) into the film. The NARRATION SETS THE PACE: each clip is a
 * list of beats — play a stretch of the shot, start a line, hold the frame
 * until the line has been said — so nothing moves on before it is explained.
 * Captions are the spoken lines themselves. The camera zooms into marked
 * regions (captures are 2x, so a 2x zoom stays pixel-sharp); highlights dim
 * their surround; clicks ripple. Every frame is painted by `compositor.html`
 * and piped to ffmpeg with the assembled narration track.
 *
 *   --stills 0,300,900   write those output frames as PNGs instead of a film
 *   --from N --to M      render only that output range, without audio
 *   --crf 16             x264 quality of the master
 *   FFMPEG=<path>        ffmpeg binary (default: `ffmpeg` on PATH)
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { CHAPTERS, EDIT } from './edit.mjs';

const W = 1920;
const H = 1080;
const MAX_ZOOM = 2.3;
const AUDIO_RATE = 24_000;
// Footage played while no line is being said (pointer travel, view changes)
// runs this much faster; anything narrated plays at its real speed.
const IDLE_SPEED = Number(process.env.DEMO_IDLE_SPEED ?? 1.7);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const framesDir = path.resolve(arg('--frames', 'screenshots/demo-film/frames'));
const voiceDir = path.resolve(arg('--voice', 'screenshots/demo-film/voice'));
const outPath = path.resolve(arg('--out', 'screenshots/demo-film/atoma-demo.mp4'));
const stills = arg('--stills', '')?.split(',').filter(Boolean).map(Number) ?? [];
const from = Number(arg('--from', '0'));
const to = arg('--to') === null ? Infinity : Number(arg('--to'));
const film = JSON.parse(await readFile(path.join(framesDir, 'film.json'), 'utf8'));
const narration = JSON.parse(await readFile(fileURLToPath(new URL('./narration.json', import.meta.url)), 'utf8'));
const voice = JSON.parse(await readFile(path.join(voiceDir, 'voice.json'), 'utf8'));
const FPS = film.fps;
const shots = Object.fromEntries(film.shots.map((shot) => [shot.name, shot]));

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A SOURCE time in shot frames: 12, 'cue', 'cue+0.5s', 'end-20'. */
function sourceTime(expr, shot) {
  if (typeof expr === 'number') return expr;
  const match = /^([A-Za-z]\w*)?\s*([+-]?\s*\d+(?:\.\d+)?)?(s)?$/.exec(String(expr).trim());
  if (!match) throw new Error(`bad time ${expr}`);
  const [, name, offset, seconds] = match;
  let base = 0;
  if (name === 'end') base = shot.frames - 1;
  else if (name) {
    if (!(name in shot.cues)) throw new Error(`shot ${shot.name} has no cue ${name}`);
    base = shot.cues[name];
  }
  return clamp(base + (offset ? Number(offset.replace(/\s/g, '')) * (seconds ? FPS : 1) : 0), 0, shot.frames - 1);
}

/**
 * A CLIP-LOCAL output frame. '@label+1s' counts from a beat's start (plus
 * '@end'); anything else is a source time, placed where the clip first shows
 * that source frame.
 */
function localTime(clip, expr) {
  const text = String(expr);
  if (text.startsWith('@')) {
    const match = /^@(\w+)\s*([+-]?\s*\d+(?:\.\d+)?)?(s)?$/.exec(text);
    if (!match) throw new Error(`bad label time ${expr}`);
    const [, label, offset, seconds] = match;
    const base = clip.labels[label];
    if (base === undefined) throw new Error(`clip ${clip.shot} has no beat label ${label}`);
    return base + (offset ? Number(offset.replace(/\s/g, '')) * (seconds ? FPS : 1) : 0);
  }
  const target = sourceTime(expr, shots[clip.shot]);
  const index = clip.map.findIndex((source) => source >= target);
  return index < 0 ? clip.map.length - 1 : index;
}

function markRect(shot, spec) {
  if (spec.rect) return spec.rect;
  const mark = shot.marks[spec.mark];
  if (!mark) throw new Error(`shot ${shot.name} has no mark ${spec.mark}`);
  return mark;
}

/** A camera target: 'full', {cx, cy, z}, or {mark|rect, pad, z?, maxZoom?}. */
function cameraOf(shot, target) {
  if (target === 'full') return { cx: W / 2, cy: H / 2, z: 1 };
  if (target.cx !== undefined) return { cx: target.cx, cy: target.cy, z: target.z ?? 1 };
  const rect = markRect(shot, target);
  const pad = target.pad ?? 60;
  const fit = Math.min(W / (rect.width + 2 * pad), H / (rect.height + 2 * pad));
  const z = clamp(target.z ?? fit, 1, target.maxZoom ?? MAX_ZOOM);
  return { cx: rect.x + rect.width / 2 + (target.dx ?? 0), cy: rect.y + rect.height / 2 + (target.dy ?? 0), z };
}

function view(cam) {
  const w = W / cam.z;
  const h = H / cam.z;
  return { x: clamp(cam.cx - w / 2, 0, W - w), y: clamp(cam.cy - h / 2, 0, H - h), w, h };
}

function cameraAt(clip, local) {
  const shot = shots[clip.shot];
  let cam = cameraOf(shot, clip.start ?? 'full');
  for (const move of clip.camera ?? []) {
    const at = localTime(clip, move.at);
    if (local < at) break;
    const dur = (move.dur ?? 1.4) * FPS;
    const next = cameraOf(shot, move.to);
    const u = ease(dur <= 0 ? 1 : (local - at) / dur);
    cam = {
      cx: cam.cx + (next.cx - cam.cx) * u,
      cy: cam.cy + (next.cy - cam.cy) * u,
      z: Math.exp(Math.log(cam.z) + (Math.log(next.z) - Math.log(cam.z)) * u),
    };
  }
  return cam;
}

const toOut = (rect, v) => ({
  x: (rect.x - v.x) * (W / v.w),
  y: (rect.y - v.y) * (H / v.h),
  w: rect.width * (W / v.w),
  h: rect.height * (H / v.h),
});

function envelope(t, fromF, toF, fade = 9) {
  if (t < fromF || t > toF) return 0;
  return clamp(Math.min((t - fromF) / fade, (toF - t) / fade), 0, 1);
}

function framePath(shot, index) {
  const file = path.join(framesDir, shot.name, `${String(Math.round(index)).padStart(4, '0')}.jpg`);
  return pathToFileURL(file).href;
}

/**
 * THE PLAN. Walk every clip's beats once, in order, on one global clock:
 * play appends source frames, say queues a line after the previous one,
 * hold repeats the current frame (for 'fit': until the queued lines end).
 */
const lines = [];
let clock = 0;
let voiceEnd = 0;
for (const clip of EDIT) {
  const shot = shots[clip.shot];
  if (!shot) throw new Error(`no shot ${clip.shot} in ${framesDir}`);
  clip.map = [];
  clip.labels = {};
  clip.startFrame = clock;
  let source = sourceTime(clip.in ?? 0, shot);
  for (const beat of clip.beats) {
    if (beat.label) clip.labels[beat.label] = clip.map.length;
    if (beat.play) {
      const [a, b] = beat.play.map((expr) => sourceTime(expr, shot));
      for (let s = a; s < b;) {
        clip.map.push(Math.round(s));
        const narrated = clock + clip.map.length < voiceEnd;
        s += beat.speed ?? (narrated ? 1 : IDLE_SPEED);
      }
      source = b;
    } else if (beat.say) {
      const entry = voice[beat.say];
      if (!entry) throw new Error(`no narration line ${beat.say} in ${voiceDir}`);
      // Breathing between lines: the next one waits `linePause` after the last.
      const gap = lines.length > 0 ? Math.round((narration.linePause ?? 0.9) * FPS) : 0;
      const start = Math.max(clock + clip.map.length + Math.round((beat.after ?? 0) * FPS), voiceEnd + gap);
      const end = start + Math.round(entry.seconds * FPS);
      const text = narration.lines[beat.say];
      lines.push({ id: beat.say, start, end, file: path.join(voiceDir, entry.file), kicker: beat.kicker ?? clip.kicker, text: text.show ?? text.say });
      voiceEnd = end;
    } else if (beat.hold !== undefined) {
      const now = clock + clip.map.length;
      const n = beat.hold === 'fit'
        ? Math.max(Math.round((beat.min ?? 0) * FPS), voiceEnd + Math.round((beat.pad ?? 0.5) * FPS) - now)
        : Math.round(beat.hold * FPS);
      for (let i = 0; i < n; i++) clip.map.push(source);
    }
  }
  if (clip.map.length === 0) clip.map.push(source);
  clip.labels.end = clip.map.length - 1;
  clock += clip.map.length;
}
const total = clock;
const chapterTotals = CHAPTERS.map((_, index) => EDIT.filter((clip) => clip.chapter === index).reduce((sum, clip) => sum + clip.map.length, 0));
console.log(`${total} output frames (${(total / FPS).toFixed(1)} s), ${lines.length} lines of narration`);
console.log(EDIT.map((clip) => `${clip.shot}@${clip.startFrame}`).join('  '));
if (process.env.DEMO_DEBUG) {
  let last = 0;
  for (const line of lines) {
    console.log(`${(line.start / FPS).toFixed(1).padStart(6)}s  gap ${((line.start - last) / FPS).toFixed(1).padStart(4)}s  ${line.id}`);
    last = line.end;
  }
  console.log(`tail ${((total - last) / FPS).toFixed(1)}s`);
}

/** Everything one clip contributes at clip-local frame `local`. */
function clipSpec(clip, local) {
  const shot = shots[clip.shot];
  const source = clip.map[clamp(local, 0, clip.map.length - 1)];
  const v = view(cameraAt(clip, local));
  const spec = { layers: [{ src: framePath(shot, source), cam: v, alpha: 1, blur: clip.blur ?? 0 }], dim: { holes: [], alpha: 0 }, highlights: [], ripples: [] };
  for (const h of clip.highlights ?? []) {
    const alpha = envelope(local, localTime(clip, h.from), localTime(clip, h.to));
    if (alpha <= 0) continue;
    const rect = markRect(shot, h);
    const pad = h.pad ?? 8;
    const out = toOut({ x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad }, v);
    if (h.dim !== false) {
      spec.dim.holes.push(out);
      spec.dim.alpha = Math.max(spec.dim.alpha, alpha);
    }
    if (h.box !== false) spec.highlights.push({ rect: out, alpha, label: h.label, labelPos: h.labelPos, color: h.color });
  }
  if (clip.ripples !== false) {
    for (const click of shot.clicks) {
      const at = clip.map.findIndex((s) => s >= click.frame);
      if (at < 0) continue;
      const u = (local - at) / 14;
      if (u < 0 || u > 1) continue;
      const p = toOut({ x: click.x, y: click.y, width: 0, height: 0 }, v);
      spec.ripples.push({ x: p.x, y: p.y, radius: 12 + 46 * ease(u), alpha: 1 - u });
    }
  }
  if (clip.card) {
    const alpha = envelope(local, localTime(clip, clip.card.from ?? 0), localTime(clip, clip.card.to ?? '@end'), 14);
    if (alpha > 0) spec.card = { ...clip.card, alpha };
  }
  return spec;
}

function clipAt(index) {
  let found = EDIT[0];
  for (const clip of EDIT) if (clip.startFrame <= index) found = clip;
  return found;
}

function outputSpec(index) {
  const clip = clipAt(index);
  const k = EDIT.indexOf(clip);
  const local = index - clip.startFrame;
  const spec = clipSpec(clip, local);
  const transition = clip.transition ?? { type: 'cut' };
  const tFrames = Math.round((transition.seconds ?? 0.5) * FPS);
  if (transition.type === 'fade' && local < tFrames && k > 0) {
    const prev = EDIT[k - 1];
    const prevSpec = clipSpec({ ...prev, highlights: [] }, prev.map.length - 1);
    const u = ease(local / tFrames);
    spec.layers = [...prevSpec.layers, ...spec.layers.map((layer) => ({ ...layer, alpha: u }))];
  }
  spec.fade = 0;
  if (transition.type === 'dip' && local < tFrames) spec.fade = 1 - ease(local / tFrames);
  const next = EDIT[k + 1];
  const left = clip.map.length - 1 - local;
  if (next?.transition?.type === 'dip') {
    const n = Math.round((next.transition.seconds ?? 0.5) * FPS);
    if (left < n) spec.fade = Math.max(spec.fade, 1 - ease(left / n));
  }
  if (clip.fadeOut) {
    const n = Math.round(clip.fadeOut * FPS);
    if (left < n) spec.fade = Math.max(spec.fade, 1 - left / n);
  }
  const line = lines.find((entry) => index >= entry.start && index <= entry.end + 6);
  if (line && clip.captions !== false) {
    const alpha = clamp(Math.min((index - line.start + 1) / 6, (line.end + 6 - index) / 6), 0, 1);
    spec.caption = { kicker: line.kicker, text: line.text, alpha, pos: clip.captionPos ?? 'bottom' };
  }
  if (clip.chapter !== undefined) {
    const before = EDIT.slice(0, k).filter((c) => c.chapter === clip.chapter).reduce((sum, c) => sum + c.map.length, 0);
    spec.chapter = { index: clip.chapter, count: CHAPTERS.length, progress: (before + local) / chapterTotals[clip.chapter], alpha: 1 };
  }
  return spec;
}

/** 16-bit mono PCM of a WAV file (walks the RIFF chunks; ffmpeg adds LIST). */
async function readPcm(file) {
  const buffer = await readFile(file);
  let offset = 12;
  while (offset < buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return new Int16Array(buffer.buffer.slice(buffer.byteOffset + offset + 8, buffer.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

async function writeNarrationTrack(file) {
  const samples = new Int16Array(Math.ceil((total / FPS) * AUDIO_RATE) + AUDIO_RATE);
  for (const line of lines) {
    const pcm = await readPcm(line.file);
    const at = Math.round((line.start / FPS) * AUDIO_RATE);
    for (let i = 0; i < pcm.length && at + i < samples.length; i++) samples[at + i] = pcm[i];
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(AUDIO_RATE, 24);
  header.writeUInt32LE(AUDIO_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  await writeFile(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

const WORKERS = Number(arg('--workers', '3'));
const browser = await puppeteer.launch({ headless: true, args: ['--allow-file-access-from-files', '--disable-web-security'] });
const compositor = fileURLToPath(new URL('./compositor.html', import.meta.url));
const pages = [];
for (let k = 0; k < WORKERS; k++) {
  const tab = await browser.newPage();
  await tab.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await tab.goto(pathToFileURL(compositor).href);
  await tab.waitForFunction(() => window.ready === true);
  pages.push(tab);
}

// Read the canvas itself: background tabs produce no compositor frames, so
// `page.screenshot` would hang on every worker but the focused one.
async function render(spec, tab, type = 'image/jpeg') {
  const url = await tab.evaluate(async (frame, mime) => {
    await window.renderFrame(frame);
    return document.getElementById('c').toDataURL(mime, 0.96);
  }, spec, type);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

try {
  if (stills.length > 0) {
    for (const index of stills) {
      const file = outPath.replace(/\.mp4$/, '') + `-still-${index}.png`;
      await writeFile(file, await render(outputSpec(index), pages[0], 'image/png'));
      console.log(file);
    }
  } else {
    const partial = from > 0 || to < total - 1;
    const track = outPath.replace(/\.mp4$/, '') + '-narration.wav';
    if (!partial) await writeNarrationTrack(track);
    const ffmpeg = spawn(process.env.FFMPEG ?? 'ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      ...(partial ? [] : ['-i', track, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k']),
      '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', arg('--crf', '16'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
    const started = Date.now();
    const last = Math.min(total - 1, to);
    // Up to one frame per page at a time, written back in order. A held
    // frame whose spec did not change is written again, not painted again.
    let previous = { key: null, jpeg: null };
    for (let base = from; base <= last;) {
      const batch = [];
      let key = previous.key;
      for (let index = base; index <= last && batch.filter((entry) => entry.fresh).length < WORKERS; index++) {
        const spec = outputSpec(index);
        const next = JSON.stringify(spec);
        batch.push({ index, spec, fresh: next !== key });
        key = next;
      }
      const fresh = batch.filter((entry) => entry.fresh);
      const painted = await Promise.all(fresh.map((entry, k) => render(entry.spec, pages[k])));
      fresh.forEach((entry, k) => { entry.jpeg = painted[k]; });
      for (const entry of batch) {
        const jpeg = entry.fresh ? entry.jpeg : previous.jpeg;
        previous = { key: entry.fresh ? JSON.stringify(entry.spec) : previous.key, jpeg };
        if (!ffmpeg.stdin.write(jpeg)) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
      }
      const next = base + batch.length;
      if (Math.floor(next / 300) > Math.floor(base / 300)) console.log(`frame ${next}/${last} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      base = next;
    }
    ffmpeg.stdin.end();
    await done;
    console.log(outPath);
  }
} finally {
  await browser.close();
}
