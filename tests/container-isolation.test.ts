import { deepenBackend } from '../src/run/deepenBackend.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { ContainerToolExecutor, workerRunArgs } from '../src/tools/containerExecutor.js';
import { containerToolBackend } from '../src/run/toolBackend.js';
import { egressObjectId } from '../src/tools/egressSidecar.js';
import { drainLines, encodeMessage, isWorkerHello } from '../src/tools/containerProtocol.js';
import { HOST_REPLAY_ARG } from '../src/contracts/inheritedChecks.js';
import { assertCheckpointWorkerAbsent } from '../src/launcher/checkpointRecovery.js';
import { WORKER_PIDS_LIMIT } from '../src/launcher/workerProfile.js';
import { OUTSIDE_THE_COPY_FILES, OUTSIDE_THE_COPY_SUITE, OUTSIDE_THE_COPY_TESTS } from './helpers/outsideTheCopy.js';
import { randomUUID } from 'node:crypto';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { captureReadRunCopies, checkReadRunCopies, materialiseReadRuns, type ReadRunCopyIdentities } from '../src/run/readRuns.js';
import { readRunCopyIntact, readRunCopyPath, type ReadRunsIndex } from '../src/contracts/readRuns.js';

/**
 * The isolation primitive, proven against a real container.
 *
 * `run_shell`'s child is spawned with `cwd` and nothing more, so in a single
 * process the atom registry, every skill body and the ledger are one
 * filesystem walk from model-authored code — reproduced earlier as
 * `ls ../../atoma.db ../../skills` listing all of them. Moving the tool
 * layer into a container with only the workspace mounted and no route out is
 * what makes that walk find nothing.
 *
 * These tests DRIVE THE REAL THING: a built image, a real `docker run`, real
 * tool calls over the stdio protocol. A mocked version would prove nothing —
 * the claim under test is a property of the container, not of our code.
 *
 * Skipped (not failed) when Docker or the image is missing: a contributor
 * without Docker still gets a green suite, and CI gets the guarantee.
 */

function dockerReady(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'atoma-worker:latest'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerReady();
if (process.env['CI_REQUIRE_DOCKER'] === '1' && !HAVE_DOCKER) {
  throw new Error('CI worker job requires Docker and a freshly built atoma-worker:latest image');
}
const describeDocker = HAVE_DOCKER ? describe : describe.skip;

describeDocker('container depth transition', () => {
  it('verifies a recorded worker identity against the real engine before and after SIGKILL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-container-recovery-'));
    const backend = await containerToolBackend({ workspaceRoot: join(root, 'workspace') });
    try {
      await backend.executor.execute('write_file', { path: 'saved.txt', content: 'before crash' });
      const receipt = backend.checkpointWorker!()!;
      await expect(assertCheckpointWorkerAbsent(receipt)).rejects.toThrow('still exists');
      execFileSync('docker', ['kill', '--signal=KILL', `atoma-worker-${receipt.id}`], { stdio: 'ignore' });
      await vi.waitFor(async () => { await assertCheckpointWorkerAbsent(receipt); }, { timeout: 10000 });
      expect(readFileSync(join(root, 'workspace', 'saved.txt'), 'utf8')).toBe('before crash');
    } finally {
      await backend.drain!();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('removes a SIGTERM-resistant worker before replacing its backend over the sealed workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-container-depth-'));
    const workspace = join(root, 'workspace');
    const backend = await containerToolBackend({ workspaceRoot: workspace });
    let replacement: Awaited<ReturnType<typeof containerToolBackend>> | undefined;
    try {
      await backend.executor.execute('write_file', { path: 'server.cjs', content:
        "const fs=require('node:fs');const http=require('node:http');process.on('SIGTERM',()=>{});" +
        "fs.writeFileSync('heartbeat','ready');setInterval(()=>fs.appendFileSync('heartbeat','.'),10);" +
        "const s=http.createServer((q,r)=>r.end('old'));s.listen(0,'127.0.0.1',()=>console.log('LISTENING_ON_PORT='+s.address().port));" });
      await backend.executor.execute('start_node_server', { entry: 'server.cjs' });
      replacement = await deepenBackend({ backend, workspace: localWorkspaceRuntime({ root: workspace, log: () => undefined }),
        signal: new AbortController().signal, create: () => containerToolBackend({ workspaceRoot: workspace }) });
      const stoppedHeartbeat = readFileSync(join(workspace, 'heartbeat'), 'utf8');
      await replacement.executor.execute('write_file', { path: 'fresh.txt', content: 'second attempt' });
      expect(readFileSync(join(workspace, 'fresh.txt'), 'utf8')).toBe('second attempt');
      expect(readFileSync(join(workspace, 'heartbeat'), 'utf8')).toBe(stoppedHeartbeat);
      await expect(backend.executor.execute('write_file', { path: 'stale.txt', content: 'old' })).rejects.toThrow('drained');
    } finally {
      await replacement?.drain?.();
      await backend.drain?.();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('workerRunArgs — the isolation is in the flags, so assert them', () => {
  const args = workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws' });

  it('gives the container no route out', () => {
    // The network half of invariant T1. Loopback survives (verified live), so
    // start_node_server + fetch_url still work against the run's own server.
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });

  it('mounts the workspace and nothing else', () => {
    const mounts = args.filter((a, i) => args[i - 1] === '-v');
    expect(mounts).toEqual(['/host/ws:/workspace']);
  });

  it('drops capabilities and forbids regaining privilege', () => {
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('can match the non-root host uid so the bind mount stays writable', () => {
    const a = workerRunArgs({
      image: 'img',
      workspaceHostPath: '/host/ws',
      user: '1001:1001',
    });
    expect(a[a.indexOf('--user') + 1]).toBe('1001:1001');
    expect(a).toContain('HOME=/tmp/atoma-home');
    expect(a).not.toContain('0:0');
  });

  it('mounts the read-run copies read-only, with --mount, only when asked', () => {
    expect(args.filter(a => a === '--mount')).toEqual([]);
    const bind = workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws', readOnlyRunCopiesSource: '/real/ws/.atoma-runs' });
    expect(bind.filter((_a, i) => bind[i - 1] === '--mount')).toEqual(['type=bind,src=/real/ws/.atoma-runs,dst=/workspace/.atoma-runs,readonly']);
    expect(bind.filter((_a, i) => bind[i - 1] === '-v')).toEqual(['/host/ws:/workspace']);
    const volume = workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws', workspaceVolume: 'vol', readOnlyRunCopiesSource: '/real/ws/.atoma-runs' });
    expect(volume.filter((_a, i) => volume[i - 1] === '--mount')).toEqual(['type=volume,src=vol,dst=/workspace,volume-nocopy',
      'type=volume,src=vol,dst=/workspace/.atoma-runs,volume-subpath=.atoma-runs,readonly,volume-nocopy']);
    expect(volume).not.toContain('-v');
    expect(() => workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws', readOnlyRunCopiesSource: '/a,b/.atoma-runs' })).toThrow('mount option');
  });

  it('bounds memory and cpu', () => {
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
  });

  it('bounds tasks with ONE limit for hosted and Compute workers (run 40c20c5d)', () => {
    // Real-container proof that it fits concurrent browsers, and that the
    // former 256 did not: tests/worker-thread-headroom.test.ts.
    const machineId = '0b0c8f8e-6f1e-4b8f-9d61-2f7e1c3a5b10';
    const compute = workerRunArgs({ image: 'img', workspaceHostPath: '/x', workspaceVolume: `atoma-compute-${machineId}-workspace`,
      volumeSubpath: 'current', computeMachineId: machineId });
    for (const a of [args, compute]) {
      expect(a.filter((x) => x === '--pids-limit')).toHaveLength(1);
      expect(a[a.indexOf('--pids-limit') + 1]).toBe(WORKER_PIDS_LIMIT);
    }
    expect(Number(WORKER_PIDS_LIMIT)).toBeGreaterThanOrEqual(2048);
  });

  it('EGRESS MODE swaps none for the internal network and points HTTP_PROXY at the one peer', () => {
    const a = workerRunArgs({
      image: 'img',
      workspaceHostPath: '/host/ws',
      egress: { network: 'atoma-run-net', proxyHost: 'atoma-proxy', proxyPort: 3128 },
    });
    expect(a[a.indexOf('--network') + 1]).toBe('atoma-run-net');
    const env = a.filter((_x, i) => a[i - 1] === '-e');
    expect(env).toContain('HTTP_PROXY=http://atoma-proxy:3128');
    expect(env).toContain('npm_config_https_proxy=http://atoma-proxy:3128');
    expect(env).toContain('NO_PROXY=127.0.0.1,localhost,::1');
    expect(env).toContain('no_proxy=127.0.0.1,localhost,::1');
    expect(env).toContain('NODE_USE_ENV_PROXY=1');
    // Still only the workspace, still no capabilities: egress widens the
    // network and nothing else.
    expect(a.filter((_x, i) => a[i - 1] === '-v')).toEqual(['/host/ws:/workspace']);
    expect(a[a.indexOf('--cap-drop') + 1]).toBe('ALL');
  });

  it('egress mode is OPT-IN — the default is still no network at all', () => {
    const a = workerRunArgs({ image: 'img', workspaceHostPath: '/host/ws' });
    expect(a[a.indexOf('--network') + 1]).toBe('none');
    expect(a.join(' ')).not.toContain('HTTP_PROXY');
  });

  it('never passes --privileged or mounts the docker socket', () => {
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('docker.sock');
  });
});

describe('drainLines — a tool result can span chunks', () => {
  it('reassembles across arbitrary chunk boundaries', () => {
    const whole = encodeMessage({ id: 1, ok: true, result: { a: 'x'.repeat(50) } });
    let buf = '';
    const got: unknown[] = [];
    for (const ch of whole.match(/[\s\S]{1,7}/g) ?? []) {
      buf += ch;
      const { messages, rest } = drainLines(buf);
      buf = rest;
      got.push(...messages);
    }
    expect(got).toHaveLength(1);
    expect((got[0] as { result: { a: string } }).result.a).toHaveLength(50);
  });

  it('drops a non-JSON line instead of throwing', () => {
    const { messages } = drainLines('garbage from some dependency\n{"id":2,"ok":true}\n');
    expect(messages).toHaveLength(1);
    expect(isWorkerHello(messages[0])).toBe(false);
  });
});

describeDocker('a containerised run cannot reach the stores', () => {
  let dir: string;
  let workspace: string;
  let exec: ContainerToolExecutor;

  beforeAll(async () => {
    // Mimic the real layout: a workspace with the stores as SIBLINGS, i.e.
    // exactly the shape that leaks in-process.
    dir = mkdtempSync(join(tmpdir(), 'atoma-container-'));
    workspace = join(dir, 'ws');
    writeFileSync(join(dir, 'atoma.db'), 'TENANT_REGISTRY_SECRET');
    writeFileSync(join(dir, 'atoma-ledger.jsonl'), 'TENANT_LEDGER_SECRET');
    mkdirSync(join(dir, 'skills', 'Methane'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'Methane', 'SKILL.md'), 'TENANT_SKILL_SECRET');
    mkdirSync(workspace, { recursive: true });
    exec = new ContainerToolExecutor({ workspaceHostPath: workspace, startTimeoutMs: 90_000 });
    await exec.start();
  }, 120_000);

  afterAll(() => {
    exec?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('announces its tools', () => {
    const names = exec.toolDeclarations().map((t) => t.name);
    expect(names).toContain('write_file');
    expect(names).toContain('run_shell');
    expect(exec.has('read_file')).toBe(true);
    expect(exec.has('no_such_tool')).toBe(false);
  });

  it('does real work inside the workspace', async () => {
    await exec.execute('write_file', { path: 'hello.txt', content: 'from the container' });
    const read = (await exec.execute('read_file', { path: 'hello.txt' })) as { content?: string };
    expect(read.content).toContain('from the container');
    // …and it landed on the HOST, through the mount.
    expect(readFileSync(join(workspace, 'hello.txt'), 'utf8')).toContain('from the container');
  }, 60_000);

  it('records probe output through the worker contract at runtime', async () => {
    await exec.execute('write_file', {
      path: 'probe.js',
      content: "console.log('CONTAINER_PROBE_OK');",
    });
    const result = (await exec.execute('record_probe', { cmd: 'node probe.js' })) as {
      recorded?: boolean;
      stdout?: string;
    };
    expect(result.recorded).toBe(true);
    expect(result.stdout).toContain('CONTAINER_PROBE_OK');
    const manifest = JSON.parse(readFileSync(join(workspace, '.atoma-probes.json'), 'utf8')) as {
      entries: Array<{ cmd: string; stdout?: string }>;
    };
    expect(manifest.entries[0]).toMatchObject({
      cmd: 'node probe.js',
      stdout: 'CONTAINER_PROBE_OK\n',
    });
    await exec.execute('write_file', {
      path: 'probe-fixed.js',
      content: "console.log('CONTAINER_PROBE_FIXED');",
    });
    const replaced = (await exec.execute('record_probe', {
      cmd: 'node probe-fixed.js',
      supersedes: 'node probe.js',
    })) as { superseded?: string };
    expect(replaced.superseded).toBe('node probe.js');
    const after = JSON.parse(
      readFileSync(join(workspace, '.atoma-probes.json'), 'utf8')
    ) as { entries: Array<{ cmd: string; stdout?: string }> };
    expect(after.entries).toEqual([
      expect.objectContaining({
        cmd: 'node probe-fixed.js',
        stdout: 'CONTAINER_PROBE_FIXED\n',
      }),
    ]);
  }, 60_000);

  it('CANNOT read the sibling stores — the walk that works in-process', async () => {
    const r = (await exec.execute('run_shell', {
      command: 'ls',
      args: ['-1', '../atoma.db', '../skills'],
    })) as { stdout?: string; stderr?: string };
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).not.toContain('TENANT');
    expect(out.toLowerCase()).toMatch(/no such file|cannot access|not found/);
  }, 60_000);

  it('CANNOT read them via an absolute host path either', async () => {
    const r = (await exec.execute('run_shell', {
      command: 'cat',
      args: [join(dir, 'atoma.db')],
    })) as { stdout?: string; stderr?: string };
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).not.toContain('TENANT_REGISTRY_SECRET');
  }, 60_000);

  it('CANNOT reach the control plane over the network', async () => {
    // The other half of T1: a run that could POST to the viz could launch
    // runs, and a run that could reach the internet could exfiltrate.
    const r = (await exec.execute('run_shell', {
      command: 'bash',
      args: ['-c', 'getent hosts host.docker.internal || echo UNRESOLVABLE'],
    })) as { stdout?: string };
    expect(r.stdout ?? '').toContain('UNRESOLVABLE');
  }, 60_000);

  it('CAN still serve and probe its OWN loopback — the http bucket survives', async () => {
    // The property that makes --network none acceptable rather than
    // crippling: verification of an HTTP deliverable happens inside.
    await exec.execute('write_file', {
      path: 'server.js',
      content: [
        "const http = require('http');",
        'const s = http.createServer((q, r) => r.end(JSON.stringify({ ok: true })));',
        's.listen(0, "127.0.0.1", () => console.log("LISTENING_ON_PORT=" + s.address().port));',
      ].join('\n'),
    });
    const started = (await exec.execute('start_node_server', { entry: 'server.js' })) as {
      ok?: boolean;
      url?: string;
    };
    expect(started.ok, `server did not boot: ${JSON.stringify(started)}`).toBe(true);
    const probed = (await exec.execute('fetch_url', { url: started.url })) as {
      status?: number;
      body?: string;
    };
    expect(probed.status).toBe(200);
    expect(probed.body).toContain('"ok":true');
  }, 90_000);

  it('replays an inherited check in the host mode, on the worker image\'s own browser', async () => {
    // docs/decisions/inherited-checks-replay-2026-10-01.md: the worker drives Debian's
    // chromium, not Puppeteer's Chrome, and root acceptance depends on its
    // host mode: the smoke's verdict, a throw, the status, the dead proxy.
    await exec.execute('write_file', { path: 'replay.html', content: '<!doctype html><title>t</title><p id="mode">Long break</p>' });
    await exec.execute('write_file', { path: 'ws-server.js', content: [
      "const http = require('http'); const fs = require('fs');",
      "const s = http.createServer((q, r) => r.end('x'));",
      "s.on('upgrade', (q, socket) => { fs.writeFileSync('upgraded-' + q.url.replace(/[^a-z]/g, '') + '.txt', 'yes'); socket.destroy(); });",
      "s.listen(0, '127.0.0.1', () => console.log('LISTENING_ON_PORT=' + s.address().port));",
    ].join('\n') });
    const stranger = (await exec.execute('start_node_server', { entry: 'ws-server.js' })) as { ok?: boolean; url?: string };
    expect(stranger.ok, JSON.stringify(stranger)).toBe(true);
    const strangerPort = new URL(stranger.url!).port;
    const served = (await exec.execute('start_static_server', {})) as { url: string };
    const page = `${served.url.replace(/\/$/, '')}/replay.html`;
    const replay = (smoke: string, url = page) =>
      exec.execute('validate_html', { url, smoke, [HOST_REPLAY_ARG]: true }) as Promise<Record<string, unknown>>;
    expect(await replay("(() => ({ ok: document.getElementById('mode').textContent === 'Long break' }))()"))
      .toMatchObject({ smokeOk: true, smokeThrew: false, httpStatus: 200, document: { path: 'replay.html' } });
    expect(await replay('(() => window.__timer.mode)()')).toMatchObject({ smokeOk: false, smokeThrew: true });
    expect(await replay('(() => ({ ok: true }))()', page.replace('replay.html', 'gone.html'))).toMatchObject({ httpStatus: 404 });
    // The server destroys every upgraded socket, so the page sees an error
    // either way: only the file the upgrade writes tells reached from refused.
    const socketSmoke = (path: string) => `(async () => {
      const own = await fetch('/replay.html').then((r) => r.ok, () => false);
      const socket = await new Promise((resolve) => {
        try { const ws = new WebSocket('ws://127.0.0.1:${strangerPort}/${path}'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); setTimeout(() => resolve('timeout'), 3000); }
        catch (e) { resolve('threw'); }
      });
      return { ok: own && socket !== 'open', own, socket };
    })()`;
    // The control: a molecule's own call reaches the stranger port.
    const reached = await exec.execute('validate_html', { url: page, smoke: socketSmoke('control') });
    expect(existsSync(join(workspace, 'upgraded-control.txt')), JSON.stringify(reached)).toBe(true);
    // The host mode's dead proxy refuses it.
    const confined = await replay(socketSmoke('replay'));
    expect(confined['smokeOk'], JSON.stringify(confined['smokeResult'])).toBe(true);
    expect(existsSync(join(workspace, 'upgraded-replay.txt'))).toBe(false);
  }, 120_000);

  it('keeps HTTP loopback working when proxied egress is enabled', async () => {
    const egressWorkspace = join(dir, 'egress-ws');
    mkdirSync(egressWorkspace, { recursive: true });
    const runId = `test-loopback-${process.pid}`;
    const assetServer = `atoma-network-fixture-${process.pid}`;
    const backend = await containerToolBackend({
      workspaceRoot: egressWorkspace,
      egress: true,
      runId,
      egressAllowlist: ['registry.npmjs.org', 'assets.atoma-test.invalid'],
    });
    try {
      // A separate origin on the proxy's uplink: the worker cannot reach it
      // directly. This exercises the real container boundary without a CDN.
      execFileSync('docker', [
        'run', '-d', '--rm', '--name', assetServer,
        '--network', `atoma-uplink-${egressObjectId(runId)}`,
        '--network-alias', 'assets.atoma-test.invalid',
        'atoma-worker:latest', 'node', '-e',
        'require("http").createServer((q,r)=>{r.setHeader("content-type","text/css");r.end("body{--external-asset:loaded}")}).listen(80,"0.0.0.0",()=>console.log("READY"))',
      ], { stdio: 'ignore' });
      await vi.waitFor(() => expect(execFileSync('docker', ['logs', assetServer], { encoding: 'utf8' })).toContain('READY'));
      await backend.executor.execute('write_file', {
        path: 'server.js',
        content: [
          "const http = require('http');",
          "const s = http.createServer((_q, r) => r.end('EGRESS_LOOPBACK_OK'));",
          's.listen(0, "127.0.0.1", () => console.log("LISTENING_ON_PORT=" + s.address().port));',
        ].join('\n'),
      });
      const started = (await backend.executor.execute('start_node_server', {
        entry: 'server.js',
      })) as { url?: string };
      const probed = (await backend.executor.execute('fetch_url', {
        url: started.url,
      })) as { status?: number; body?: string };
      expect(probed.status).toBe(200);
      expect(probed.body).toContain('EGRESS_LOOPBACK_OK');
      const external = (await backend.executor.execute('fetch_url', {
        url: 'https://registry.npmjs.org/left-pad/latest',
        timeoutMs: 20_000,
      })) as { status?: number; body?: string; error?: string };
      expect(external.status, JSON.stringify(external)).toBe(200);
      expect(external.body).toContain('"name":"left-pad"');
      await backend.executor.execute('write_file', {
        path: 'index.html',
        content: '<link rel="stylesheet" href="http://assets.atoma-test.invalid/style.css"><p>Network preview</p>',
      });
      const staticSite = await backend.executor.execute('start_static_server', {}) as { url: string };
      const browser = await backend.executor.execute('validate_html', {
        url: staticSite.url, waitMs: 100,
        smoke: '({ok: getComputedStyle(document.body).getPropertyValue("--external-asset").trim() === "loaded"})',
      });
      expect(browser).toMatchObject({ ok: true, failedRequests: [], smokeResult: { ok: true } });
      const denied = await backend.executor.execute('fetch_url', {
        url: 'http://host.docker.internal:4111/api/runs', timeoutMs: 3000,
      }) as { status?: number; ok?: boolean; error?: string };
      // Node's env proxy uses CONNECT; a proxy refusal is a fetch error.
      expect(denied).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      try { execFileSync('docker', ['rm', '-f', assetServer], { stdio: 'ignore' }); } catch { /* never started */ }
      await backend.cleanup();
    }
  }, 120_000);

  it('opens public Internet egress without exposing the private proxy network', async () => {
    const workspaceRoot = join(dir, 'public-egress-ws');
    mkdirSync(workspaceRoot, { recursive: true });
    const runId = `test-public-${process.pid}`;
    const fixture = `atoma-private-fixture-${process.pid}`;
    const backend = await containerToolBackend({ workspaceRoot, egress: true, runId, egressAllowlist: ['*'] });
    try {
      execFileSync('docker', [
        'run', '-d', '--rm', '--name', fixture,
        '--network', `atoma-uplink-${egressObjectId(runId)}`,
        '--network-alias', 'private.atoma-test.invalid',
        'atoma-worker:latest', 'node', '-e',
        'require("http").createServer((q,r)=>r.end("PRIVATE_SECRET")).listen(4111,"0.0.0.0",()=>console.log("READY"))',
      ], { stdio: 'ignore' });
      await vi.waitFor(() => expect(execFileSync('docker', ['logs', fixture], { encoding: 'utf8' })).toContain('READY'));
      // Not a destination on the default allowlist. This traverses the real
      // worker, env proxy, CONNECT policy, DNS guard and pinned upstream socket.
      const external = await backend.executor.execute('fetch_url', {
        url: 'https://example.com/', timeoutMs: 20_000,
      }) as { status?: number; body?: string };
      expect(external.status, JSON.stringify(external)).toBe(200);
      expect(external.body).toContain('Example Domain');
      const denied = await backend.executor.execute('fetch_url', {
        url: 'http://private.atoma-test.invalid:4111/secret', timeoutMs: 5000,
      });
      expect(denied).toMatchObject({ ok: false, error: expect.any(String) });
      expect(JSON.stringify(denied)).not.toContain('PRIVATE_SECRET');
    } finally {
      try { execFileSync('docker', ['rm', '-f', fixture], { stdio: 'ignore' }); } catch { /* never started */ }
      await backend.drain?.();
    }
  }, 120_000);
});

// docs/decisions/read-runs-2026-10-17.md: the host copies another run's saved
// files into the workspace before the worker starts, each with its saved mode.
// The worker reads the copy and restores from it with its own cp (GNU cp, which
// gives a new file its source's bits); a write to the copy is detected by the
// host, not prevented; and nothing but the workspace is reachable: not the
// other run's directory, not by its host path. Run locally against an
// isolated tag through ATOMA_TEST_ACCEPTANCE_IMAGE.
describeDocker('a read-run copy in a containerised run', () => {
  let dir: string;
  let other: string;
  let workspace: string;
  let exec: ContainerToolExecutor;
  let index: ReadRunsIndex;
  let identities: ReadRunCopyIdentities;
  const runId = '50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a';
  const copy = readRunCopyPath(runId);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-container-read-runs-'));
    other = join(dir, 'other-run', 'workspace');
    mkdirSync(join(other, 'browser'), { recursive: true });
    mkdirSync(join(other, 'bin'), { recursive: true });
    writeFileSync(join(other, 'browser', 'collect.js'), 'SAVED_BYTES_OF_THE_OTHER_RUN');
    writeFileSync(join(other, 'bin', 'run.sh'), '#!/bin/sh\necho SAVED_SCRIPT_RAN\n', { mode: 0o755 });
    // Beside the saved files, and never in a manifest: never copied, never reachable.
    writeFileSync(join(other, '.env'), 'OTHER_RUN_UNSAVED_SECRET');
    const { manifest, hash } = buildWorkspaceArtifactManifest({ workspaceRoot: other });
    workspace = join(dir, 'ws');
    index = { version: 1, orgId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
      readRuns: [{ runId, status: 'delivered', endedAt: new Date().toISOString(), workspacePath: other, manifestHash: hash, manifest }] };
    materialiseReadRuns(workspace, index);
    exec = new ContainerToolExecutor({ workspaceHostPath: workspace, startTimeoutMs: 90_000, readOnlyRunCopies: true,
      image: process.env['ATOMA_TEST_ACCEPTANCE_IMAGE'] ?? 'atoma-worker:latest' });
    await exec.start();
    // Taken once the worker mounted them, as the runner does: Docker Desktop moves the source's ctime at start.
    identities = captureReadRunCopies(workspace, index);
  }, 120_000);

  // Removal follows the engine-confirmed drain: Docker Desktop refuses to
  // remove a mount source while its worker lives.
  afterAll(async () => {
    await exec?.drain();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the copy, each file with its saved mode', async () => {
    const read = (await exec.execute('read_file', { path: `${copy}/browser/collect.js` })) as { content?: string };
    expect(read.content).toContain('SAVED_BYTES_OF_THE_OTHER_RUN');
    const listed = (await exec.execute('run_shell', { command: 'ls', args: ['-l', `${copy}/browser/collect.js`, `${copy}/bin/run.sh`] })) as { stdout?: string };
    expect(listed.stdout ?? '').toMatch(/^-rwxr-xr-x .*bin\/run\.sh$/m);
    expect(listed.stdout ?? '').toMatch(/^-rw-r--r-- .*browser\/collect\.js$/m);
  }, 60_000);

  it('restores from it with the worker\'s cp: a writable file, executable where the run saved one', async () => {
    await exec.execute('run_shell', { command: 'mkdir', args: ['-p', 'browser', 'bin'] });
    for (const path of ['browser/collect.js', 'bin/run.sh']) {
      expect(await exec.execute('run_shell', { command: 'cp', args: [`${copy}/${path}`, path] })).toMatchObject({ exitCode: 0 });
    }
    expect(await exec.execute('run_shell', { command: 'bash', args: ['-c', './bin/run.sh'] })).toMatchObject({ exitCode: 0, stdout: 'SAVED_SCRIPT_RAN\n' });
    await exec.execute('read_file', { path: 'browser/collect.js' });
    await exec.execute('edit_file', { path: 'browser/collect.js', old_string: 'SAVED_BYTES', new_string: 'EDITED_BYTES' });
    expect(readFileSync(join(workspace, 'browser/collect.js'), 'utf8')).toBe('EDITED_BYTES_OF_THE_OTHER_RUN');
    expect(lstatSync(join(workspace, 'bin/run.sh')).mode & 0o777).toBe(0o755);
  }, 60_000);

  // Second review 2026-10-17: the model's write tools refuse a copy inside the
  // worker too, where they run; a shell is detected, not refused.
  it('the worker\'s write_file and edit_file refuse a copy, under any spelling', async () => {
    for (const path of [`${copy}/browser/collect.js`, `./${copy}/browser/new.js`]) {
      await expect(exec.execute('write_file', { path, content: 'the run\'s own' })).rejects.toThrow(/write_file: refuse to write into \.atoma-runs\//);
    }
    await exec.execute('read_file', { path: `${copy}/browser/collect.js` });
    await expect(exec.execute('edit_file', { path: `${copy}/browser/collect.js`, old_string: 'SAVED', new_string: 'EDITED' }))
      .rejects.toThrow(/edit_file: refuse to write into \.atoma-runs\//);
    expect(readFileSync(join(workspace, copy, 'browser/collect.js'), 'utf8')).toBe('SAVED_BYTES_OF_THE_OTHER_RUN');
    expect(existsSync(join(workspace, copy, 'browser/new.js'))).toBe(false);
  }, 60_000);

  // Hardening (d), built 2026-10-17: the kernel refuses every shell change.
  it('the worker\'s shell can no longer change, move, link or remove a copy, mounted read-only over /workspace', async () => {
    const sh = async (script: string) => (await exec.execute('run_shell', { command: 'bash', args: ['-c', script] })) as { exitCode?: number; stdout?: string; stderr?: string };
    for (const script of [
      `printf CHANGED > ${copy}/browser/collect.js`, `chmod 600 ${copy}/browser/collect.js`, `touch ${copy}/browser/collect.js`,
      `rm -f ${copy}/browser/collect.js`, `mkdir ${copy}/new`, `mv ${copy} ${copy}-aside`, 'mv .atoma-runs aside', 'rm -rf .atoma-runs',
      `ln ${copy}/browser/collect.js hard.js`,
    ]) {
      const result = await sh(script);
      expect(result.exitCode, script).not.toBe(0);
      expect(`${result.stderr}`, script).toMatch(/Read-only file system|Device or resource busy|cross-device|Invalid cross-device/i);
    }
    expect(readFileSync(join(workspace, copy, 'browser/collect.js'), 'utf8')).toBe('SAVED_BYTES_OF_THE_OTHER_RUN');
    expect(readRunCopyIntact(checkReadRunCopies(workspace, index, identities)[0]!)).toBe(true);
    // Docker mounts by destination depth: the copies' mount sits on /workspace's, read-only, which itself stays writable.
    const mounts = (await sh('cat /proc/self/mountinfo')).stdout!.split('\n').map(line => line.split(' '));
    const ws = mounts.find(fields => fields[4] === '/workspace')!;
    const runs = mounts.find(fields => fields[4] === '/workspace/.atoma-runs')!;
    expect(runs[1]).toBe(ws[0]);
    expect(runs[5]!.split(',')).toContain('ro');
    expect((await sh('printf ok > writable.txt && cat writable.txt')).stdout).toBe('ok');
  }, 60_000);

  it('cannot reach the other run by its host path', async () => {
    const r = (await exec.execute('run_shell', { command: 'cat', args: [join(other, '.env'), join(other, 'browser', 'collect.js')] })) as {
      stdout?: string; stderr?: string };
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).not.toContain('OTHER_RUN_UNSAVED_SECRET');
    expect(out).not.toContain('SAVED_BYTES_OF_THE_OTHER_RUN');
    expect(out.toLowerCase()).toMatch(/no such file|cannot access|not found/);
  }, 60_000);
});

// The copies sit under .atoma-runs/node_modules so that whole-tree tools skip
// them (2026-10-17). Offline, in the worker: npm's clean install manages the
// root node_modules alone, and the image's own Vitest, with its default
// include, never collects a copy's test, where it collects one in a plain
// dot-directory, as the copies sat before.
describeDocker('read-run copies beside whole-tree tools in a containerised run', () => {
  let dir: string;
  let workspace: string;
  let exec: ContainerToolExecutor;
  let index: ReadRunsIndex;
  let identities: ReadRunCopyIdentities;
  const runId = '50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a';
  const copy = readRunCopyPath(runId);
  const OLD_TEST = "test('an older run', () => { expect(1).toBe(2); });\n";
  const shell = async (command: string, args: string[]) => {
    const result = (await exec.execute('run_shell', { command, args })) as { exitCode?: number; stdout?: string; stderr?: string };
    return { exitCode: result.exitCode, text: stripVTControlCharacters(`${result.stdout ?? ''}${result.stderr ?? ''}`) };
  };
  const vitest = () => shell('node', ['/app/node_modules/vitest/vitest.mjs', 'run', '--globals']);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-container-read-run-tools-'));
    const other = join(dir, 'other-run', 'workspace');
    mkdirSync(join(other, 'tests'), { recursive: true });
    writeFileSync(join(other, 'package.json'), '{"name":"application","version":"0.9.0","private":true}\n');
    writeFileSync(join(other, 'tests', 'app.test.js'), OLD_TEST);
    const { manifest, hash } = buildWorkspaceArtifactManifest({ workspaceRoot: other });
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, 'tests'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{"name":"application","version":"1.0.0","private":true}\n');
    writeFileSync(join(workspace, 'package-lock.json'), JSON.stringify({ name: 'application', version: '1.0.0', lockfileVersion: 3,
      requires: true, packages: { '': { name: 'application', version: '1.0.0' } } }));
    writeFileSync(join(workspace, 'tests', 'app.test.js'), "test('this run', () => { expect(1).toBe(1); });\n");
    index = { version: 1, orgId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
      readRuns: [{ runId, status: 'partial', endedAt: new Date().toISOString(), workspacePath: other, manifestHash: hash, manifest }] };
    materialiseReadRuns(workspace, index);
    exec = new ContainerToolExecutor({ workspaceHostPath: workspace, startTimeoutMs: 90_000, readOnlyRunCopies: true,
      image: process.env['ATOMA_TEST_ACCEPTANCE_IMAGE'] ?? 'atoma-worker:latest' });
    await exec.start();
    // Taken once the worker mounted them, as the runner does: Docker Desktop moves the source's ctime at start.
    identities = captureReadRunCopies(workspace, index);
  }, 120_000);

  afterAll(async () => {
    await exec?.drain();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('npm ci, offline, replaces the root node_modules and leaves the copy as the host wrote it', async () => {
    mkdirSync(join(workspace, 'node_modules', 'stale'), { recursive: true });
    writeFileSync(join(workspace, 'node_modules', 'stale', 'index.js'), 'left by an earlier install');
    const install = await shell('npm', ['ci', '--offline', '--no-audit', '--no-fund']);
    expect(install.exitCode, install.text).toBe(0);
    expect(existsSync(join(workspace, 'node_modules', 'stale'))).toBe(false);
    expect(readFileSync(join(workspace, copy, 'tests', 'app.test.js'), 'utf8')).toBe(OLD_TEST);
    expect(readRunCopyIntact(checkReadRunCopies(workspace, index, identities)[0]!)).toBe(true);
  }, 120_000);

  it('the image\'s Vitest, with its default include, never collects a copy\'s test, and does collect one in a dot-directory', async () => {
    const run = await vitest();
    expect(run.exitCode, run.text).toBe(0);
    expect(run.text).toMatch(/Tests\s+1 passed \(1\)/);
    expect(run.text).not.toContain('an older run');
    // Its cache went to the root node_modules, never into a copy.
    expect(readRunCopyIntact(checkReadRunCopies(workspace, index, identities)[0]!)).toBe(true);
    // The control: the same test where copies sat before 2026-10-17, below a dot-directory alone.
    const legacy = join(workspace, '.atoma-runs', runId);
    mkdirSync(join(legacy, 'tests'), { recursive: true });
    writeFileSync(join(legacy, 'tests', 'app.test.js'), OLD_TEST);
    try {
      const control = await vitest();
      expect(control.exitCode, control.text).toBe(1);
      expect(control.text).toContain(`.atoma-runs/${runId}/tests/app.test.js > an older run`);
    } finally { rmSync(legacy, { recursive: true, force: true }); }
  }, 120_000);
});

// The required CI worker job builds its image first. Local callers select an
// isolated tag explicitly, so a stale shared :latest cannot masquerade as proof.
const acceptanceImage = process.env['ATOMA_TEST_ACCEPTANCE_IMAGE'];
describe.skipIf(!acceptanceImage && process.env['CI_REQUIRE_DOCKER'] !== '1')('compiled parent-test worker', () => {
  // Run 9e134e49 (2026-10-24): a test runner launched Chromium in its own
  // process group; run_shell killed the runner's group on timeout and the
  // browser survived, until the worker's task limit stopped every build.
  // The detached process lives in the worker container, never on the test host.
  it.skipIf(process.platform === 'win32').each([
    ['times out', 'setInterval(() => {}, 1000);', { timeoutMs: 1500 }],
    ['exits', 'setTimeout(() => process.exit(0), 300);', {}],
  ] as const)('kills a detached grandchild when the command that launched it %s', async (_mode, parentTail, extra) => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-escaped-group-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    writeFileSync(join(workspace, 'launcher.cjs'), `
      const {spawn} = require('node:child_process');
      const browser = spawn(process.execPath, ['-e', "setInterval(() => require('node:fs').appendFileSync('heartbeat', '.'), 20)"],
        {stdio: 'ignore', detached: true});
      browser.unref();
      ${parentTail}
    `);
    try {
      await executor.execute('run_shell', { cmd: 'node launcher.cjs', ...extra });
      await new Promise(resolve => setTimeout(resolve, 300));
      const stopped = readFileSync(join(workspace, 'heartbeat'), 'utf8');
      expect(stopped.length).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(readFileSync(join(workspace, 'heartbeat'), 'utf8')).toBe(stopped);
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it('stops a crashed server group before the next worker command', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-server-exit-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    writeFileSync(join(workspace, 'owner.cjs'), `
      const {spawn} = require('node:child_process');
      const worker = spawn(process.execPath, ['-e', "setInterval(() => require('node:fs').appendFileSync('heartbeat', '.'), 20)"], {stdio: 'ignore'});
      worker.on('spawn', () => {
        const server = require('node:http').createServer((q,r) => r.end('ready'));
        server.listen(Number(process.env.PORT), '127.0.0.1', () => {
          console.log('LISTENING_ON_PORT=' + server.address().port);
          setTimeout(() => process.exit(1), 500);
        });
      });
    `);
    try {
      await executor.execute('start_node_server', { entry: 'owner.cjs' });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const stopped = readFileSync(join(workspace, 'heartbeat'), 'utf8');
      expect(stopped.length).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(readFileSync(join(workspace, 'heartbeat'), 'utf8')).toBe(stopped);
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it.each([[1, 0], [0, 1]])('retains same-command probe history across the compiled worker (%i → %i)', async (first, latest) => {
    // Attica 3e07ee61: the server had the fix, but the customer-device worker
    // image still replaced the mutant result. Exercise packaged code over
    // the same stdio protocol DesktopCompute's LocalContainerToolExecutor uses.
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-probe-history-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    const cmd = 'node probe.cjs';
    try {
      for (const exitCode of [first, latest]) {
        writeFileSync(join(workspace, 'probe.cjs'), `console.log('observed ${exitCode}'); process.exit(${exitCode});\n`);
        expect(await executor.execute('record_probe', { cmd })).toMatchObject({ exitCode, recorded: true });
      }
      const expected = { version: 1, entries: [{ cmd, exitCode: latest, stdout: `observed ${latest}\n`,
        replacementHistory: [{ cmd, exitCode: first }], replacementHistoryTruncated: false }] };
      // Assert both the persisted bytes and their transport reading: a previous
      // success must never replace the latest failure as the replay baseline.
      expect(JSON.parse(readFileSync(join(workspace, '.atoma-probes.json'), 'utf8'))).toEqual(expected);
      const read = await executor.execute('read_file', { path: '.atoma-probes.json' }) as { content: string };
      expect(JSON.parse(read.content)).toEqual(expected);
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it('records numbered source inspection with the packaged shell allowlist', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-numbered-source-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      writeFileSync(join(workspace, 'source.ts'), 'first\n\nthird\n');
      const result = await executor.execute('record_probe', { cmd: 'nl -ba source.ts', note: 'Numbered source inspection' }) as {
        exitCode: number; stdout: string; recorded: boolean;
      };
      expect(result).toMatchObject({ exitCode: 0, recorded: true });
      expect(result.stdout.trim().split('\n').map(line => line.trim())).toEqual(['1\tfirst', '2', '3\tthird']);
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it('keeps supervisor observation from authorizing a child overwrite across the worker boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-observation-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      writeFileSync(join(workspace, 'source.ts'), 'export const value = 1;');
      await executor.start();
      expect(await executor.execute('read_file', { path: 'source.ts', observationOnly: true }))
        .toMatchObject({ content: 'export const value = 1;' });
      await expect(executor.execute('write_file', { path: 'source.ts', content: 'export const value = 2;' }))
        .rejects.toThrow('nothing in this run has read it');
      await executor.execute('read_file', { path: 'source.ts' });
      await executor.execute('read_file', { path: 'source.ts', observationOnly: true });
      await executor.execute('write_file', { path: 'source.ts', content: 'export const value = 2;' });
      expect(readFileSync(join(workspace, 'source.ts'), 'utf8')).toBe('export const value = 2;');
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it('uses packaged Vitest, detects a wrong implementation and keeps the workspace intact', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-acceptance-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      await executor.start();
      expect(executor.toolDeclarations()).toHaveLength(10);
      writeFileSync(join(workspace, 'sum.ts'), 'export const sum=(a:number,b:number)=>a+b;');
      writeFileSync(join(workspace, 'vitest.config.ts'), "throw new Error('foreign config');");
      const suite = {requirement: 'sum handles signed inputs', cwd: '.', source:
        "import {test,expect} from 'vitest'; import {sum} from './sum.ts'; import {writeFileSync} from 'node:fs'; test('sum',()=>{expect(sum(2,3)).toBe(5);expect(sum(-2,1)).toBe(-1);expect(()=>writeFileSync('/workspace/sum.ts','bad')).toThrow();expect(()=>writeFileSync('/app/dist/tools/worker.js','bad')).toThrow()});"};
      type Observed = { status?: string; workspaceDigest?: string; subjectDigest?: string };
      const run = async () => await executor.execute('run_shell', {command:'atoma-verify',args:[JSON.stringify(suite)],timeoutMs:30_000}) as Observed;
      const passed = await run();
      expect(passed, JSON.stringify(passed)).toMatchObject({status:'passed',passed:1,subjectDigest:expect.stringMatching(/^[0-9a-f]{64}$/)});
      // A host artefact moves the workspace digest, never the subject digest (suite disputes, 2026-10-17).
      writeFileSync(join(workspace,'.atoma-probes.json'),JSON.stringify({probes:[]}));
      const probed = await run();
      expect(probed).toMatchObject({status:'passed',subjectDigest:passed.subjectDigest});
      expect(probed.workspaceDigest).not.toBe(passed.workspaceDigest);
      expect(readFileSync(join(workspace,'sum.ts'),'utf8')).toContain('a+b');
      writeFileSync(join(workspace,'sum.ts'),'export const sum=()=>5;');
      const failed = await run();
      expect(failed).toMatchObject({status:'failed',failed:1});
      expect(failed.subjectDigest).not.toBe(passed.subjectDigest);
      expect(existsSync(join(workspace,'atoma.acceptance.test.ts'))).toBe(false);
    } finally {
      await executor.drain();
      rmSync(workspace,{recursive:true,force:true});
    }
  },90_000);

  it('reads a forged Object.is as tampering in the packaged runner', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-acceptance-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      await executor.start();
      writeFileSync(join(workspace, 'sum.ts'), ['Object.is = () => true;', 'export const sum = (_a: number, _b: number): number => 5;'].join('\n'));
      const suite = { requirement: 'sum adds', cwd: '.', source: [
        "import { test, expect } from 'vitest';",
        "import { sum } from './sum.ts';",
        "test('sum', () => {",
        '  expect(sum(-2, 1)).toBe(-1);',
        '});',
      ].join('\n') };
      const observation = await executor.execute('run_shell', { command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs: 60_000 });
      expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'unavailable', cause: 'assertions-tampered' });
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 90_000);

  // Run 760fef4c (2026-10-17), on this path: a module probing for the image's
  // Chromium at import threw ERR_ACCESS_DENIED and never loaded.
  it('answers existence probes outside the copy with false in the packaged runner', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-acceptance-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      await executor.start();
      writeFileSync(join(workspace, 'probe.js'), [
        "import { existsSync } from 'node:fs';",
        "export const probes = ['/usr/bin/chromium', '/workspace/probe.js', './probe.js'].map(target => existsSync(target));",
      ].join('\n'));
      const suite = { requirement: 'existence probes answer', cwd: '.', source: [
        "import { test, expect } from 'vitest';",
        "import { readFileSync } from 'node:fs';",
        "import { probes } from './probe.js';",
        "test('probes', () => {",
        '  expect(probes).toEqual([false, false, true]);',
        "  expect(() => readFileSync('/workspace/probe.js', 'utf8')).toThrow();",
        '});',
      ].join('\n') };
      const observation = await executor.execute('run_shell', { command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs: 60_000 });
      expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'passed', passed: 1 });
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 90_000);

  // The same answers where /usr/bin/chromium is installed and /workspace is the live tree.
  it('answers every read outside the copy as an absent path in the packaged runner', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-acceptance-image-'));
    for (const [name, text] of Object.entries(OUTSIDE_THE_COPY_FILES)) {
      mkdirSync(dirname(join(workspace, name)), { recursive: true });
      writeFileSync(join(workspace, name), text);
    }
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      await executor.start();
      const suite = { requirement: 'paths outside the copy are absent', cwd: '.', source: OUTSIDE_THE_COPY_SUITE };
      const observation = await executor.execute('run_shell', { command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs: 60_000 });
      expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'passed', passed: OUTSIDE_THE_COPY_TESTS, failed: 0 });
    } finally {
      await executor.drain();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);

  it('copies without stalling sibling reads and runs no project code in the coordinator', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-acceptance-image-'));
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace,
      image: acceptanceImage ?? 'atoma-worker:latest', forwardWorkerLogs: false });
    try {
      await executor.start();
      writeFileSync(join(workspace, 'sum.ts'), 'export const sum=(_a:number,_b:number)=>5;');
      // Loaded by Vite's CSS plugin in the coordinator, it would replace the report at exit.
      writeFileSync(join(workspace, 'postcss.config.cjs'), [
        "process.on('exit', () => {",
        "  require('node:fs').writeFileSync(process.cwd() + '/atoma.report.json', JSON.stringify({ success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1, testResults: [{ assertionResults: [{ fullName: 'sum', status: 'passed', failureMessages: [] }] }] }));",
        '  process.exitCode = 0;',
        '});',
        'module.exports = { plugins: [] };',
      ].join('\n'));
      const filler = 'x'.repeat(4096);
      for (let index = 0; index < 5000; index++) {
        mkdirSync(join(workspace, 'node_modules', `p${index % 50}`), { recursive: true });
        writeFileSync(join(workspace, 'node_modules', `p${index % 50}`, `f${index}.js`), filler);
      }
      const suite = { requirement: 'sum adds', cwd: '.', source:
        "import {test,expect} from 'vitest'; import {sum} from './sum.ts'; test('sum',()=>{expect(sum(2,3)).toBe(5);expect(sum(-2,1)).toBe(-1);});" };
      // One burst: the read is dispatched while the verification copies.
      const verification = executor.execute('run_shell', { command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs: 60_000 });
      const readStarted = Date.now();
      const read = await executor.execute('read_file', { path: 'sum.ts' });
      const readMs = Date.now() - readStarted;
      const observation = await verification as { status: string; snapshot?: { files: number; ms: number } };
      expect(JSON.stringify(read)).toContain('=>5');
      expect(observation.status, JSON.stringify(observation)).toBe('failed');
      expect(observation.snapshot?.files).toBeGreaterThanOrEqual(5000);
      // A copy that blocked the worker would hold the read for its whole duration.
      expect(readMs).toBeLessThan(observation.snapshot!.ms / 4);
    } finally {
      await executor.drain();
      rmSync(workspace,{recursive:true,force:true});
    }
  },120_000);
});
