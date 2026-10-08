import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { DockerLauncher } from '../src/launcher/docker.js';
import { startPreview, teardownPreview } from '../src/preview/runtime.js';
import type { TerminalOutputPage } from '../src/contracts/previewTerminal.js';

// Explicit image selection prevents an old image from silently testing a new source tree.
const previewImage = process.env['ATOMA_TEST_PREVIEW_IMAGE'];
const runtime = process.env['CI_REQUIRE_PREVIEW_RUNTIME'] === '1' ? 'runsc' : 'runc';

it.skipIf(!previewImage)('serves CLI tests through the production launcher while denying network and source writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-terminal-container-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, '.env'), 'ATOMA_SECRET=never-copied');
  writeFileSync(join(source, 'input.json'), '{"value":21}');
  const ownerId = `terminal-test-${process.pid}`;
  const fixture = `atoma-terminal-denied-${process.pid}`;
  const launcher = new DockerLauncher({ image: 'atoma-worker:latest', previewImage,
    previewRuntime: runtime, workspaceRoot: join(root, 'copies') });
  let cursor = 0;
  let output = '';
  try {
    const running = await startPreview({ launcher, imageDigest: null, runtime,
      probe: async (port) => (await fetch(`http://127.0.0.1:${port}/`)).ok },
    { ownerId, sourceWorkspace: source, entry: '', mode: 'terminal', allowedHosts: ['example.com'] });
    const base = `http://127.0.0.1:${running.hostPort}`;
    const input = async (command: string) => {
      expect((await fetch(base + '/input', { method: 'POST', headers: { 'x-atoma-terminal': '1' }, body: command + '\r' })).status).toBe(200);
    };
    async function until(fragment: string) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const chunk = await (await fetch(`${base}/output?after=${cursor}`)).json() as TerminalOutputPage;
        cursor = chunk.cursor;
        output += Buffer.from(chunk.data, 'base64').toString('utf8');
        if (stripVTControlCharacters(output).includes(fragment)) return;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error(`Missing ${fragment}: ${output}`);
    }
    // A real, answering target on the publishable network, with a literal IP:
    // denial cannot be explained by a broken DNS lookup or an absent server.
    execFileSync('docker', ['run', '-d', '--name', fixture,
      '--network', launcher.networkName({ family: 'preview', kind: 'uplink', ownerId }),
      '--entrypoint', 'node', previewImage!, '-e',
      'require("http").createServer((q,r)=>r.end("CONTROL_PLANE")).listen(80,"0.0.0.0")'], { stdio: 'ignore' });
    const address = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', fixture], { encoding: 'utf8' }).trim();
    execFileSync('docker', ['exec', fixture, 'node', '-e',
      `fetch('http://${address}',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(await r.text()!=='CONTROL_PLANE')process.exit(1)}).catch(()=>process.exit(1))`], { stdio: 'pipe' });
    // Exercise the uploaded script rather than its echo on the PTY.
    const script = `const fs=require('fs'); (async()=>{let readonly=false,denied=false;try{fs.writeFileSync('/workspace/mutated','x')}catch{readonly=true}try{await fetch('http://${address}',{signal:AbortSignal.timeout(1500)})}catch{denied=true}const secret=fs.existsSync('/workspace/.env');console.log('PROOF_'+JSON.stringify({readonly,denied,secret,value:JSON.parse(fs.readFileSync('input.json')).value*2}))})()`;
    expect((await fetch(base + '/upload?name=check.cjs', { method: 'POST', headers: { 'x-atoma-terminal': '1' }, body: script })).status).toBe(200);
    await input('node check.cjs');
    await until('PROOF_{"readonly":true,"denied":true,"secret":false,"value":42}');
    await input("printf 'changed' > input.json; printf '\\nMUTATED:%s\\n' \"$(cat input.json)\"");
    await until('MUTATED:changed');
    expect(readFileSync(join(source, 'input.json'), 'utf8')).toBe('{"value":21}');
    const container = JSON.parse(execFileSync('docker', ['inspect', launcher.unitName('preview-app', ownerId)], { encoding: 'utf8' }))[0] as { HostConfig: { Runtime: string }; Mounts: Array<{ Destination: string; RW: boolean }> };
    expect(container.HostConfig.Runtime).toBe(runtime);
    expect(container.Mounts.find((mount) => mount.Destination === '/workspace')?.RW).toBe(false);
    execFileSync('docker', ['rm', '-f', fixture], { stdio: 'ignore' });
    await teardownPreview({ launcher }, ownerId, {});
    const reset = await startPreview({ launcher, imageDigest: null, runtime,
      probe: async (port) => (await fetch(`http://127.0.0.1:${port}/`)).ok },
    { ownerId, sourceWorkspace: source, entry: '', mode: 'terminal', allowedHosts: [] });
    expect((await fetch(`http://127.0.0.1:${reset.hostPort}/input`, { method: 'POST',
      headers: { 'x-atoma-terminal': '1' }, body: 'cat input.json\r' })).status).toBe(200);
    let resetOutput = '';
    let resetCursor = 0;
    for (let attempt = 0; attempt < 100 && !resetOutput.includes('{"value":21}'); attempt++) {
      const chunk = await (await fetch(`http://127.0.0.1:${reset.hostPort}/output?after=${resetCursor}`)).json() as TerminalOutputPage;
      resetCursor = chunk.cursor;
      resetOutput += Buffer.from(chunk.data, 'base64').toString('utf8');
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(resetOutput).toContain('{"value":21}');
  } finally {
    try { execFileSync('docker', ['rm', '-f', fixture], { stdio: 'ignore' }); } catch { /* absent */ }
    await teardownPreview({ launcher }, ownerId, {});
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
