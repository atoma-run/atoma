import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { DockerHosting, pinnedHostingAddresses } from '../src/launcher/hosting.js';
import { hostingLaunchSchema } from '../src/contracts/projectHosting.js';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
/** A fake engine that knows created, running and removed containers, their labels and networks. */
function engine(record: string[][], image: string, browserImage = image) {
  const containers = new Map<string, { state: 'created' | 'running' | 'exited'; labels: Map<string, string> }>(); const networks = new Set<string>();
  const networkLabels = new Map<string, Map<string, string>>();
  const labelsOf = (args: string[]) => new Map(args.flatMap((a, i) => a === '--label' ? [args[i + 1]!.split('=') as [string, string]] : []));
  // `{{.Label "x"}}` placeholders filled from an object's labels, empty when absent, as the engine does.
  const formatted = (format: string, labels: Map<string, string>) => format.replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key: string) => labels.get(key) ?? '');
  const run = async (args: string[]) => {
    record.push(args);
    if (args[0] === 'create') containers.set(args[args.indexOf('--name') + 1]!, { state: 'created', labels: labelsOf(args) });
    if (args[0] === 'start') containers.get(args[1]!)!.state = 'running';
    if (args[0] === 'stop') containers.get(args.at(-1)!)!.state = 'exited';
    if (args[0] === 'rm') containers.delete(args.at(-1)!);
    if (args[0] === 'network' && args[1] === 'create') { networks.add(args.at(-1)!); networkLabels.set(args.at(-1)!, labelsOf(args)); }
    if (args[0] === 'network' && args[1] === 'rm') { networks.delete(args.at(-1)!); networkLabels.delete(args.at(-1)!); }
    if (args[0] === 'network' && args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1]!;
      if (filter === 'label=dev.atoma.owner=hosting') {
        const format = args[args.indexOf('--format') + 1]!;
        return [...networkLabels.values()].filter(l => l.get('dev.atoma.owner') === 'hosting').map(l => formatted(format, l)).join('\n');
      }
      return [...networks].filter(n => n === filter.slice(6, -1)).join('\n');
    }
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1]!; const all = args.includes('-a');
      const listed = [...containers].filter(([name, c]) => (all || c.state === 'running') && (filter.startsWith('name=') ? filter === `name=^/${name}$`
        : filter.startsWith('label=dev.atoma.deployment=') ? c.labels.get('dev.atoma.deployment') === filter.slice('label=dev.atoma.deployment='.length) : c.labels.get('dev.atoma.owner') === 'hosting'));
      const format = args[args.indexOf('--format') + 1]!;
      return listed.map(([name, c]) => format.includes('.State') ? `${name} ${c.state} ${c.labels.get('dev.atoma.spec') ?? ''}`
        : format.includes('.Label') ? formatted(format, c.labels) : name).join('\n');
    }
    if (args[0] === 'port') return '127.0.0.1:32123';
    if (args[0] === 'network' && args[1] === 'inspect') return '10.5.0.0/24 ';
    if (args[0] === 'inspect') {
      const name = args.at(-1)!;
      if (args.includes('{{.Config.Image}}')) return containers.get(name)?.labels.get('dev.atoma.browser') ? browserImage : image;
      const label = /Labels "(dev\.atoma\.[a-z]+)"/.exec(args.join(' '))?.[1];
      if (label) return containers.get(name)?.labels.get(label) ?? '';
      // A created container has no address yet; the engine assigns the pinned one when it starts.
      if (containers.get(name)?.state !== 'running') return '';
      return name.endsWith('-proxy') ? '10.5.0.3' : '10.5.0.2';
    }
    return '';
  };
  return { run, containers, networks };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosting-engine-')); roots.push(root);
  const id = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID() };
  const calls: string[][] = [];
  const image = `hosting@sha256:${'a'.repeat(64)}`;
  const { run, containers, networks } = engine(calls, image);
  const launcher = new DockerHosting({ root, image, relayImage: image, user: '10001:10001', run });
  return { root, id, calls, containers, networks, launcher, image };
}
it('uses gVisor, isolated networks, fixed mounts and immutable images, and retains data on stop', async () => {
  const f = fixture(); await f.launcher.prepareHosting(f.id);
  const data = join(f.root, f.id.orgId, f.id.projectId, 'data', 'offers.json'); writeFileSync(data, 'retained');
  expect(await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' })).toMatchObject({ hostPort: 32123 });
  const app = f.calls.find(args => args[0] === 'create' && args.includes('runsc'))!;
  expect(app).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL', '--restart', 'unless-stopped', 'ATOMA_DATA_DIR=/data']));
  expect(app.join(' ')).not.toContain('docker.sock');
  expect(f.calls.find(args => args.includes('--internal'))).toContain('com.docker.network.bridge.gateway_mode_ipv4=isolated');
  await f.launcher.stopHosting(f.id);
  expect(f.containers.size).toBe(0); expect(f.networks.size).toBe(0); expect(readFileSync(data, 'utf8')).toBe('retained');
});
it('reattaches a running deployment without recreating containers or deleting data', async () => {
  const f = fixture(); await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  const count = f.calls.filter(args => args[0] === 'create' || args[0] === 'start').length;
  await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  expect(f.calls.filter(args => args[0] === 'create' || args[0] === 'start')).toHaveLength(count);
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
  const relayImage = `relay@sha256:${'c'.repeat(64)}`;
  const { run } = engine(f.calls, relayImage, browserImage);
  const launcher = new DockerHosting({ root: f.root, image: `node@sha256:${'a'.repeat(64)}`, relayImage, browserImage, user: '10001:10001', run });
  await launcher.startHosting({ ...f.id, entry: 'browser/server.js', kind: 'node', browser: true });
  const app = f.calls.find(a => a[0] === 'create' && a.includes('runsc'))!;
  expect(app).toContain(browserImage);
  expect(app).toContain('ATOMA_BROWSER_URL=http://127.0.0.1:9222');
  expect(app).toContain('ATOMA_BROWSER_PROXY=http://10.5.0.3:3128');
  expect(app).not.toContain('-p');
  expect(app).toContain('/opt/atoma-hosting/browser.mjs');
  const proxy = f.calls.find(a => a[0] === 'create' && a.includes('/app/dist/tools/egressProxy.js'))!;
  expect(proxy).toEqual(expect.arrayContaining(['ATOMA_EGRESS_ALLOWLIST=*', '--read-only']));
  expect(proxy).not.toContain('-p');
});

it('gives a Node server a public-only proxy when egress is open, and leaves static pages and closed hosts without one', async () => {
  const f = fixture();
  const { run, containers } = engine(f.calls, f.image);
  const open = new DockerHosting({ root: f.root, image: f.image, relayImage: f.image, user: '10001:10001', run, openEgress: true });
  expect(await open.startHosting({ ...f.id, entry: 'server.js', kind: 'node' })).toMatchObject({ hostPort: 32123 });
  const app = f.calls.find(a => a[0] === 'create' && a.includes('runsc'))!;
  // The four variables Node's own proxy support reads; the address is the pinned one.
  expect(app).toEqual(expect.arrayContaining(['HTTP_PROXY=http://10.5.0.3:3128', 'HTTPS_PROXY=http://10.5.0.3:3128',
    'NO_PROXY=127.0.0.1,localhost,::1', 'NODE_USE_ENV_PROXY=1', 'dev.atoma.egress=true']));
  expect(app.join(' ')).not.toContain('ATOMA_BROWSER');
  const proxy = f.calls.find(a => a[0] === 'create' && a.includes('/app/dist/tools/egressProxy.js'))!;
  expect(proxy).toEqual(expect.arrayContaining(['ATOMA_EGRESS_ALLOWLIST=*', '--read-only', '--cap-drop', 'ALL']));
  expect(proxy).not.toContain('-p');
  // The proxy starts before the application that depends on it.
  const started = f.calls.filter(a => a[0] === 'start').map(a => a[1]!.replace(/^.*-/, ''));
  expect(started).toEqual(['proxy', 'app', 'relay']);
  // The proxy is not part of "running": the site stays online without it.
  const proxyName = [...containers.keys()].find(name => name.endsWith('-proxy'))!;
  containers.get(proxyName)!.state = 'exited';
  expect(await open.inspectHosting(f.id)).toMatchObject({ hostPort: 32123 });
  await open.stopHosting(f.id);
  expect(containers.size).toBe(0);

  // A static page runs no server code: no proxy, no variables.
  const page = { ...f.id, deploymentId: randomUUID() };
  const before = f.calls.length;
  await open.startHosting({ ...page, entry: 'index.js', kind: 'static' });
  const made = f.calls.slice(before).filter(a => a[0] === 'create');
  expect(made).toHaveLength(2);
  expect(made.flat().join(' ')).not.toMatch(/egressProxy|HTTP_PROXY|dev\.atoma\.egress/);
  await open.stopHosting(page);

  // Closed (an operator's exact list): the launch a Node server always had, same objects, same digest.
  const digestOf = (calls: string[][]) => calls.find(a => a[0] === 'create' && a.includes('runsc'))!.find(a => a.startsWith('dev.atoma.spec='));
  const closedCalls: string[][] = [];
  const closed = new DockerHosting({ root: f.root, image: f.image, relayImage: f.image, user: '10001:10001', run: engine(closedCalls, f.image).run });
  const node = { ...f.id, deploymentId: randomUUID() };
  await closed.startHosting({ ...node, entry: 'server.js', kind: 'node' });
  expect(closedCalls.filter(a => a[0] === 'create')).toHaveLength(2);
  expect(closedCalls.filter(a => a[0] === 'create').flat().join(' ')).not.toMatch(/egressProxy|HTTP_PROXY|dev\.atoma\.egress/);
  expect(digestOf(closedCalls)).not.toBe(digestOf(f.calls));
  // And that closed digest is the one every deployment prepared before this change carries.
  const before2026_11_28 = createHash('sha256').update(JSON.stringify(['node', 'server.js', false, f.image, null, f.image, '10001:10001'])).digest('hex').slice(0, 32);
  expect(digestOf(closedCalls)).toBe(`dev.atoma.spec=${before2026_11_28}`);
});
it('never touches a deployment already running when the launcher turns open, and starts a prepared one without creating', async () => {
  const f = fixture();
  const shared = engine(f.calls, f.image);
  const options = { root: f.root, image: f.image, relayImage: f.image, user: '10001:10001', run: shared.run };
  // Online since before the change: two containers, no proxy, no egress label.
  await new DockerHosting(options).startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  const open = new DockerHosting({ ...options, openEgress: true });
  const mutating = () => f.calls.filter(a => ['create', 'start', 'stop', 'rm'].includes(a[0]!) || (a[0] === 'network' && ['create', 'rm', 'connect'].includes(a[1]!))).length;
  const before = mutating();
  expect(await open.startHosting({ ...f.id, entry: 'server.js', kind: 'node' })).toMatchObject({ hostPort: 32123 });
  expect(mutating()).toBe(before);
  expect([...shared.containers.keys()].some(name => name.endsWith('-proxy'))).toBe(false);
  // Its update: prepared while it serves, three objects, then started with no further create.
  const next = { ...f.id, deploymentId: randomUUID(), entry: 'server.js', kind: 'node' as const };
  await open.createHosting(next);
  expect([...shared.containers.entries()].filter(([, c]) => c.state === 'created')).toHaveLength(3);
  const creates = f.calls.filter(a => a[0] === 'create').length;
  expect(await open.startHosting(next)).toMatchObject({ hostPort: 32123 });
  expect(f.calls.filter(a => a[0] === 'create')).toHaveLength(creates);
  expect([...shared.containers.values()].filter(c => c.state === 'running')).toHaveLength(5);
});
it('starts the application even when its egress proxy will not start', async () => {
  const f = fixture();
  const shared = engine(f.calls, f.image);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const flaky = new DockerHosting({ root: f.root, image: f.image, relayImage: f.image, user: '10001:10001', openEgress: true,
      run: async args => { if (args[0] === 'start' && args[1]!.endsWith('-proxy')) throw new Error('engine refused'); return shared.run(args); } });
    expect(await flaky.startHosting({ ...f.id, entry: 'server.js', kind: 'node' })).toMatchObject({ hostPort: 32123 });
    expect([...shared.containers.entries()].filter(([, c]) => c.state === 'running').map(([name]) => name.replace(/^.*-/, '')).sort()).toEqual(['app', 'relay']);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('without its egress proxy'));
  } finally { errors.mockRestore(); }
});
it('pins app, proxy and relay addresses so an engine restart cannot swap them', async () => {
  // 2026-10-16: after a Docker restart the app and its proxy swapped dynamic
  // addresses and the relay, which names its upstream by address, answered 502.
  const f = fixture();
  await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  const app = f.calls.find(a => a[0] === 'create' && a.includes('runsc'))!;
  expect(app[app.indexOf('--ip') + 1]).toBe('10.5.0.2');
  const relay = f.calls.find(a => a[0] === 'create' && a.includes('/app/dist/tools/previewIngress.js'))!;
  expect(relay).toContain('ATOMA_PREVIEW_UPSTREAM_HOST=10.5.0.2');
  expect(f.calls).toContainEqual(['network', 'connect', '--ip', '10.5.0.4', `atoma-hosted-${f.id.deploymentId}-net`, `atoma-hosted-${f.id.deploymentId}-relay`]);
});
it('derives pinned addresses from the network subnet and refuses a missing or tiny one', () => {
  expect(pinnedHostingAddresses('10.210.7.0/24 ')).toEqual({ app: '10.210.7.2', proxy: '10.210.7.3', relay: '10.210.7.4' });
  expect(pinnedHostingAddresses('192.168.112.0/20')).toEqual({ app: '192.168.112.2', proxy: '192.168.112.3', relay: '192.168.112.4' });
  expect(pinnedHostingAddresses('fd00::/64 172.20.0.0/16')).toEqual({ app: '172.20.0.2', proxy: '172.20.0.3', relay: '172.20.0.4' });
  expect(() => pinnedHostingAddresses('')).toThrow('No isolated network subnet');
  expect(() => pinnedHostingAddresses('10.0.0.0/30')).toThrow('too small');
});

it('creates every object of a new version without starting any, so its start is only starts', async () => {
  // Owner decision 2026-10-25: an update prepares everything before it stops
  // the online version; after the stop only the start and readiness remain.
  const f = fixture();
  await f.launcher.createHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  expect([...f.containers.values()].map(c => c.state)).toEqual(['created', 'created']);
  expect(f.networks.size).toBe(2);
  expect(f.calls.some(a => a[0] === 'start' || a[0] === 'run')).toBe(false);
  const before = f.calls.length;
  expect(await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' })).toEqual({ hostPort: 32123, image: f.image });
  const after = f.calls.slice(before);
  expect(after.filter(a => ['create', 'run', 'stop', 'rm'].includes(a[0]!) || a[1] === 'create')).toEqual([]);
  expect(after.filter(a => a[0] === 'start').map(a => a[1])).toEqual([`atoma-hosted-${f.id.deploymentId}-app`, `atoma-hosted-${f.id.deploymentId}-relay`]);
  // Never two runtimes of one deployment: creating over a running one is refused.
  await expect(f.launcher.createHosting({ ...f.id, entry: 'server.js', kind: 'node' })).rejects.toThrow('already running');
});
it('never starts objects created for another launch: they are replaced', async () => {
  const f = fixture();
  await f.launcher.createHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  const before = f.calls.length;
  await f.launcher.startHosting({ ...f.id, entry: 'other.js', kind: 'node' });
  const after = f.calls.slice(before);
  expect(after.filter(a => a[0] === 'rm')).toHaveLength(2);
  const app = after.find(a => a[0] === 'create' && a.includes('runsc'))!;
  expect(app.at(-1)).toBe('other.js');
});
it('gives the application its ten-second grace and stops the stateless relay at once', async () => {
  const f = fixture(); await f.launcher.startHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  f.calls.length = 0; await f.launcher.stopHosting(f.id);
  expect(f.calls.filter(a => a[0] === 'stop')).toEqual([
    ['stop', '--time', '10', `atoma-hosted-${f.id.deploymentId}-app`], ['stop', '--time', '0', `atoma-hosted-${f.id.deploymentId}-relay`]]);
});
it('lists every deployment it created, started or not, by the identity on its labels', async () => {
  // A web process that dies between creating an update's version and reserving
  // its row leaves created objects no row names: recovery needs their identity.
  const f = fixture();
  await f.launcher.createHosting({ ...f.id, entry: 'server.js', kind: 'node' });
  const app = f.calls.find(a => a[0] === 'create' && a.includes('runsc'))!;
  expect(app).toEqual(expect.arrayContaining([`dev.atoma.org=${f.id.orgId}`, `dev.atoma.project=${f.id.projectId}`]));
  expect(await f.launcher.listHosting()).toEqual([f.id]);
  // Networks alone (a create interrupted before its containers) are listed too.
  for (const name of [...f.containers.keys()]) f.containers.delete(name);
  expect(await f.launcher.listHosting()).toEqual([f.id]);
  await f.launcher.stopHosting(f.id);
  expect(f.networks.size).toBe(0);
  expect(await f.launcher.listHosting()).toEqual([]);
  // An object from before the identity labels is not listed: its row existed before it.
  f.containers.set('atoma-hosted-legacy-app', { state: 'running', labels: new Map([['dev.atoma.owner', 'hosting'], ['dev.atoma.deployment', f.id.deploymentId]]) });
  expect(await f.launcher.listHosting()).toEqual([]);
});
