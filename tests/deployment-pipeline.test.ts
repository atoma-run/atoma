import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const hostDeploy = readFileSync('deploy/host-deploy.sh', 'utf8');
const sshCommand = readFileSync('deploy/ssh-command.sh', 'utf8');
const service = readFileSync('deploy/atoma.service', 'utf8');
const deployEnv = readFileSync('deploy/deploy.env.example', 'utf8');
const preflight = readFileSync('src/cli/deploy-preflight.ts', 'utf8');
const releaseSmoke = readFileSync('scripts/release-smoke.mjs', 'utf8');

describe('post-CI deployment pipeline', () => {
  it('packages the exact verified main revision and no runtime state', () => {
    expect(ci).toContain('root="atoma-${GITHUB_SHA}"');
    expect(ci).toContain('printf \'%s\\n\' "${GITHUB_SHA}" > "deployment/${root}/REVISION"');
    expect(ci).toContain('name: atoma-deploy-${{ github.sha }}');
    expect(ci).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    const packageStep = ci.slice(ci.indexOf('Package the exact main revision'), ci.indexOf('Upload immutable'));
    for (const forbidden of ['atoma.db', 'runs', 'skills', '.env ']) {
      expect(packageStep).not.toContain(forbidden);
    }
  });

  it('runs only after a successful main push CI and remains explicitly disarmed by default', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [CI]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("vars.ATOMA_DEPLOY_ENABLED == 'true'");
    expect(workflow).toMatch(/environment:\n\s+name: production/);
    expect(workflow).toMatch(/permissions:\n\s+actions: read\n\s+contents: read/);
  });

  it('downloads from the triggering run and never deploys a floating checkout', () => {
    expect(workflow).toContain('run-id: ${{ github.event.workflow_run.id }}');
    expect(workflow).toContain('name: atoma-deploy-${{ github.event.workflow_run.head_sha }}');
    expect(workflow).toContain('sha256sum -c');
    expect(workflow).toContain('StrictHostKeyChecking=yes');
    expect(workflow).toContain('UserKnownHostsFile=');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toMatch(/git (pull|checkout|reset)/);
  });

  it('keeps a quiet long-running activation alive across the SSH channel', () => {
    expect(workflow).toContain('-o ServerAliveInterval=15');
    expect(workflow).toContain('-o ServerAliveCountMax=20');
    expect(workflow).toContain('-o TCPKeepAlive=yes');
  });

  it('keeps the deployment input validation syntactically valid Bash', () => {
    const start = workflow.indexOf('      - name: Verify deployment inputs and artifact');
    const end = workflow.indexOf('      - name: Install pinned SSH identity and host key', start);
    const step = workflow.slice(start, end);
    const runMarker = '        run: |\n';
    const script = step.slice(step.indexOf(runMarker) + runMarker.length).replace(/^ {10}/gm, '');
    const parsed = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });

    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it('drains before stopping and rolls back both code and worker identity on failed health', () => {
    expect(hostDeploy.indexOf('ATOMA_DEPLOY_LOCK_PATH')).toBeLessThan(
      hostDeploy.lastIndexOf('systemctl stop "${SERVICE_NAME}"')
    );
    expect(hostDeploy.indexOf('--hold')).toBeLessThan(
      hostDeploy.lastIndexOf('systemctl stop "${SERVICE_NAME}"')
    );
    expect(hostDeploy).toContain('GUARD_READY_FILE');
    expect(hostDeploy).toContain(
      'GUARD_DIR="$(mktemp -d "${DEPLOY_ROOT}/.deploy-guard-${REVISION}.XXXXXX")"'
    );
    expect(hostDeploy).not.toContain('GUARD_DIR="${WORK_DIR}/guard"');
    expect(hostDeploy).toContain(
      'install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${GUARD_DIR}"'
    );
    expect(hostDeploy).toContain('"${DEPLOY_ROOT}"/.deploy-guard-*) rm -rf -- "${GUARD_DIR}"');
    expect(hostDeploy).toContain('--admission-marker "${MARKER_PATH}"');
    expect(hostDeploy).toContain('WORKER_ROLLBACK_TAG="atoma-worker:rollback-${OLD_REVISION}"');
    expect(hostDeploy).toContain('mv -Tf "${rollback_link}" "${CURRENT}"');
    expect(hostDeploy).toContain('ATOMA_DEPLOY_HEALTH_URL must be a loopback HTTP URL');
  });

  it('serialises on the host and restores the old generation after any activation failure', () => {
    expect(hostDeploy).toContain('flock -n 9 || fail "another deployment is already active"');
    expect(hostDeploy.indexOf('flock -n 9')).toBeLessThan(hostDeploy.indexOf('cat >"${BUNDLE}"'));
    expect(hostDeploy).toMatch(
      /if \[\[ "\$\{status\}" -ne 0 && "\$\{ACTIVATION_STARTED\}" -eq 1 \]\]; then\s+restore_previous_generation/
    );
    expect(hostDeploy).toContain("trap 'exit 129' HUP");
    expect(hostDeploy).toContain("trap 'exit 130' INT");
    expect(hostDeploy).toContain("trap 'exit 143' TERM");
    expect(hostDeploy.indexOf('ACTIVATION_STARTED=1')).toBeLessThan(
      hostDeploy.lastIndexOf('systemctl stop "${SERVICE_NAME}"')
    );
    expect(hostDeploy).toContain('docker image rm atoma-worker:latest');
    expect(preflight).toMatch(/finally \{\s+lease\?\.release\(\);[\s\S]+rmSync\(resolve\(options\.admissionMarker\)/);
  });

  it('refreshes the mender after the application is healthy, outside the rollback section', () => {
    // 2026-09-07: the mender runs from its OWN clone, so nothing moved it to
    // the deployed revision — it stayed on whatever install-mender.sh last
    // pinned while mender.env already described the new one. The refresh runs
    // after health verification and after ACTIVATION_STARTED is cleared, so a
    // mender failure can never restore the previous application generation.
    const healthy = hostDeploy.indexOf('fail "new generation failed health verification"');
    const closed = hostDeploy.lastIndexOf('ACTIVATION_STARTED=0');
    const refresh = hostDeploy.indexOf('\nrefresh_mender\n');
    expect(healthy).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(healthy);
    expect(refresh).toBeGreaterThan(closed);
    // A host without a mender skips; a present one is moved to THIS revision,
    // rebuilt with its image and unit, and restarted.
    expect(hostDeploy).toContain('echo "mender: not installed on this host');
    expect(hostDeploy).toContain('git checkout --quiet --detach "$MENDER_REVISION"');
    expect(hostDeploy).toContain('docker build -f docker/mender.Dockerfile -t atoma-mender:local .');
    expect(hostDeploy).toContain('"/etc/systemd/system/${MENDER_SERVICE}"');
    expect(hostDeploy).toContain('systemctl start "${MENDER_SERVICE}"');
    // Failure is reported, not hidden, and names the application as deployed.
    expect(hostDeploy).toContain('(the application itself is deployed)');
    expect(hostDeploy).toContain('ATOMA_DEPLOY_MENDER_CHECKOUT');
    expect(readFileSync('deploy/deploy.env.example', 'utf8')).toContain('ATOMA_DEPLOY_MENDER_ENV=');
  });

  it('waits for running work behind a guard that can, and refuses busy work as 75', () => {
    // 2026-09-27: two deployments in a row were refused behind back-to-back
    // mends, and at a steady run rate the slot never frees at all.
    expect(hostDeploy).toContain('WAIT_SECONDS="${ATOMA_DEPLOY_WAIT_SECONDS:-1800}"');
    expect(hostDeploy).toContain('ATOMA_DEPLOY_WAIT_SECONDS must be an integer between 0 and 14400');
    // The guard runs from the OLD release: wait only when it says it can, and
    // never through `| grep -q`, whose early exit is a pipefail.
    expect(hostDeploy).toContain('[[ "${usage}" == *"--wait-ms"* ]]');
    expect(hostDeploy).not.toMatch(/--help[^\n]*\|\s*grep -q/);
    expect(hostDeploy).toContain('GUARD_WAIT_ARGS=(--wait-ms "$((WAIT_SECONDS * 1000))")');
    expect(hostDeploy).toContain('"${GUARD_WAIT_ARGS[@]}"');
    // Waiting needs a guard that can, and a marker directory the service
    // user (who writes the freeze in that mode) can write; otherwise the
    // legacy path freezes first, as the old guard expects.
    const choice = hostDeploy.slice(
      hostDeploy.indexOf('if (( WAIT_SECONDS > 0 )) && guard_waits; then'),
      hostDeploy.indexOf('if (( ${#GUARD_WAIT_ARGS[@]} > 0 )); then')
    );
    expect(choice.indexOf('if marker_dir_writable_by_service; then')).toBeLessThan(choice.indexOf('GUARD_WAIT_ARGS=(--wait-ms'));
    expect(hostDeploy).toContain('runuser -u "${SERVICE_USER}" -- test -w "$(dirname "${MARKER_PATH}")"');
    expect(hostDeploy).toContain('usage="$(timeout 30 runuser');
    // A present state directory is never re-moded (it was reset to 0755 on
    // every deployment); an absent one belongs to the service user.
    expect(hostDeploy).not.toContain('install -d -m 0755 "$(dirname "${MARKER_PATH}")"');
    const branch = hostDeploy.slice(
      hostDeploy.indexOf('if (( ${#GUARD_WAIT_ARGS[@]} > 0 )); then'),
      hostDeploy.indexOf('GUARD_DIR="$(mktemp -d')
    );
    expect(branch.indexOf('rm -f -- "${MARKER_PATH}"')).toBeGreaterThan(0);
    expect(branch.indexOf('rm -f -- "${MARKER_PATH}"')).toBeLessThan(branch.indexOf('else'));
    expect(branch.indexOf('install -m 0644 /dev/null "${MARKER_PATH}"')).toBeGreaterThan(branch.indexOf('else'));
    // A second signal cannot cut the cleanup (and a restoration) short.
    expect(hostDeploy).toMatch(/cleanup\(\) \{\n {2}local status=\$\?\n(?: {2}#[^\n]*\n)+ {2}trap '' HUP INT TERM\n/);
    // A busy refusal is EX_TEMPFAIL, not a broken host.
    expect(hostDeploy).toMatch(/refuse\(\) \{\n {2}echo "deployment refused: \$\*" >&2\n {2}exit 75\n\}/);
    expect(hostDeploy).toContain('[[ "${guard_status}" -eq 75 ]] && refuse');
    // A dead channel fails a write as EPIPE instead of killing the shell
    // before its EXIT trap, which is what restores the previous generation.
    expect(hostDeploy).toContain("trap '' PIPE");
    // Writes and previews resume once the new generation is healthy, not
    // after the retention prune and the mender rebuild.
    const healthy = hostDeploy.indexOf('echo "deployed ${REVISION} to ${SERVICE_NAME}"');
    const lifted = hostDeploy.indexOf('rm -f -- "${MARKER_PATH}"', healthy);
    expect(lifted).toBeGreaterThan(healthy);
    expect(lifted).toBeLessThan(hostDeploy.indexOf('\nrefresh_mender\n'));
    // The job outlives the longest wait plus activation and mender refresh.
    expect(workflow).toContain('timeout-minutes: 75');
    expect(deployEnv).toContain('ATOMA_DEPLOY_WAIT_SECONDS=1800');
  });

  it('prepares the new release while the old generation serves, and stops only to switch', () => {
    // 2026-09-27: the install, the smoke and the image build ran with the
    // service stopped — about 30 s of outage on every deployment.
    const prepare = hostDeploy.indexOf('if [[ "${TARGET_RELEASE}" != "${OLD_RELEASE}" ]]; then\n  prepare_release\n');
    const stop = hostDeploy.indexOf(
      'ACTIVATION_STARTED=1\nsystemctl stop "${SERVICE_NAME}"\n(( PREPARED )) || prepare_release\n'
    );
    expect(prepare).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(prepare);
    const body = hostDeploy.slice(hostDeploy.indexOf('prepare_release() {'), prepare);
    expect(body).toContain('npm ci --omit=dev');
    expect(body).toContain('node scripts/release-smoke.mjs');
    expect(body).toContain('-f docker/worker.Dockerfile -t "atoma-worker:${REVISION}"');
    // The mutable worker tag moves only once the old generation is stopped.
    expect(hostDeploy.indexOf('docker tag "atoma-worker:${REVISION}" atoma-worker:latest')).toBeGreaterThan(stop);
  });

  it('rebuilds the mender from the verified release, reinstalling only for a changed lockfile', () => {
    // 2026-09-27: `npm ci` and `tsc` took about 90 s of every deployment on
    // the 4 GB host, with the run lease held throughout.
    const refresh = hostDeploy.slice(hostDeploy.indexOf('refresh_mender() {'), hostDeploy.indexOf('\nrefresh_mender\n'));
    expect(refresh).toContain('MENDER_RELEASE_DIST="${TARGET_RELEASE}/dist"');
    expect(refresh).toContain('cp -a "$MENDER_RELEASE_DIST" dist');
    expect(refresh).not.toContain('npx tsc');
    expect(refresh).toContain('stamp="$(sha256sum package-lock.json | cut -d" " -f1) $(node --version)"');
    expect(refresh.indexOf('HUSKY=0 npm ci')).toBeGreaterThan(refresh.indexOf('!= "$stamp" ]]'));
    expect(refresh.indexOf('node_modules/.atoma-install-stamp\n    fi')).toBeGreaterThan(refresh.indexOf('HUSKY=0 npm ci'));
  });

  it('proves the worker beside the hermetic checks, and installs LibreOffice during npm ci', () => {
    // 2026-09-27: the worker job waited for `core` (1.6 min) and LibreOffice
    // waited for npm ci (25–50 s), on the path every deployment waits for.
    const worker = ci.slice(ci.indexOf('\n  worker:\n'));
    expect(worker.slice(0, worker.indexOf('steps:'))).not.toContain('needs:');
    const core = ci.slice(ci.indexOf('\n  core:\n'), ci.indexOf('\n  i18n:\n'));
    const start = core.indexOf('name: Start installing LibreOffice');
    const install = core.indexOf('- run: npm ci');
    const finish = core.indexOf('name: Finish installing LibreOffice');
    const check = core.indexOf('- run: npm run release:check');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(install);
    expect(install).toBeLessThan(finish);
    expect(finish).toBeLessThan(check);
    // Detached, or the runner would hold the step open until apt finished.
    expect(core).toContain(') > /dev/null 2>&1 < /dev/null &');
  });

  it('keeps the host activator syntactically valid Bash', () => {
    const parsed = spawnSync('bash', ['-n', 'deploy/host-deploy.sh'], { encoding: 'utf8' });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it('restricts the SSH key and keeps state/environment outside the release link', () => {
    expect(sshCommand).toContain('SSH_ORIGINAL_COMMAND');
    expect(sshCommand).toMatch(/\^deploy\\ \(\[0-9a-f\]\{40\}\)\\ \(\[0-9a-f\]\{64\}\)\$/);
    expect(sshCommand).not.toContain('eval');
    expect(service).toContain('WorkingDirectory=/home/atoma/current');
    expect(service).toContain('EnvironmentFile=/home/atoma/config/atoma.env');
    expect(service).toContain('RequiresMountsFor=/home/atoma');
    expect(service).not.toContain('.env.example');
    expect(hostDeploy).toContain('DEPLOY_ROOT="${ATOMA_DEPLOY_ROOT:-/home/atoma}"');
    expect(hostDeploy).toContain('findmnt --mountpoint "${REQUIRED_MOUNT}"');
    expect(hostDeploy.indexOf('findmnt --mountpoint')).toBeLessThan(
      hostDeploy.indexOf('install -d -m 0755 "${DEPLOY_ROOT}"')
    );
    expect(deployEnv).toContain('ATOMA_DEPLOY_ROOT=/home/atoma');
    expect(deployEnv).toContain('ATOMA_DEPLOY_REQUIRED_MOUNT=/home/atoma');
    expect(deployEnv).toContain('ATOMA_DEPLOY_APP_ENV=/home/atoma/config/atoma.env');
    for (const legacyRoot of ['/opt/atoma', '/var/lib/atoma']) {
      expect(hostDeploy).not.toContain(legacyRoot);
      expect(service).not.toContain(legacyRoot);
      expect(deployEnv).not.toContain(legacyRoot);
    }
    expect(releaseSmoke).toContain("mkdtempSync(join(tmpdir(), 'atoma-release-smoke-'))");
    expect(releaseSmoke).not.toContain("join(root, 'smoke-store.db')");
    expect(releaseSmoke).not.toContain("join(root, 'smoke-runs')");
    expect(releaseSmoke).toContain('rmSync(smokeRoot, { recursive: true, force: true })');
  });
});
