import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, chownSync } from 'node:fs';
import path from 'node:path';
import { isIPv4 } from 'node:net';
import { hostingIdentitySchema, hostingLaunchSchema, type HostingIdentity, type HostingLaunch, type HostingHandle, type HostingLauncher } from '../contracts/projectHosting.js';
import type { AsyncDockerRunner } from './docker.js';

const exec = promisify(execFile);

/**
 * Fixed addresses on a deployment's internal network. A restarted engine hands
 * dynamic ones out again in start order: on 2026-10-16 the app and its browser
 * proxy swapped, and the relay (which names its upstream by address) answered
 * 502. Pinned endpoints keep their address across an engine restart.
 */
export function pinnedHostingAddresses(subnets: string): { app: string; proxy: string; relay: string } {
  const cidr = subnets.split(/\s+/).find(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s) && isIPv4(s.split('/')[0]!));
  if (!cidr) throw new Error('No isolated network subnet');
  const [address, bits] = [cidr.split('/')[0]!, Number(cidr.split('/')[1])];
  if (bits > 29) throw new Error('Isolated network subnet too small');
  const value = address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const base = value - (value % 2 ** (32 - bits));
  const at = (offset: number) => [24, 16, 8, 0].map(shift => Math.floor((base + offset) / 2 ** shift) % 256).join('.');
  return { app: at(2), proxy: at(3), relay: at(4) };
}

const engine: AsyncDockerRunner = async args => (await exec('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
/** Durable deployments have their own namespace. Preview/worker sweeps never own these objects. */
export class DockerHosting implements HostingLauncher {
  constructor(private readonly options: { root: string; image: string; browserImage?: string; relayImage: string; user: string; run?: AsyncDockerRunner }) {
    if (!path.isAbsolute(options.root) || options.root === '/') throw new Error('Dedicated absolute hosting root required');
    for (const image of [options.image, options.relayImage, ...(options.browserImage ? [options.browserImage] : [])]) if (!/(?:^|@)sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Hosting images must be pinned');
    if (!/^[1-9]\d*:\d+$/.test(options.user)) throw new Error('Non-root hosting identity required');
  }
  private run(args: string[]): Promise<string> { return (this.options.run ?? engine)(args); }
  private names(raw: HostingIdentity) {
    const id = hostingIdentitySchema.parse(raw);
    const prefix = `atoma-hosted-${id.deploymentId}`;
    return { app: `${prefix}-app`, relay: `${prefix}-relay`, proxy: `${prefix}-proxy`, internal: `${prefix}-net`, uplink: `${prefix}-pub`,
      source: path.join(this.options.root, id.orgId, id.projectId, 'releases', id.deploymentId),
      data: path.join(this.options.root, id.orgId, id.projectId, 'data') };
  }
  async prepareHosting(id: HostingIdentity): Promise<string> {
    const n = this.names(id);
    for (const dir of [n.source, n.data]) {
      let current = this.options.root;
      for (const part of ['', ...path.relative(this.options.root, dir).split(path.sep)]) {
        current = path.join(current, part);
        try { mkdirSync(current, { mode: 0o750 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid hosting directory');
        if (process.getuid?.() === 0) { const [uid, gid] = this.options.user.split(':').map(Number); chownSync(current, uid!, gid!); }
      }
    }
    return n.source;
  }
  async inspectHosting(id: HostingIdentity): Promise<HostingHandle | null> {
    const n = this.names(id);
    const names = (await this.run(['ps', '--filter', 'label=dev.atoma.owner=hosting', '--format', '{{.Names}}'])).split('\n');
    if (!names.includes(n.app) || !names.includes(n.relay)) return null;
    const browser = await this.run(['inspect', '--format', '{{index .Config.Labels "dev.atoma.browser"}}', n.app]);
    if (browser.trim() === 'true' && !names.includes(n.proxy)) return null;
    const output = await this.run(['port', n.relay, '8081']);
    const match = /^127\.0\.0\.1:(\d+)$/m.exec(output.trim());
    if (!match) throw new Error('Hosting ingress is not loopback-only');
    const image = await this.run(['inspect', '--format', '{{.Config.Image}}', n.app]);
    return { hostPort: Number(match[1]), image: image.trim() };
  }
  /** Which images, user and launch a set of created objects was made for: a start uses only objects made for its own. */
  private specDigest(spec: HostingLaunch): string {
    return createHash('sha256').update(JSON.stringify([spec.kind, spec.entry, !!spec.browser, this.options.image,
      this.options.browserImage ?? null, this.options.relayImage, this.options.user])).digest('hex').slice(0, 32);
  }
  private launchable(spec: HostingLaunch): { id: HostingIdentity; n: ReturnType<DockerHosting['names']> } {
    if (spec.browser && (spec.kind !== 'node' || !this.options.browserImage)) throw new Error('Browser hosting is not configured');
    const id = { orgId: spec.orgId, projectId: spec.projectId, deploymentId: spec.deploymentId };
    return { id, n: this.names(id) };
  }
  /**
   * Networks, pinned addresses and containers, created and never started.
   * Everything an update can do while the online version keeps serving: a
   * deployment's objects are its own, and only its application container
   * mounts the project's data, which creation does not run.
   */
  async createHosting(raw: HostingLaunch): Promise<void> {
    const spec = hostingLaunchSchema.parse(raw);
    const { id, n } = this.launchable(spec);
    if (await this.inspectHosting(id)) throw new Error('Deployment already running');
    await this.stopHosting(id);
    await this.prepareHosting(id);
    // The full identity, so a boot recovery can name, and remove, objects
    // whose row was never written (listHosting).
    const labels = ['--label', 'dev.atoma.owner=hosting', '--label', `dev.atoma.deployment=${spec.deploymentId}`,
      '--label', `dev.atoma.org=${spec.orgId}`, '--label', `dev.atoma.project=${spec.projectId}`];
    const made = [...labels, '--label', `dev.atoma.spec=${this.specDigest(spec)}`];
    try {
      await this.run(['network', 'create', '--internal', ...labels, '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--opt', 'com.docker.network.bridge.gateway_mode_ipv6=isolated', n.internal]);
      await this.run(['network', 'create', ...labels, n.uplink]);
      const pinned = pinnedHostingAddresses(await this.run(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', n.internal]));
      const bounds = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.5', '--pids-limit', '128', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2'];
      if (spec.browser) {
        await this.run(['create', '--name', n.proxy, ...made, '--restart', 'unless-stopped', '--network', n.uplink,
          '--user', this.options.user, '--read-only', ...bounds, '-e', 'ATOMA_EGRESS_ALLOWLIST=*',
          '--entrypoint', 'node', this.options.relayImage, '/app/dist/tools/egressProxy.js']);
        await this.run(['network', 'connect', '--ip', pinned.proxy, n.internal, n.proxy]);
      }
      const appBounds = spec.browser ? ['--memory', '1536m', '--memory-swap', '1536m', '--cpus', '1', '--pids-limit', '256', '--shm-size', '256m'] : [];
      await this.run(['create', '--name', n.app, ...made, '--restart', 'unless-stopped', '--network', n.internal, '--ip', pinned.app,
        ...(spec.browser ? ['--label', 'dev.atoma.browser=true'] : []),
        '--runtime', 'runsc', '--user', this.options.user, '--read-only', ...bounds, ...appBounds,
        '--tmpfs', spec.browser ? '/tmp:rw,noexec,nosuid,size=256m' : '/tmp:rw,noexec,nosuid,size=64m', '--mount', `type=bind,src=${n.source},dst=/workspace,readonly`,
        '--mount', `type=bind,src=${n.data},dst=/data`, '-w', '/workspace',
        '-e', spec.browser ? 'PORT=8082' : 'PORT=8080', '-e', 'HOST=0.0.0.0', '-e', 'NODE_ENV=production', '-e', 'HOME=/tmp', '-e', 'ATOMA_DATA_DIR=/data',
        // The proxy's address is pinned, so it is known before anything starts; the start checks it.
        ...(spec.browser ? ['-e', `ATOMA_BROWSER_PROXY=http://${pinned.proxy}:3128`, '-e', 'ATOMA_BROWSER_URL=http://127.0.0.1:9222', '-e', 'ATOMA_BROWSER_DESKTOP_URL=/.atoma/browser/'] : []),
        '--entrypoint', 'node', spec.browser ? this.options.browserImage! : this.options.image,
        ...(spec.browser ? ['/opt/atoma-hosting/browser.mjs', spec.entry] : [spec.kind === 'static' ? '/opt/atoma-hosting/static.mjs' : spec.entry])]);
      await this.run(['create', '--name', n.relay, ...made, '--restart', 'unless-stopped', '--network', n.uplink,
        '-p', '127.0.0.1::8081', ...bounds, '-e', 'ATOMA_PREVIEW_INGRESS_PORT=8081', '-e', `ATOMA_PREVIEW_UPSTREAM_HOST=${pinned.app}`,
        '-e', 'ATOMA_PREVIEW_UPSTREAM_PORT=8080', '--entrypoint', 'node', this.options.relayImage, '/app/dist/tools/previewIngress.js']);
      await this.run(['network', 'connect', '--ip', pinned.relay, n.internal, n.relay]);
    } catch (error) { await this.stopHosting(id); throw error; }
  }
  /** Every object of this deployment exists, unstarted, made for exactly this spec, and nothing else of it exists. */
  private async created(spec: HostingLaunch, n: ReturnType<DockerHosting['names']>): Promise<boolean> {
    const expected = [n.app, n.relay, ...(spec.browser ? [n.proxy] : [])];
    const digest = this.specDigest(spec);
    const rows = (await this.run(['ps', '-a', '--filter', `label=dev.atoma.deployment=${spec.deploymentId}`, '--format', '{{.Names}} {{.State}} {{.Label "dev.atoma.spec"}}']))
      .split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts[0]);
    if (rows.length !== expected.length || !expected.every(name => rows.some(([found, state, made]) => found === name && state === 'created' && made === digest))) return false;
    for (const name of [n.internal, n.uplink]) {
      if ((await this.run(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])).trim() !== name) return false;
    }
    return true;
  }
  private async address(container: string, network: string): Promise<string> {
    return (await this.run(['inspect', '--format', `{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{.IPAddress}}{{end}}`, container])).trim();
  }
  /**
   * Starts a deployment: its prepared objects when `createHosting` made them
   * for this spec, otherwise it creates them first. Either way only starts
   * remain here, so an update's outage is the start and its readiness.
   */
  async startHosting(raw: HostingLaunch): Promise<HostingHandle> {
    const spec = hostingLaunchSchema.parse(raw);
    const { id, n } = this.launchable(spec);
    // Recovery observes the existing runtime; it never silently replaces its image.
    const existing = await this.inspectHosting(id); if (existing) return existing;
    if (!await this.created(spec, n)) await this.createHosting(spec);
    try {
      const pinned = pinnedHostingAddresses(await this.run(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', n.internal]));
      if (spec.browser) {
        await this.run(['start', n.proxy]);
        if (await this.address(n.proxy, n.internal) !== pinned.proxy) throw new Error('No browser proxy address');
      }
      await this.run(['start', n.app]);
      if (await this.address(n.app, n.internal) !== pinned.app) throw new Error('No isolated application address');
      await this.run(['start', n.relay]);
      const handle = await this.inspectHosting(id); if (!handle) throw new Error('Hosting start failed');
      return handle;
    } catch (error) { await this.stopHosting(id); throw error; }
  }
  /**
   * Every deployment with containers or networks here, from their creation
   * labels. Objects created before the identity labels (2026-10-25) are not
   * listed: only a start made them then, after the row naming them existed.
   */
  async listHosting(): Promise<HostingIdentity[]> {
    const format = '{{.Label "dev.atoma.org"}};{{.Label "dev.atoma.project"}};{{.Label "dev.atoma.deployment"}}';
    const lines = [
      ...(await this.run(['ps', '-a', '--filter', 'label=dev.atoma.owner=hosting', '--format', format])).split('\n'),
      ...(await this.run(['network', 'ls', '--filter', 'label=dev.atoma.owner=hosting', '--format', format])).split('\n'),
    ];
    const found = new Map<string, HostingIdentity>();
    for (const line of lines) {
      const [orgId, projectId, deploymentId] = line.trim().split(';');
      const parsed = hostingIdentitySchema.safeParse({ orgId, projectId, deploymentId });
      if (parsed.success) found.set(parsed.data.deploymentId, parsed.data);
    }
    return [...found.values()];
  }
  async stopHosting(id: HostingIdentity): Promise<void> {
    const n = this.names(id);
    // Confirm absence before releasing networks. No source or data deletion here.
    // The application, which alone writes the project's data, stops first
    // and keeps its ten seconds. The relay and the proxy are stateless Node
    // processes that ignore SIGTERM as PID 1: their ten-second grace was ten
    // seconds of outage each (measured 2026-10-25: a Node update's stop went
    // from 20.6 s to 10.6 s), and nothing is left for them to carry.
    for (const [name, grace] of [[n.app, '10'], [n.relay, '0'], [n.proxy, '0']] as const) {
      const present = await this.run(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
      if (present.trim()) { await this.run(['stop', '--time', grace, name]); await this.run(['rm', '-f', name]); }
    }
    for (const name of [n.internal, n.uplink]) {
      const present = await this.run(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
      if (present.trim()) await this.run(['network', 'rm', name]);
    }
  }
}
