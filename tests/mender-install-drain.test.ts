import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLeaseWithoutRecovery, peekDeploymentPending, peekRunLease } from '../src/mcp/runLock.js';
import { requestWaitsForDeployment } from '../src/viz/deployment.js';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(done => child.once('close', () => done()));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(markerConfigured = true) {
  const root = mkdtempSync(join(tmpdir(), 'mender-install-drain-'));
  roots.push(root);
  for (const path of ['config', 'current', 'bin']) mkdirSync(join(root, path));
  const lease = join(root, 'lease.db'), marker = join(root, 'admission.lock');
  writeFileSync(join(root, 'config/atoma.env'), [
    `ATOMA_MCP_RUN_LOCK='${lease}'`, `ATOMA_DB_PATH='${root}/product.db'`,
    ...(markerConfigured ? [`ATOMA_DEPLOY_LOCK_PATH='${marker}'`] : ['unset ATOMA_DEPLOY_LOCK_PATH']),
  ].join('\n'));
  // Exercise the installer's actual shell/guard lifecycle with the source CLI;
  // only OS service/account operations and the compiled entrypoint are replaced.
  writeFileSync(join(root, 'bin/node'), `#!/usr/bin/env bash
shift
exec "$TEST_NODE" --import "$TEST_TSX" "$TEST_PREFLIGHT" "$@"
`, { mode: 0o755 });
  const installer = readFileSync('deploy/install-mender.sh', 'utf8');
  const start = installer.indexOf('# Share the activator'), end = installer.indexOf('\nif [[ ! -f "$config" ]]', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const lifecycle = installer.slice(start, end).replaceAll('/home/atoma', root);
  const launch = () => {
    const child = spawn('bash', ['-c', `set -Eeuo pipefail
getent() { printf 'atoma:x:1000:1000:Atoma:%s:/bin/bash\\n' "$TEST_ROOT"; }
chown() { :; }
runuser() { shift 3; "$@"; }
systemctl() {
  [[ "$1" != cat ]] || return 0
  printf '%s %s' "$1" "$2" >> "$TEST_ROOT/services"
  if [[ -f "$TEST_ROOT/admission.lock" ]]; then printf ' guarded' >> "$TEST_ROOT/services"; fi
  printf '\\n' >> "$TEST_ROOT/services"
}
${lifecycle}
touch "$TEST_ROOT/installed"
read -r status
exit "$status"
`], { env: { ...process.env, PATH: `${root}/bin:${process.env['PATH']}`, TEST_ROOT: root,
      TEST_NODE: process.execPath, TEST_TSX: resolve('node_modules/tsx/dist/loader.mjs'),
      TEST_PREFLIGHT: resolve('src/cli/deploy-preflight.ts') }, stdio: 'pipe' });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const done = new Promise<number | null>(resolveDone => child.once('close', resolveDone));
    return { child, done, output: () => output };
  };
  return { root, lease, marker, launch };
}

describe.skipIf(process.platform !== 'linux')('mender installation admission', () => {
  it.each([0, 42])('holds admission through service recovery after installer exit %i', async (status) => {
    const f = fixture();
    const active = acquireRunLeaseWithoutRecovery('existing-run', f.lease);
    const install = f.launch();
    try {
      await expect.poll(() => peekDeploymentPending(f.lease), { timeout: 10_000 }).not.toBeNull();
      expect(existsSync(join(f.root, 'services'))).toBe(false);
      expect(() => acquireRunLeaseWithoutRecovery('racing-run', f.lease)).toThrow();
    } finally { active.release(); }
    await expect.poll(() => existsSync(join(f.root, 'installed')), { timeout: 10_000 }).toBe(true);
    expect(() => acquireRunLeaseWithoutRecovery('late-run', f.lease)).toThrow();
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', { ATOMA_DEPLOY_LOCK_PATH: f.marker })).toBe(true);
    // The same host lock also excludes a second installer while the first owns admission.
    const second = f.launch();
    expect(await second.done, second.output()).toBe(2);
    install.child.stdin.end(`${status}\n`);
    expect(await install.done, install.output()).toBe(status);
    expect(readFileSync(join(f.root, 'services'), 'utf8').trim().split('\n')).toEqual([
      'stop atoma-mender.service guarded', 'stop atoma.service guarded', 'start atoma.service guarded',
    ]);
    expect(existsSync(f.marker)).toBe(false);
    expect(peekRunLease(f.lease)).toBeNull();
    expect(peekDeploymentPending(f.lease)).toBeNull();
    expect(readdirSync(f.root).filter(name => name.startsWith('.mender-install-guard.'))).toEqual([]);
    acquireRunLeaseWithoutRecovery('next-run', f.lease).release();
  }, 25_000);

  it('withdraws a cancelled wait without stopping the running service or stealing its lease', async () => {
    const f = fixture();
    const active = acquireRunLeaseWithoutRecovery('existing-run', f.lease);
    try {
      const install = f.launch();
      await expect.poll(() => peekDeploymentPending(f.lease), { timeout: 10_000 }).not.toBeNull();
      install.child.kill('SIGTERM');
      expect(await install.done, install.output()).not.toBe(0);
      expect(existsSync(join(f.root, 'services'))).toBe(false);
      expect(peekRunLease(f.lease)?.runId).toBe('existing-run');
      expect(peekDeploymentPending(f.lease)).toBeNull();
      expect(existsSync(f.marker)).toBe(false);
    } finally { active.release(); }
  }, 15_000);

  it('refuses before touching services if the guard cannot start', async () => {
    const f = fixture(false);
    const install = f.launch();
    expect(await install.done, install.output()).not.toBe(0);
    expect(existsSync(join(f.root, 'services'))).toBe(false);
    expect(peekRunLease(f.lease)).toBeNull();
    expect(existsSync(f.marker)).toBe(false);
  });
});
