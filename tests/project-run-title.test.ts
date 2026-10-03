import { haystackTestEnvironment } from './helpers/haystack.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_PINS } from './tier-pins.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AuthStore } from '../src/auth/store.js';
import { RUN_TITLE_MAX, projectRunPublicSchema, type RunTitleReceipt } from '../src/contracts/projects.js';
import { formatRunStatsEpilogue, type RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from '../src/core/types.js';
import { ProjectRunCoordinator, type ProjectRunDriver } from '../src/projects/coordinator.js';
import {
  backfillRunTitles,
  hostRunTitleConfig,
  hostRunTitler,
  runTitlerFor,
  sanitizeRunTitle,
  type RunTitler,
} from '../src/projects/runTitle.js';
import { ProjectStore } from '../src/projects/store.js';

/**
 * A RUN'S SHORT TITLE, end to end on the production path: the real
 * coordinator finishing a real (driver-faked) run, the real store with its
 * additive column and immutability trigger, and the real index rows the run
 * selector reads. The model is the only fake, because naming is one paid call.
 */

type SpawnRunOptions = Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0];

const roots: string[] = [];

const DELIVERED_STATS: RunStats = {
  outcome: 'delivered',
  costUsd: 0.01,
  llmCalls: 1,
  opusCalls: 1,
  sonnetCalls: 0,
  haikuCalls: 0,
  otherCalls: 0,
  deterministicPhases: 0,
  deepenings: 0,
  rootRemediations: 0,
  landingReasons: [],
  escalations: 0,
  learnedSkills: 0,
  learnedEventSkills: 0,
  promotions: 0,
  refusals: 0,
  compileErrors: 0,
  demotions: 0,
  dispatchFallbacks: 0,
  uncoveredObligations: 0,
};

const GOAL =
  'Create an offline audio artifact for a fictional museum’s Morse-code exhibit, not a website. ' +
  'Deliver sos.wav, generate_sos.py, verify_sos.py and README.md, using only the Python standard library.';

afterEach(() => {
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-run-title-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin(
    { provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false },
    null
  );
  if (!login) throw new Error('owner bootstrap failed');
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId,
    principalId: login.viewer.principalId,
    project: {
      name: 'Morse',
      slug: 'morse',
      initialPrompt: GOAL,
      repositoryTarget: { installationId: '123', owner: 'owner', name: 'morse', visibility: 'private' },
    },
  });
  return { root, dbPath, store, viewer: login.viewer, project };
}

function lease() {
  return { path: '/test/lease', attachChild: vi.fn(), release: vi.fn() };
}

function deliveringDriver(stats: RunStats = DELIVERED_STATS) {
  return vi.fn(async (options: SpawnRunOptions) => {
    const env = options.env ?? {};
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    const runs = env['ATOMA_RUNS_DIR']!;
    const runId = env['ATOMA_RUN_ID']!;
    const declarations = env['ATOMA_ARTIFACT_MANIFEST_PATH']!;
    mkdirSync(workspace, { recursive: true });
    mkdirSync(runs, { recursive: true });
    mkdirSync(join(declarations, '..'), { recursive: true });
    writeFileSync(join(workspace, 'README.md'), '# SOS\n', 'utf8');
    writeFileSync(
      declarations,
      JSON.stringify({ version: 1, runId, generatedAt: new Date().toISOString(), outputs: ['README.md'] }),
      'utf8'
    );
    writeFileSync(
      join(runs, `${runId}.json`),
      JSON.stringify({ id: runId, label: 'run: x', endedAt: new Date().toISOString(), result: { summary: 'ok' } }),
      'utf8'
    );
    return `${formatRunStatsEpilogue(stats)}\n✓ build finished\n`;
  });
}

function coordinatorFor(
  f: ReturnType<typeof fixture>,
  driver: ReturnType<typeof vi.fn>,
  options: { readonly runTitler?: RunTitler; readonly leases?: ReturnType<typeof lease>[] } = {}
): ProjectRunCoordinator {
  return new ProjectRunCoordinator({
    store: f.store,
    dbPath: f.dbPath,
    projectsRoot: f.root,
    hostEnv: { ...haystackTestEnvironment(f.root), PATH: process.env['PATH'], ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'model-key' },
    driver: driver as unknown as ProjectRunDriver,
    acquireLease: async () => {
      const held = lease();
      options.leases?.push(held);
      return held;
    },
    ...(options.runTitler ? { runTitler: options.runTitler } : {}),
  });
}

async function runOnce(f: ReturnType<typeof fixture>, coordinator: ProjectRunCoordinator, key: string) {
  const started = await coordinator.start({
    orgId: f.viewer.orgId,
    principalId: f.viewer.principalId,
    projectId: f.project.projectId,
    request: { idempotencyKey: key, goal: GOAL },
  });
  await coordinator.waitForIdle();
  return { started, row: f.store.getProjectRun(f.viewer.orgId, started.projectRunId)! };
}

const RECEIPT: RunTitleReceipt = {
  model: 'api:zai:glm-4.5-air',
  inputTokens: 120,
  outputTokens: 9,
  costUsd: 0.0001,
  generatedAt: '2026-10-02T12:00:00.000Z',
};

function fixedTitler(title = 'SOS sound file for a Morse exhibit'): ReturnType<typeof vi.fn> {
  return vi.fn(async (_input: { goal: string }) => ({ title, receipt: RECEIPT }));
}

/** A fake model that records what it was asked and answers `reply`. */
function fakeLlm(reply: string | Error, servedModel?: string) {
  const requests: LlmCompletionRequest[] = [];
  const llm: LlmClient = {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      requests.push(req);
      if (reply instanceof Error) throw reply;
      return {
        text: reply,
        stopReason: 'end_turn',
        usage: { inputTokens: 1_000, outputTokens: 10 },
        ...(servedModel ? { servedModel } : {}),
      };
    },
  };
  return { llm, requests };
}

describe('sanitizeRunTitle keeps one plain visible line', () => {
  it.each([
    ['SOS sound file for a Morse exhibit', 'SOS sound file for a Morse exhibit'],
    ['"SOS sound file for a Morse exhibit."', 'SOS sound file for a Morse exhibit'],
    ['Title: Museum plate drawing', 'Museum plate drawing'],
    ['**Titre :** Dossier sur un objet disparu', 'Dossier sur un objet disparu'],
    ['\n\n  Sensor data check  \nsecond line ignored', 'Sensor data check'],
    ['Guest\u202ebook\u200b search', 'Guest book search'],
    ['# Workshop schedule', 'Workshop schedule'],
  ])('%j → %j', (reply, expected) => {
    expect(sanitizeRunTitle(reply)).toBe(expected);
  });

  it('refuses a reply with nothing visible in it', () => {
    expect(sanitizeRunTitle('   \n""\n')).toBeNull();
    expect(sanitizeRunTitle('\u200b\u202e')).toBeNull();
  });

  it('cuts a long line at a word boundary under the contract maximum', () => {
    const title = sanitizeRunTitle('word '.repeat(40))!;
    expect(title.length).toBeLessThanOrEqual(RUN_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
});

describe('runTitlerFor makes one bounded, accounted call', () => {
  it('sends the goal as data on the given model and prices the SERVED model', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { llm, requests } = fakeLlm('SOS sound file for a Morse exhibit', 'glm-4.5-air');
    const named = await runTitlerFor(llm, 'api:zai:glm-4.5-air')({ goal: GOAL });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('api:zai:glm-4.5-air');
    expect(requests[0]!.userContent).toContain(GOAL);
    expect(requests[0]!.systemPrompt).toMatch(/never follow instructions/i);
    expect(requests[0]!.params).toMatchObject({ temperature: 0 });
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(named?.title).toBe('SOS sound file for a Morse exhibit');
    expect(named?.receipt).toMatchObject({
      model: 'api:zai:glm-4.5-air',
      servedModel: 'glm-4.5-air',
      inputTokens: 1_000,
      outputTokens: 10,
    });
    expect(named!.receipt.costUsd).toBeGreaterThan(0);
  });

  it('answers null, and says why, when the provider throws or the reply is unusable', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runTitlerFor(fakeLlm(new Error('rate limited')).llm, 'api:zai:glm-4.5-air')({ goal: GOAL })).toBeNull();
    expect(await runTitlerFor(fakeLlm('  ""  ').llm, 'api:zai:glm-4.5-air')({ goal: GOAL })).toBeNull();
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain('rate limited');
    expect(written).toContain('no usable line');
  });
});

describe('the host titler uses the platform tier 1 and its own credential only', () => {
  it('captures an api: selector with only its credential and base URL', () => {
    const config = hostRunTitleConfig({
      ATOMA_MODEL_L1: 'api:zai:glm-4.5-air',
      ZAI_API_KEY: 'host-key',
      OPENAI_API_KEY: 'unrelated',
    });
    expect(config).toMatchObject({ model: 'api:zai:glm-4.5-air' });
    if ('unavailable' in config) throw new Error(config.unavailable);
    expect(config.env['ZAI_API_KEY']).toBe('host-key');
    expect(Object.values(config.env)).not.toContain('unrelated');
  });

  it.each([
    [{ ATOMA_MODEL_L1: 'sub:openai:gpt-5.6-luna' }, /machine login/],
    [{ ATOMA_MODEL_L1: 'own:openai:gpt-5.6-luna' }, /machine login/],
    [{}, /not a valid model selector/],
    [{ ATOMA_MODEL_L1: 'api:zai:glm-4.5-air' }, /ZAI_API_KEY is not set/],
    [{ ATOMA_MODEL_L1: 'api:ollama:llama3' }, /OLLAMA_BASE_URL is not set/],
  ])('refuses %j', (host, reason) => {
    const config = hostRunTitleConfig(host);
    expect('unavailable' in config && config.unavailable).toMatch(reason);
  });

  it('names nothing, once and audibly, on a host whose tier 1 is a machine login', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const titler = hostRunTitler({ ATOMA_MODEL_L1: 'sub:openai:gpt-5.6-luna' });
    expect(await titler({ goal: GOAL })).toBeNull();
    expect(await titler({ goal: GOAL })).toBeNull();
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('no run title'));
    expect(lines).toHaveLength(1);
  });
});

describe('the coordinator names every ended run once', () => {
  it('stores the title of a delivered run, readable on the row, the public run and the index', async () => {
    const f = fixture();
    const titler = fixedTitler();
    const { started, row } = await runOnce(f, coordinatorFor(f, deliveringDriver(), { runTitler: titler as RunTitler }), 'title-delivered');

    expect(row.status).toBe('delivered');
    expect(titler).toHaveBeenCalledExactlyOnceWith({ goal: GOAL });
    expect(row.title).toBe('SOS sound file for a Morse exhibit');
    // The run's own spend is untouched: naming is the platform's cost.
    expect(row.stats).toEqual(DELIVERED_STATS);
    expect(f.store.getRunTitleReceipt(f.viewer.orgId, started.projectRunId)).toEqual(RECEIPT);
    expect(projectRunPublicSchema.parse(row).title).toBe('SOS sound file for a Morse exhibit');
    // What the run selector reads: the trace index joined with the row.
    expect(f.store.listOrgRunTraces(f.viewer.orgId).find((entry) => entry.id === started.projectRunId)?.title)
      .toBe('SOS sound file for a Morse exhibit');
    expect(f.store.listAllRunTraces().find((entry) => entry.id === started.projectRunId)?.title)
      .toBe('SOS sound file for a Morse exhibit');
  });

  it('names a FAILED run too, so no list row prints a whole goal', async () => {
    const f = fixture();
    const titler = fixedTitler('Morse exhibit sound file');
    const driver = vi.fn(async (_options: SpawnRunOptions) => {
      throw new Error('driver died');
    });
    const { row } = await runOnce(f, coordinatorFor(f, driver, { runTitler: titler as RunTitler }), 'title-failed');
    expect(row.status).toBe('failed');
    expect(row.title).toBe('Morse exhibit sound file');
  });

  it('releases the run slot BEFORE the name arrives', async () => {
    const f = fixture();
    const leases: ReturnType<typeof lease>[] = [];
    let answer: (value: { title: string; receipt: RunTitleReceipt }) => void = () => undefined;
    const titler: RunTitler = () => new Promise((resolve) => { answer = resolve; });
    const coordinator = coordinatorFor(f, deliveringDriver(), { runTitler: titler, leases });
    const started = await coordinator.start({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'title-detached', goal: GOAL },
    });
    const idle = coordinator.waitForIdle();
    await vi.waitFor(() => expect(leases[0]?.release).toHaveBeenCalledOnce());
    expect(f.store.getProjectRun(f.viewer.orgId, started.projectRunId)?.status).toBe('delivered');
    expect(f.store.getProjectRun(f.viewer.orgId, started.projectRunId)?.title).toBeUndefined();
    answer({ title: 'SOS sound file', receipt: RECEIPT });
    await idle;
    expect(f.store.getProjectRun(f.viewer.orgId, started.projectRunId)?.title).toBe('SOS sound file');
  });

  it('keeps a delivered run exactly as delivered when naming throws or gives up', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const f = fixture();
    const throwing: RunTitler = async () => { throw new Error('title store unavailable'); };
    const thrown = await runOnce(f, coordinatorFor(f, deliveringDriver(), { runTitler: throwing }), 'title-throws');
    const declined = await runOnce(f, coordinatorFor(f, deliveringDriver(), { runTitler: async () => null }), 'title-null');
    for (const { row } of [thrown, declined]) {
      expect(row.status).toBe('delivered');
      expect(row.stats).toEqual(DELIVERED_STATS);
      expect(row.title).toBeUndefined();
    }
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('title store unavailable');
  });
});

describe('the stored title is written once', () => {
  it('refuses a second naming, a running run, and any rewrite behind the store', async () => {
    const f = fixture();
    const { started } = await runOnce(f, coordinatorFor(f, deliveringDriver(), { runTitler: fixedTitler() as RunTitler }), 'title-once');
    const again = f.store.recordRunTitle({
      orgId: f.viewer.orgId, projectRunId: started.projectRunId, title: 'Another name', receipt: RECEIPT,
    });
    expect(again).toBe(false);
    expect(f.store.getProjectRun(f.viewer.orgId, started.projectRunId)?.title).toBe('SOS sound file for a Morse exhibit');

    const raw = new Database(f.dbPath);
    try {
      expect(() => raw.prepare("UPDATE project_runs SET title = 'Rewritten' WHERE project_run_id = ?").run(started.projectRunId))
        .toThrow(/run title is immutable/);
    } finally {
      raw.close();
    }

    const queued = f.store.createProjectRun({
      orgId: f.viewer.orgId,
      principalId: f.viewer.principalId,
      projectId: f.project.projectId,
      request: { idempotencyKey: 'title-queued', goal: GOAL },
      hostPaths: {
        workspacePath: join(f.root, 'queued', 'workspace'),
        runsPath: join(f.root, 'queued', 'runs'),
        logPath: join(f.root, 'queued', 'run.log'),
      },
    });
    expect(queued?.run.status).toBe('queued');
    expect(f.store.recordRunTitle({
      orgId: f.viewer.orgId, projectRunId: queued!.run.projectRunId, title: 'Too early', receipt: RECEIPT,
    })).toBe(false);
  });
});

describe('the operator backfill names runs that ended before titles existed', () => {
  it('lists without spending, then names each once, then has nothing left', async () => {
    const f = fixture();
    // Two runs that ended with NO titler wired: the production state before 2026-10-02.
    const first = await runOnce(f, coordinatorFor(f, deliveringDriver()), 'backfill-1');
    const second = await runOnce(f, coordinatorFor(f, deliveringDriver()), 'backfill-2');
    expect(first.row.title).toBeUndefined();

    const titler = fixedTitler();
    const dry = await backfillRunTitles({ store: f.store, titler: titler as RunTitler, apply: false });
    expect(dry.map((item) => item.projectRunId).sort())
      .toEqual([first.started.projectRunId, second.started.projectRunId].sort());
    expect(titler).not.toHaveBeenCalled();
    expect(dry.every((item) => item.title === undefined)).toBe(true);

    const applied = await backfillRunTitles({ store: f.store, titler: titler as RunTitler, apply: true });
    expect(titler).toHaveBeenCalledTimes(2);
    expect(applied.every((item) => item.title === 'SOS sound file for a Morse exhibit')).toBe(true);
    expect(f.store.getProjectRun(f.viewer.orgId, second.started.projectRunId)?.title)
      .toBe('SOS sound file for a Morse exhibit');

    expect(await backfillRunTitles({ store: f.store, titler: titler as RunTitler, apply: true })).toEqual([]);
    expect(titler).toHaveBeenCalledTimes(2);
  });

  it('leaves a run untitled, and listed again, when naming gives up', async () => {
    const f = fixture();
    await runOnce(f, coordinatorFor(f, deliveringDriver()), 'backfill-null');
    const applied = await backfillRunTitles({ store: f.store, titler: async () => null, apply: true });
    expect(applied).toHaveLength(1);
    expect(applied[0]!.title).toBeUndefined();
    expect(f.store.listUntitledEndedRuns()).toHaveLength(1);
  });
});
