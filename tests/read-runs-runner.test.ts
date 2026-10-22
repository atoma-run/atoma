import { removeReadRunCopies } from '../src/run/readRuns.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockOtherProofReview } from './helpers/delegationReview.js';
import { makePlan } from './helpers/factories.js';
import { silentLogger } from './helpers.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { ensureCanonicalFullStack } from '../src/atoms/capability.js';
import { encodeReadRunsIndex, READ_RUNS_ENV, READ_RUNS_GUIDANCE, readRunCopyPath, type ReadRunsIndex } from '../src/contracts/readRuns.js';
import { HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { setLedgerScope } from '../src/core/ledger.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import { buildTierClients } from '../src/run/providers.js';
import { resetHostLifecycleSnapshotForTests, startTask } from '../src/run/runner.js';
import { containerToolBackend, localToolBackend } from '../src/run/toolBackend.js';
import { startWorkspaceProcess } from '../src/run/workspaceProcess.js';
import { parseRunLog } from '../src/cli/burnin.js';

vi.mock('../src/run/toolBackend.js', async original => ({
  ...await original<typeof import('../src/run/toolBackend.js')>(), containerToolBackend: vi.fn(),
}));
vi.mock('../src/run/providers.js', async original => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));

/**
 * READ RUNS in the run process — docs/decisions/read-runs-2026-10-17.md.
 * A real tenant launch through `startTask`: the product store proves which
 * run this is, the container backend is the local one, and only the models
 * are scripted. The index is written as the coordinator writes it.
 */

const roots: string[] = [];
const workspaceServices: ReturnType<typeof startWorkspaceProcess>[] = [];
afterEach(async () => {
  for (const service of workspaceServices.splice(0)) await service.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks(); resetHostLifecycleSnapshotForTests();
  setLedgerScope(null);
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const READ = {
  'browser/collect-xe-browser.js': 'export const collect = () => "the bytes of run 50019ee0";\n',
  'browser/control-server.js': 'export const port = 3000;\n',
};

/** A tenant run of a project that saved one earlier run, and the index naming that run. */
function tenant(options: { tenant?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-read-runs-runner-'));
  roots.push(root);
  const f = projectRetrievalFixture(root);
  const read = f.makeRun(READ);
  // What a finished workspace holds beside its saved files: none of it is read.
  for (const [path, content] of Object.entries({ 'node_modules/left-pad/index.js': 'dependency', '.env': 'SECRET=1',
    '.atoma-probes.json': '{"version":1,"entries":[]}' })) {
    mkdirSync(join(read.layout.workspacePath, path, '..'), { recursive: true });
    writeFileSync(join(read.layout.workspacePath, path), content);
  }
  const current = f.makeRun();
  const index: ReadRunsIndex = { version: 1, orgId: f.viewer.orgId, projectId: f.project.projectId, runId: current.run.projectRunId,
    readRuns: [{ runId: read.run.projectRunId, status: 'delivered', endedAt: read.run.endedAt!, workspacePath: read.layout.workspacePath,
      manifestHash: read.run.artifactManifestHash!, manifest: read.run.artifactManifest! }] };
  const indexPath = join(current.layout.runRoot, 'read-runs.json');
  const writeIndex = (value: ReadRunsIndex = index) => {
    mkdirSync(current.layout.runRoot, { recursive: true });
    writeFileSync(indexPath, encodeReadRunsIndex(value), { mode: 0o600 });
  };
  writeIndex();
  for (const [key, value] of Object.entries({
    ATOMA_MODEL_L1: 'api:ollama:test', ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test',
    ATOMA_TENANT_RUN: options.tenant === false ? '' : '1', ATOMA_RUN_ID: current.run.projectRunId,
    ATOMA_DB_PATH: f.dbPath, ATOMA_LEDGER_DB: f.dbPath, ATOMA_BUILD_WORKSPACE: current.layout.workspacePath,
    ATOMA_RUNS_DIR: current.layout.runsPath, ATOMA_SKILLS_DIR: current.layout.skillsPath, ATOMA_BUILD_TIMEOUT_MS: '60000',
    ATOMA_EGRESS: '0', ATOMA_SKILL_PROMOTE: '0', ATOMA_SKILL_DIRECT: '0', ATOMA_PREFILTER_CACHE: '0',
    [READ_RUNS_ENV]: indexPath,
  })) vi.stubEnv(key, value);
  vi.stubEnv(HAYSTACK_LAUNCH_ENV, undefined);
  resetHostLifecycleSnapshotForTests();
  const backends: Array<{ readOnlyRunCopies?: boolean }> = [];
  vi.mocked(containerToolBackend).mockImplementation(async opts => {
    backends.push({ ...(opts.readOnlyRunCopies ? { readOnlyRunCopies: true } : {}) });
    // What Docker Desktop does to the mount source at container start: its
    // ctime moves. The identities are taken after this, so a copy reads intact.
    const mountSource = join(opts.workspaceRoot, '.atoma-runs');
    if (existsSync(mountSource)) { await new Promise((resolve) => setTimeout(resolve, 30)); chmodSync(mountSource, 0o755); }
    return localToolBackend({ workspaceRoot: opts.workspaceRoot, logger: silentLogger() });
  });
  const copy = join(current.layout.workspacePath, readRunCopyPath(read.run.projectRunId));
  return { root, f, read, current, index, indexPath, writeIndex, copy, workspace: current.layout.workspacePath, backends };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('a tenant run that reads another run', () => {
  it.skipIf(process.platform === 'win32').each((['intact', 'touched', 'changed'] as const).flatMap(copyState =>
    [{ copyState, remote: false }, { copyState, remote: true }]))('copies and accepts referenced files ($copyState; process workspace: $remote)', async ({ copyState, remote }) => {
    const t = tenant();
    const workspaceService = remote ? startWorkspaceProcess({ root: t.workspace, readRunsIndex: t.indexPath }) : undefined;
    if (workspaceService) workspaceServices.push(workspaceService);
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); });
    }
    const calls: LlmCompletionRequest[] = [];
    let leafName = '';
    let firstCall: { readonly copied: boolean; readonly env: string | undefined } | undefined;
    let refusal = '';
    const perform = async (req: LlmCompletionRequest, name: string, args: Record<string, unknown>) => {
      const startedAt = Date.now();
      const value = await req.executor!.execute(name, args);
      req.onToolInvocation?.({ name, args, result: value, startedAt, durationMs: Date.now() - startedAt });
      return value;
    };
    const path = `.atoma-runs/node_modules/${t.read.run.projectRunId}/browser/collect-xe-browser.js`;
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      firstCall ??= { copied: existsSync(join(t.copy, 'browser/collect-xe-browser.js')), env: process.env[READ_RUNS_ENV] };
      calls.push(req);
      let reply: unknown;
      // A criterion naming the restored file: the host compares it with the read run's saved entry.
      if (req.role === 'draft-checklist') reply = { items: [{ behaviour: 'browser/collect-xe-browser.js holds the bytes of the read run.', check: { kind: 'review' } }] };
      else if (req.role === 'prefilter') reply = { kind: 'reuse', target: leafName, confidence: 'high', reasoning: 'Reuse the canonical executor' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result') reply = { approved: true, reasoning: 'Accepted' };
      else if (req.role === 'plan') reply = { reasoning: 'Restore the file', proposedAction: 'Copy the saved bytes back', expectedOutput: 'Restored file' };
      else if (req.role === 'execute') {
        const read = await perform(req, 'read_file', { path }) as { content: string };
        // The model's write tools refuse a copy (second review 2026-10-17).
        refusal = await req.executor!.execute('write_file', { path, content: 'the run\'s own' }).then(() => 'written', (error: Error) => error.message);
        await perform(req, 'write_file', { path: 'browser/collect-xe-browser.js', content: read.content });
        if (copyState !== 'intact') {
          // A shell can still change a copy as its owner: detected, not
          // prevented. A restore in the wrong direction, from a draft the run
          // wrote. Linux stamps ctimes one jiffy wide, and a model's change
          // comes later than that.
          await new Promise((resolve) => setTimeout(resolve, 30));
          await perform(req, 'write_file', { path: 'draft.js', content: 'export const collect = () => "the run\'s own";\n' });
          await perform(req, 'run_shell', { command: 'cp', args: ['draft.js', path] });
          // Put back to its bytes: equal again, and still reported.
          if (copyState === 'touched') await perform(req, 'run_shell', { command: 'cp', args: ['browser/collect-xe-browser.js', path] });
        }
        reply = { output: { files: ['browser/collect-xe-browser.js'] }, summary: 'Restored from the read run' };
      } else throw new Error(`Unexpected request: ${req.role}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });
    const handle = await startTask(['--container', '--depth', 'short', '--no-learn-skills', '--no-promote-skills', '--no-direct-skills',
      `Restore browser/collect-xe-browser.js to the bytes of run ${t.read.run.projectRunId}.`], { ...(workspaceService ? { workspaceRuntime: workspaceService.runtime } : {}), seedCatalog(seed, canonical) {
      canonical(seed);
      leafName = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 1)!.name;
    } });
    try {
      expect(await handle.settled).toEqual({ outcome: 'delivered' });
      // Copied before the first model call, and the hand-off gone from the environment.
      expect(firstCall).toEqual({ copied: true, env: undefined });
      // The worker mounts the copies read-only from its first start.
      expect(t.backends).toEqual([{ readOnlyRunCopies: true }]);
      expect(refusal).toMatch(/^write_file: refuse to write into \.atoma-runs\//);
      expect(logs).toContain(`read runs copied: 2 files (${t.read.run.artifactManifest!.totalBytes} bytes) of 1 run(s), with their saved modes, into .atoma-runs/node_modules/`);
      const files: string[] = [];
      const walk = (dir: string, prefix = ''): void => {
        for (const name of readdirSync(dir).sort()) {
          const stat = lstatSync(join(dir, name));
          if (stat.isDirectory()) walk(join(dir, name), `${prefix}${name}/`);
          else files.push(`${prefix}${name}`);
        }
      };
      walk(t.copy);
      // Exactly the saved files: no dependency, secret or probe manifest of the other run.
      expect(files).toEqual(Object.keys(READ).sort());
      expect(lstatSync(join(t.copy, 'browser/control-server.js')).mode & 0o777).toBe(0o644);
      expect(readFileSync(join(t.copy, 'browser/control-server.js'), 'utf8')).toBe(READ['browser/control-server.js']);
      expect(readFileSync(join(t.workspace, 'browser/collect-xe-browser.js'), 'utf8')).toBe(READ['browser/collect-xe-browser.js']);
      if (copyState !== 'changed') expect(readFileSync(join(t.workspace, path), 'utf8')).toBe(READ['browser/collect-xe-browser.js']);
      // ONE listing and ONE sentence per prompt, at the root and in the molecule.
      const listing = `"path":".atoma-runs/node_modules/${t.read.run.projectRunId}"`;
      const root = calls.filter(req => req.actor?.name === 'run-root');
      const molecule = calls.filter(req => req.role === 'execute');
      expect(root).toHaveLength(1);
      expect(molecule).toHaveLength(1);
      for (const req of [...root, ...molecule]) {
        expect(count(req.userContent, listing), req.role).toBe(1);
        expect(count(req.userContent, READ_RUNS_GUIDANCE), req.role).toBe(1);
      }
      const id8 = t.read.run.projectRunId.slice(0, 8);
      const head = `READ RUN COPY (host-checked): .atoma-runs/node_modules/${t.read.run.projectRunId}/`;
      expect(root[0]!.userContent).toContain({
        intact: `${head} still holds the 2 saved files of run ${id8} byte for byte, with their saved modes.`,
        touched: `${head} holds the 2 saved files of run ${id8} byte for byte now, but "browser/collect-xe-browser.js" was changed after the copy: a comparison made meanwhile may be wrong.`,
        changed: `${head} NO LONGER matches the saved files of run ${id8} (changed (bytes or mode): "browser/collect-xe-browser.js"). A comparison with this copy proves nothing about that run.`,
      }[copyState]);
      // The host's own comparison of the file the criterion names, whatever became of the copy.
      expect(root[0]!.userContent).toContain(`READ RUN FILE (host-checked): "browser/collect-xe-browser.js" here is identical to run ${id8}'s saved file (bytes and mode).`);
      // The other run's workspace is exactly as it was saved.
      for (const [file, content] of Object.entries(READ)) expect(readFileSync(join(t.read.layout.workspacePath, file), 'utf8')).toBe(content);
    } finally { await handle.shutdown(); }
  }, 30_000);

  it.each([
    { name: 'outside a tenant run', tenant: false, change: undefined, error: 'read runs require a tenant project run' },
    { name: 'for another project', change: 'project', error: 'read runs were launched for another project' },
    { name: 'for another run', change: 'run', error: 'read runs were launched for another run' },
    { name: 'naming bytes the other run no longer holds', change: 'bytes', error: 'artifact no longer matches its manifest: browser/control-server.js' },
    { name: 'with a forged manifest', change: 'manifest', error: 'its manifest does not match its recorded hash' },
  ] as const)('refuses the index $name, before any model call, and never leaves it in the environment', async ({ tenant: isTenant, change, error }) => {
    const t = tenant({ tenant: isTenant });
    if (change === 'project') t.writeIndex({ ...t.index, projectId: t.f.viewer.orgId });
    if (change === 'run') t.writeIndex({ ...t.index, runId: t.read.run.projectRunId });
    if (change === 'bytes') writeFileSync(join(t.read.layout.workspacePath, 'browser/control-server.js'), 'export const port = 4000;\n');
    if (change === 'manifest') {
      const entry = t.index.readRuns[0]!;
      writeFileSync(t.indexPath, JSON.stringify({ ...t.index, readRuns: [{ ...entry, manifest: { ...entry.manifest,
        files: entry.manifest.files.map(file => ({ ...file, sha256: 'f'.repeat(64) })) } }] }));
    }
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const complete = vi.fn();
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete } });
    await expect(startTask(['--container', '--depth', 'short', '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', 'Restore the file.']))
      .rejects.toThrow(error);
    expect(complete).not.toHaveBeenCalled();
    expect(process.env[READ_RUNS_ENV]).toBeUndefined();
  });

  // A mode change is a reference mutation too. Source disappearance/change
  // cannot invalidate intact bytes already bound to the approved manifest.
  it.skipIf(process.platform === 'win32').each([
    ['intact', false], ['changed', false], ['read-only', false], ['copy-changed', false],
    ['intact', true], ['changed', true], ['read-only', true], ['copy-changed', true],
  ] as const)('a deepening retains the sealed reference and work, but refuses a mutated copy (%s; process=%s)', async (variant, remote) => {
    const changed = variant === 'changed';
    const t = tenant();
    const service = remote ? startWorkspaceProcess({ root: t.workspace, readRunsIndex: t.indexPath }) : undefined;
    if (service) workspaceServices.push(service);
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); });
    }
    let enteredDeep = false;
    let deepSawCopy = false;
    let wroteAbandoned = false;
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      let reply: unknown;
      if (req.actor?.tier === 3 && req.actor.name !== 'run-root' && !enteredDeep) {
        enteredDeep = true;
        expect(readFileSync(join(t.workspace, 'abandoned.txt'), 'utf8')).toBe('attempt one');
        expect(readFileSync(join(t.copy, 'browser/collect-xe-browser.js'), 'utf8')).toBe(READ['browser/collect-xe-browser.js']);
        expect(lstatSync(join(t.copy, 'browser/collect-xe-browser.js')).mode & 0o777).toBe(0o644);
        deepSawCopy = true;
      }
      if (req.actor?.name === 'run-router') reply = { action: 'reuse', name: 'Meristem', reasoning: 'Build fixture' };
      else if (req.role === 'draft-checklist') reply = { items: [] };
      else if (req.role === 'prefilter') reply = { outcome: 'escalate', reasoning: 'Exercise decomposition' };
      else if (req.role === 'validate-plan') reply = { approved: true, reasoning: 'Plan approved', ...mockOtherProofReview(req) };
      else if (req.role === 'validate-result') reply = { approved: false, reasoning: 'Fixture rejects output', scope: 'ephemeral', modifications: {} };
      else if (req.role === 'plan' && req.actor?.tier !== 1) reply = [
        { strategy: 'create', reasoning: 'One phase' },
        makePlan({ subtasks: [{ description: 'Restore browser/collect-xe-browser.js', outputs: ['browser/collect-xe-browser.js'] }], aggregation: { mode: 'sequential' } }),
      ];
      else if (req.role === 'plan' || req.role === 'fallback-plan') reply = { reasoning: 'Restore', proposedAction: 'Copy the saved bytes back', expectedOutput: 'Restored file' };
      else if (req.role === 'execute' || req.role === 'fallback-execute') {
        if (!wroteAbandoned) {
          wroteAbandoned = true;
          // The first attempt holds its copies too.
          expect(existsSync(join(t.copy, 'browser/control-server.js'))).toBe(true);
          await req.executor!.execute('write_file', { path: 'abandoned.txt', content: 'attempt one' });
          if (changed) writeFileSync(join(t.read.layout.workspacePath, 'browser/control-server.js'), 'export const port = 4000;\n');
          if (variant === 'copy-changed') writeFileSync(join(t.copy, 'browser/control-server.js'), 'forged reference');
          if (variant === 'read-only') {
            expect(await req.executor!.execute('run_shell', { command: 'chmod', args: ['-R', 'a-w', '.atoma-runs'] })).toMatchObject({ exitCode: 0 });
          }
        }
        await req.executor!.execute('read_file', { path: 'browser/collect-xe-browser.js' });
        await req.executor!.execute('write_file', { path: 'browser/collect-xe-browser.js', content: READ['browser/collect-xe-browser.js'] });
        reply = { output: { files: ['browser/collect-xe-browser.js'] }, summary: 'Restored' };
      } else throw new Error(`Unexpected mock request: ${req.role}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } };
    } } });
    const handle = await startTask(['--container', '--depth', 'short', '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', 'Restore the file.'],
      service ? { workspaceRuntime: service.runtime } : undefined);
    try {
      const settled = await handle.settled;
      // The same approved-manifest copy survives an original source changing;
      // the workspace's own reference bytes and identity must remain intact.
      expect(readFileSync(join(t.workspace, 'abandoned.txt'), 'utf8')).toBe('attempt one');
      expect(existsSync(`${t.workspace}.prev1`)).toBe(false);
      if (variant === 'copy-changed' || variant === 'read-only') {
        expect(settled.outcome).toBe('failed');
        expect(enteredDeep).toBe(false);
        expect(logs.join('\n')).toContain('Read-run copies changed before deepening');
      } else {
        expect(settled, logs.join('\n')).toEqual({ outcome: 'partial' });
        expect(deepSawCopy).toBe(true);
        expect(logs.filter(line => line.startsWith('read runs copied:'))).toHaveLength(1);
        expect(parseRunLog(logs.join('\n'))).toMatchObject({ outcome: 'partial', deepenings: 1 });
        expect(t.backends).toEqual([{ readOnlyRunCopies: true }, { readOnlyRunCopies: true }]);
      }
    } finally {
      await handle.shutdown();
      if (variant === 'read-only') await removeReadRunCopies(join(t.workspace, '.atoma-runs'));
    }
  }, 30_000);
});
