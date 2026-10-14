import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, chownSync } from 'node:fs';
import path from 'node:path';
import { isIPv4 } from 'node:net';
import { hostingIdentitySchema, hostingLaunchSchema, type HostingIdentity, type HostingLaunch, type HostingHandle, type HostingLauncher } from '../contracts/projectHosting.js';
import type { AsyncDockerRunner } from './docker.js';

const exec = promisify(execFile);
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
  async startHosting(raw: HostingLaunch): Promise<HostingHandle> {
    const spec = hostingLaunchSchema.parse(raw);
    if (spec.browser && (spec.kind !== 'node' || !this.options.browserImage)) throw new Error('Browser hosting is not configured');
    const id = { orgId: spec.orgId, projectId: spec.projectId, deploymentId: spec.deploymentId };
    const n = this.names(id);
    // Recovery observes the existing runtime; it never silently replaces its image.
    const existing = await this.inspectHosting(id); if (existing) return existing;
    await this.stopHosting(id);
    await this.prepareHosting(id);
    const labels = ['--label', 'dev.atoma.owner=hosting', '--label', `dev.atoma.deployment=${spec.deploymentId}`];
    try {
      await this.run(['network', 'create', '--internal', ...labels, '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--opt', 'com.docker.network.bridge.gateway_mode_ipv6=isolated', n.internal]);
      await this.run(['network', 'create', ...labels, n.uplink]);
      const bounds = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.5', '--pids-limit', '128', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2'];
      let proxyIp = '';
      if (spec.browser) {
        await this.run(['run', '-d', '--name', n.proxy, ...labels, '--restart', 'unless-stopped', '--network', n.uplink,
          '--user', this.options.user, '--read-only', ...bounds, '-e', 'ATOMA_EGRESS_ALLOWLIST=*',
          '--entrypoint', 'node', this.options.relayImage, '/app/dist/tools/egressProxy.js']);
        await this.run(['network', 'connect', n.internal, n.proxy]);
        proxyIp = (await this.run(['inspect', '--format', `{{with index .NetworkSettings.Networks ${JSON.stringify(n.internal)}}}{{.IPAddress}}{{end}}`, n.proxy])).trim();
        if (!isIPv4(proxyIp)) throw new Error('No browser proxy address');
      }
      const appBounds = spec.browser ? ['--memory', '1536m', '--memory-swap', '1536m', '--cpus', '1', '--pids-limit', '256', '--shm-size', '256m'] : [];
      await this.run(['run', '-d', '--name', n.app, ...labels, '--restart', 'unless-stopped', '--network', n.internal,
        ...(spec.browser ? ['--label', 'dev.atoma.browser=true'] : []),
        '--runtime', 'runsc', '--user', this.options.user, '--read-only', ...bounds, ...appBounds,
        '--tmpfs', spec.browser ? '/tmp:rw,noexec,nosuid,size=256m' : '/tmp:rw,noexec,nosuid,size=64m', '--mount', `type=bind,src=${n.source},dst=/workspace,readonly`,
        '--mount', `type=bind,src=${n.data},dst=/data`, '-w', '/workspace',
        '-e', spec.browser ? 'PORT=8082' : 'PORT=8080', '-e', 'HOST=0.0.0.0', '-e', 'NODE_ENV=production', '-e', 'HOME=/tmp', '-e', 'ATOMA_DATA_DIR=/data',
        ...(spec.browser ? ['-e', `ATOMA_BROWSER_PROXY=http://${proxyIp}:3128`, '-e', 'ATOMA_BROWSER_URL=http://127.0.0.1:9222', '-e', 'ATOMA_BROWSER_DESKTOP_URL=/.atoma/browser/'] : []),
        '--entrypoint', 'node', spec.browser ? this.options.browserImage! : this.options.image,
        ...(spec.browser ? ['/opt/atoma-hosting/browser.mjs', spec.entry] : [spec.kind === 'static' ? '/opt/atoma-hosting/static.mjs' : spec.entry])]);
      const ip = (await this.run(['inspect', '--format', `{{with index .NetworkSettings.Networks ${JSON.stringify(n.internal)}}}{{.IPAddress}}{{end}}`, n.app])).trim();
      if (!isIPv4(ip)) throw new Error('No isolated application address');
      await this.run(['run', '-d', '--name', n.relay, ...labels, '--restart', 'unless-stopped', '--network', n.uplink,
        '-p', '127.0.0.1::8081', ...bounds, '-e', 'ATOMA_PREVIEW_INGRESS_PORT=8081', '-e', `ATOMA_PREVIEW_UPSTREAM_HOST=${ip}`,
        '-e', 'ATOMA_PREVIEW_UPSTREAM_PORT=8080', '--entrypoint', 'node', this.options.relayImage, '/app/dist/tools/previewIngress.js']);
      await this.run(['network', 'connect', n.internal, n.relay]);
      const handle = await this.inspectHosting(id); if (!handle) throw new Error('Hosting start failed');
      return handle;
    } catch (error) { await this.stopHosting(id); throw error; }
  }
  async stopHosting(id: HostingIdentity): Promise<void> {
    const n = this.names(id);
    // Confirm absence before releasing networks. No source or data deletion here.
    for (const name of [n.relay, n.app, n.proxy]) {
      const present = await this.run(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
      if (present.trim()) { await this.run(['stop', '--time', '10', name]); await this.run(['rm', '-f', name]); }
    }
    for (const name of [n.internal, n.uplink]) {
      const present = await this.run(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
      if (present.trim()) await this.run(['network', 'rm', name]);
    }
  }
}
