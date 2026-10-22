import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { modelComparisonCorpusSchema } from '../contracts/modelComparison.js';
import { parseModelSelector } from '../contracts/modelSelector.js';
import { parentTestObservationSchema, parentTestSuiteDigest, type ParentTestSuite } from '../contracts/parentTests.js';
import { containerToolBackend, type ToolBackend } from '../run/toolBackend.js';
import { checkpointWorkspaceDigest } from '../run/checkpointWorkspace.js';
import { DEFAULT_WORKER_IMAGE } from '../tools/containerExecutor.js';
import { spawnRun, parseRunLog } from './burnin.js';

export function readComparisonCorpus(path: string) {
  const bytes = readFileSync(path);
  const corpus = modelComparisonCorpusSchema.parse(JSON.parse(bytes.toString()) as unknown);
  const root = realpathSync(dirname(resolve(path)));
  const seed = realpathSync(resolve(root, corpus.seed));
  const inside = relative(root, seed);
  if (!statSync(seed).isDirectory()) throw new Error('Corpus seed must be a directory');
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Corpus seed must be inside its directory');
  return { corpus, seed, seedDigest: checkpointWorkspaceDigest(seed), digest: createHash('sha256').update(bytes).digest('hex') };
}

/** Same host-owned execution path as parent acceptance; banners grant no score. */
export async function scoreComparison(workspaceRoot: string, suite: ParentTestSuite,
  create: (options: { workspaceRoot: string }) => Promise<ToolBackend> = containerToolBackend) {
  const backend = await create({ workspaceRoot });
  try {
    const result = parentTestObservationSchema.parse(await backend.executor.execute('run_shell', {
      command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs: 180000,
    }));
    if (result.suiteDigest !== parentTestSuiteDigest(suite)) throw new Error('Scorer suite identity mismatch');
    return result;
  } finally { await backend.cleanup(); }
}

/** No model or production pin is changed. Each arm starts from the same seed. */
export async function compareModels(options: { corpusPath: string; models: readonly string[]; out: string }, deps: {
  run?: typeof spawnRun;
  score?: typeof scoreComparison;
  workerImage?: string;
} = {}) {
  const { corpus, seed, seedDigest, digest } = readComparisonCorpus(options.corpusPath);
  if (options.models.length < 2 || new Set(options.models).size !== options.models.length) {
    throw new Error('Supply at least two distinct full model selectors');
  }
  for (const model of options.models) parseModelSelector(model);
  if (existsSync(options.out)) throw new Error('Comparison output already exists; choose a fresh directory');
  const workerImage = deps.workerImage ?? (deps.run ? undefined : execFileSync('docker',
    ['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_WORKER_IMAGE'] ?? DEFAULT_WORKER_IMAGE],
    { encoding: 'utf8', timeout: 15000 }).trim());
  mkdirSync(options.out, { recursive: true });
  const protocol = { version: 1, workerImage: workerImage ?? null, corpus: corpus.id, corpusDigest: digest, seedDigest, models: options.models,
    goal: corpus.goal, suiteDigest: parentTestSuiteDigest(corpus.suite), timeoutMs: corpus.timeoutMs,
    createdAt: new Date().toISOString(), code: { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0 },
    cachePolicy: 'Fresh workspace/store per arm; provider-side caches are not controlled.',
    environment: Object.fromEntries(['ATOMA_CODEX_TOOL_TRANSPORT', 'ATOMA_JEV', 'ATOMA_CONTAINER', 'ATOMA_EGRESS_ALLOWLIST']
      .map(key => [key, process.env[key] ?? null])),
  };
  writeFileSync(join(options.out, 'protocol.json'), JSON.stringify(protocol, null, 2), { flag: 'wx' });
  const rows = [];
  // Alternate the first arm by the immutable corpus digest; retain exact order.
  const models = parseInt(digest.slice(0, 2), 16) % 2 ? [...options.models].reverse() : [...options.models];
  for (const [index, model] of models.entries()) {
    const root = join(resolve(options.out), `arm-${index + 1}`);
    const workspace = join(root, 'workspace');
    mkdirSync(root);
    const startedAt = Date.now();
    let error: string | undefined;
    let stats: ReturnType<typeof parseRunLog> | undefined;
    let score: Awaited<ReturnType<typeof scoreComparison>> | undefined;
    const timings: import('../contracts/runtimeTiming.js').RuntimeTiming[] = [];
    try {
      if (checkpointWorkspaceDigest(seed) !== seedDigest) throw new Error('Comparison seed changed');
      const log = await (deps.run ?? spawnRun)({ goal: corpus.goal, timeoutMs: corpus.timeoutMs,
      onTiming: timing => timings.push(timing), logPath: join(root, 'run.log'), extraArgs: ['--container', '--baseline', '--comparison', '--seed', seed, '--no-learn-skills', '--no-direct-skills'],
      extraEnv: { ...(workerImage ? { ATOMA_WORKER_IMAGE: workerImage } : {}), ATOMA_BASELINE_MODEL: model, ATOMA_MODEL_L1: model, ATOMA_MODEL_L2: model, ATOMA_MODEL_L3: model,
        ATOMA_BUILD_WORKSPACE: workspace, ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
        ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: join(root, 'runs'), ATOMA_PREFILTER_CACHE: '0' },
    });
      stats = parseRunLog(log);
      score = await (deps.score ?? ((root, suite) => scoreComparison(root, suite,
        input => containerToolBackend({ ...input, ...(workerImage ? { image: workerImage } : {}) }))))(workspace, corpus.suite);
    } catch (caught) { error = String(caught); }
    const row = { model, startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, stats, score, timings, ...(error ? { error } : {}),
      correct: !error && stats?.outcome === 'delivered' && score?.status === 'passed' && score.passed > 0 && score.failed === 0 && score.skipped === 0 };
    rows.push(row);
    writeFileSync(join(root, 'score.json'), JSON.stringify(row, null, 2), { flag: 'wx' });
  }
  const result = { protocol, rows, note: 'Single-agent capability comparison; no automatic model promotion or live latency claim.' };
  writeFileSync(join(options.out, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

async function main(argv: readonly string[]) {
  if (argv.includes('--help')) {
    console.log('Usage: compareModels --corpus file.json --model selector --model selector --out fresh-directory [--execute]');
    return;
  }
  const values = (flag: string) => argv.flatMap((value, index) => value === flag && argv[index + 1] ? [argv[index + 1]!] : []);
  const known = new Set(['--corpus', '--model', '--out', '--execute']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!known.has(flag)) throw new Error(`Unknown option: ${flag}`);
    if (flag !== '--execute' && (!argv[++i] || argv[i]!.startsWith('--'))) throw new Error(`${flag} requires a value`);
  }
  const [corpusPath] = values('--corpus'), [out] = values('--out'), models = values('--model');
  if (values('--corpus').length !== 1 || values('--out').length !== 1 || new Set(models).size !== models.length) throw new Error('Duplicate options or model selectors');
  if (!corpusPath || !out || models.length < 2) throw new Error('Supply --corpus, at least two --model values and --out');
  const { corpus, digest } = readComparisonCorpus(corpusPath);
  for (const model of models) parseModelSelector(model);
  if (!argv.includes('--execute')) {
    console.log(JSON.stringify({ dryRun: true, models, corpus, digest, out, note: 'No quota spent. --execute starts model runs.' }, null, 2));
    return;
  }
  const result = await compareModels({ corpusPath, models, out });
  console.log(JSON.stringify(result, null, 2));
  if (result.rows.some(row => !row.correct)) process.exitCode = 1;
}

if (process.argv[1] && /compareModels\.(ts|js)$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
