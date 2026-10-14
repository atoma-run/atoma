import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { DockerHosting } from '../src/launcher/hosting.js';
import { hostingLaunchSchema } from '../src/contracts/projectHosting.js';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosting-engine-')); roots.push(root);
  const id = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID() };
  const calls: string[][] = []; const containers = new Set<string>(); const networks = new Set<string>();
  const image = `hosting@sha256:${'a'.repeat(64)}`;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'run') containers.add(args[args.indexOf('--name') + 1]!);
    if (args[0] === 'rm') containers.delete(args.at(-1)!);
    if (args[0] === 'network' && args[1] === 'create') networks.add(args.at(-1)!);
    if (args[0] === 'network' && args[1] === 'rm') networks.delete(args.at(-1)!);
    if (args[0] === 'network' && args[1] === 'ls') { const filter = args[args.indexOf('--filter') + 1]!.slice(6, -1); return [...networks].filter(n => n === filter).join('\n'); }
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1]!;
      return filter.startsWith('name=') ? [...containers].filter(n => filter === `name=^/${n}$`).join('\n') : [...containers].join('\n');
    }
    if (args[0] === 'port') return '127.0.0.1:32123';
    if (args[0] === 'inspect') return args.includes('{{.Config.Image}}') ? image : '10.5.0.2';
    return '';
  };
  const launcher = new DockerHosting({ root, image, relayImage: image, user: '10001:10001', run });
  return { root, id, calls, containers, networks, launcher };
}
it('uses gVisor, isolated networks, fixed mounts and immutable images, and retains data on stop', async () => {
  const f = fixture(); await f.launcher.prepareHosting(f.id);
  const data = join(f.root, f.id.orgId, f.id.projectId, 'data', 'offers.json'); writeFileSync(data, 'retained');
  expect(await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' })).toMatchObject({ hostPort: 32123 });
  const app = f.calls.find(args => args[0] === 'run' && args.includes('runsc'))!;
  expect(app).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL', '--restart', 'unless-stopped', 'ATOMA_DATA_DIR=/data']));
  expect(app.join(' ')).not.toContain('docker.sock');
  expect(f.calls.find(args => args.includes('--internal'))).toContain('com.docker.network.bridge.gateway_mode_ipv4=isolated');
  await f.launcher.stopHosting(f.id);
  expect(f.containers.size).toBe(0); expect(f.networks.size).toBe(0); expect(readFileSync(data, 'utf8')).toBe('retained');
});
it('reattaches a running deployment without recreating containers or deleting data', async () => {
  const f = fixture(); await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  const count = f.calls.filter(args => args[0] === 'run').length;
  await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  expect(f.calls.filter(args => args[0] === 'run')).toHaveLength(count);
});
it('refuses path traversal, raw options and symlinked persistent data before engine use', async () => {
  const f = fixture();
  expect(hostingLaunchSchema.safeParse({ ...f.id, entry: '../server.js', kind: 'node' }).success).toBe(false);
  expect(hostingLaunchSchema.safeParse({ ...f.id, entry: 'server.js', kind: 'node', command: 'sh' }).success).toBe(false);
  const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.root, f.id.orgId));
  await expect(f.launcher.prepareHosting(f.id)).rejects.toThrow('Invalid hosting directory'); expect(f.calls).toHaveLength(0);
});
it('browser capability uses a fixed image, persistent profile, and a public-only proxy on an isolated bridge', async () => {
  const f = fixture();
  await expect(f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node', browser: true })).rejects.toThrow('not configured');
  const browserImage = `browser@sha256:${'b'.repeat(64)}`;
  const launcher = new DockerHosting({ root: f.root, image: `node@sha256:${'a'.repeat(64)}`, relayImage: `relay@sha256:${'c'.repeat(64)}`, browserImage, user: '10001:10001', run: async args => {
    f.calls.push(args);
    if (args[0] === 'ps') return f.calls.some(a => a[0] === 'run' && a.includes('runsc')) ? [`atoma-hosted-${f.id.deploymentId}-app`, `atoma-hosted-${f.id.deploymentId}-relay`].join('\n') : '';
    if (args[0] === 'port') return '127.0.0.1:32123';
    if (args[0] === 'inspect') return args.includes('{{.Config.Image}}') ? browserImage : '10.5.0.2';
    return '';
  } });
  await launcher.startHosting({ ...f.id, entry: 'browser/server.js', kind: 'node', browser: true });
  const app = f.calls.find(a => a[0] === 'run' && a.includes('runsc'))!;
  expect(app).toContain(browserImage);
  expect(app).toContain('ATOMA_BROWSER_URL=http://127.0.0.1:9222');
  expect(app).toContain('ATOMA_BROWSER_PROXY=http://10.5.0.2:3128');
  expect(app).not.toContain('-p');
  expect(app).toContain('/opt/atoma-hosting/browser.mjs');
  const proxy = f.calls.find(a => a[0] === 'run' && a.includes('/app/dist/tools/egressProxy.js'))!;
  expect(proxy).toEqual(expect.arrayContaining(['ATOMA_EGRESS_ALLOWLIST=*', '--read-only']));
  expect(proxy).not.toContain('-p');
});
