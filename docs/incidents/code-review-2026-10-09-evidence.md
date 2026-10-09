# Reproductions — revue de code du 9 octobre 2026

Ces reproductions documentent la révision `c07e3548`, avant toute correction.
Elles étayent les findings de la
[revue du 9 octobre](../archive/reviews/code-review-2026-10-09.md) ; ce ne
sont pas des résultats attendus d'une future suite de non-régression.
Référence : `c07e3548e3702a2f5fc50f67cd55778c9dd03753`.

Elles ont été écrites par les relecteurs et les vérificateurs adverses de la
revue, puis **rejouées par l'auteur** sur macOS (Node v24.20.0, dépendances
installées) dans un worktree propre de la référence. Les sorties reproduites
ici sont celles de ce rejeu.

Elles appellent les fonctions de production ; les modèles sont le
`MockLlmClient` du dépôt, des contextes `makeCtx` ou un faux app-server Codex ;
GitHub est le faux client HTTP des tests ; les stores sont des fichiers
temporaires sous `os.tmpdir()` et les serveurs n'écoutent que sur une adresse
loopback et un port éphémère. Aucun appel LLM payant, accès GitHub réel,
conteneur ni store utilisateur. Aucun script ne modifie le dépôt.

Disposition : un checkout de `c07e3548` dans `<scratch>/ref` (avec ses
`node_modules`), les scripts dans `<scratch>/repro/<domaine>/`. Ils importent
le code par `../../ref/src/...` et se lancent depuis le checkout :

```bash
cd <scratch>/ref
npx tsx ../repro/<domaine>/<script>.mts
```

Les scripts qui construisent des atomes ont besoin des pins de tiers (tout
sélecteur valide convient, le LLM est simulé) et du cache de préfiltre coupé,
pour ne rien écrire dans le `./atoma.db` du checkout :

```bash
export ATOMA_MODEL_L1=api:anthropic:claude-haiku-4-5
export ATOMA_MODEL_L2=api:anthropic:claude-haiku-4-5
export ATOMA_MODEL_L3=api:anthropic:claude-haiku-4-5
export ATOMA_PREFILTER_CACHE=0
```

Les chemins machine des sorties sont remplacés par `<scratch>` et `<tmp>`.

## 1.1 — Pause sur une phase dont un processus écrit à l'arrêt (HIGH)

Vrai drain du backend local (`localToolBackend`, `start_node_server`), puis
`release()` dans l'ordre de `src/run/runner.ts:1531-1541`. Quatre serveurs :
sans handler, persistance JSON sur SIGTERM, SQLite en WAL fermé sur SIGTERM,
WAL sans handler. Script : `repro/run/pause-release-real-drain.mts`.

```ts
// Verifier repro for RUN-2: same sequence as runner.ts:1524-1541, but with the PRODUCTION
// backend: localToolBackend's `start_node_server` starts the phase's server, the checkpoint
// records backend.checkpointProcesses(), and the pause runs backend.drain() then release().
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localToolBackend } from '../../ref/src/run/toolBackend.ts';
import { RunCheckpointStore, SequentialCheckpoint } from '../../ref/src/run/checkpoint.ts';
import { withRecoveryEffects } from '../../ref/src/core/recoveryEffects.ts';

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
async function scenario(label: string, serverJs: string, withHandler: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-drain-')));
  const ws = join(root, 'ws'); mkdirSync(ws);
  writeFileSync(join(ws, 'server.js'), serverJs);
  const backend = localToolBackend({ workspaceRoot: ws, logger });
  const store = new RunCheckpointStore(join(root, 'atoma.db'));
  const id = randomUUID();
  const data: any = { version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace: ws,
    policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [], workspaceDigest: null,
    processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600000, lastRunId: null };
  await withRecoveryEffects(async () => {
    const cp = new SequentialCheckpoint(data, store, { fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }),
      deadlineAt: Date.now() + 600000, settle: async () => {}, processes: () => backend.checkpointProcesses!() } as never);
    const exec = cp.tools(backend.executor);
    cp.planned({ description: 'g' } as never, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
    await cp.beforePhase(0, {} as never);
    const started = await exec.execute('start_node_server', { entry: 'server.js' });   // phase 1 starts its server
    store.requestPause(id, 'o');
    let outcome = '';
    try { await cp.afterPhase(0, { output: {}, summary: 's', producedBy: { name: 'C', tier: 2, viaFallback: false },
      trace: [{ kind: 'verdict-result', payload: { approved: true } }] } as never); } catch (e) { outcome = (e as Error).name; }
    const before = readdirSync(ws).sort().join(',');
    await backend.drain!();                                                             // runner.ts:1530
    const after = readdirSync(ws).sort().join(',');
    let rel = 'release OK';
    try { cp.release(); } catch (e) { rel = (e as Error).message; cp.finalizing(); }     // runner.ts:1531, 1540
    console.log(`${label} (SIGTERM handler: ${withHandler}): server ${JSON.stringify(started).slice(0, 60)}...; ${outcome}; ` +
      `files ${before} -> ${after}; release(): ${rel}; status ${JSON.stringify(store.projectStatus(id, 'o'))}`);
    await backend.cleanup();
  });
}
const listen = `const s=require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT)||0,function(){console.log('LISTENING_ON_PORT='+this.address().port)});`;
await scenario('plain server', listen, false);
await scenario('graceful JSON persistence', listen + `process.on('SIGTERM',()=>{require('fs').writeFileSync('notes.json','[]');process.exit(0)});`, true);
await scenario('node:sqlite WAL, close on SIGTERM', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('notes.db');db.exec('PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS n(t);INSERT INTO n VALUES (1)');` + listen + `process.on('SIGTERM',()=>{db.close();process.exit(0)});`, true);
await scenario('node:sqlite WAL, no handler', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('notes.db');db.exec('PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS n(t);INSERT INTO n VALUES (1)');` + listen, false);
```

Sortie :

```text
plain server (SIGTERM handler: false): server {"ok":true,…; PhaseBoundaryPause; files server.js -> server.js; release(): release OK; status {"state":"paused","completed":1,"total":2}
graceful JSON persistence (SIGTERM handler: true): server {"ok":true,…; PhaseBoundaryPause; files server.js -> notes.json,server.js; release(): Workspace changed during shutdown; checkpoint cannot be resumed; status {"state":"unavailable","completed":1,"total":2}
node:sqlite WAL, close on SIGTERM (SIGTERM handler: true): server {"ok":true,…; PhaseBoundaryPause; files notes.db,notes.db-shm,notes.db-wal,server.js -> notes.db,server.js; release(): Workspace changed during shutdown; checkpoint cannot be resumed; status {"state":"unavailable","completed":1,"total":2}
node:sqlite WAL, no handler (SIGTERM handler: false): server {"ok":true,…; PhaseBoundaryPause; files notes.db,notes.db-shm,notes.db-wal,server.js -> notes.db,notes.db-shm,notes.db-wal,server.js; release(): release OK; status {"state":"paused","completed":1,"total":2}
```

## 1.2 — Réponse texte en profondeur `short` refusée par une revue de critères aveugle (MEDIUM)

`runDepthTask('short')` avec le handle exact de `src/run/runner.ts:1186-1189`,
vrai `L2Atom.plan` préfiltre, vrai `L1Atom`, modèle simulé qui ne juge un
critère satisfait que s'il voit la réponse. Bras A : le plan tel que la
production l'enregistre (sans `delivery`) ; bras B : le même plan avec
`delivery: "text"`. Avec `L2_PLAN_DELIVERY=omit`, le plan de remédiation omet
aussi `delivery`. Script : `repro/atoms/short-prefilter-text-e2e.mts`.

```ts
// VERIFIER repro (ATOMS-1), end to end through production code: runDepthTask in SHORT mode with the
// exact handle of runner.ts:1181-1190 (real L2Atom.plan → high-confidence prefilter reuse → real
// L1Atom plan/execute → real L2 phase validation → real acceptRootResult). The mocked model is
// HONEST: a reviewer judges a criterion met only when the delivered answer text is in its prompt.
// Arm A records the plan as production does; arm B only adds delivery:'text' to the same plan.
import { L2Atom } from '../../ref/src/atoms/L2Atom.ts';
import { AtomRegistry } from '../../ref/src/registry/atomRegistry.ts';
import { openDb } from '../../ref/src/registry/db.ts';
import { runDepthTask } from '../../ref/src/run/depth.ts';
import { createAttestationLog } from '../../ref/src/core/attestation.ts';
import type { LlmCompletionRequest, Plan, Task } from '../../ref/src/core/types.ts';
import { makeCtx, jsonText } from '../../ref/tests/helpers.ts';
import { makeTools } from '../../ref/tests/helpers/factories.ts';

const ANSWER = 'THE_DELIVERED_TEXT_ANSWER: the median of 40, 42, 44 is 42; the median is the middle value of the sorted list.';
const checklist = [
  { id: 'c1', behaviour: 'The answer states the median value.', check: { kind: 'review' as const } },
  { id: 'c2', behaviour: 'The answer defines the median.', check: { kind: 'review' as const } },
];
for (const arm of ['A: plan as production records it', 'B: same plan + delivery:text'] as const) {
  const reg = new AtomRegistry(openDb(':memory:'));
  const leaf = reg.create(1, { description: 'analysis molecule', systemPrompt: 'Answer questions.', tools: makeTools(['list_files', 'read_file']), params: {}, createdBy: 'test' });
  const cellType = reg.create(2, { description: 'analysis cell', systemPrompt: 'Route.', tools: [], params: {}, createdBy: 'test' });
  const log = (l: string) => (m: string) => { if (process.env.DEBUG_REPRO) console.log(`[${l}] ${m}`.slice(0, 300)); };
  const ctx = { ...makeCtx({ logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') } }), requireObservedToolAction: true, attempt: 1, attestations: createAttestationLog(),
    tools: { has: () => true, execute: async (name: string) => name === 'list_files' ? 'data.txt' : '40\n42\n44' } } as any;
  const seen: string[] = [];
  const respond = async (req: LlmCompletionRequest) => {
    const has = req.userContent.includes('THE_DELIVERED_TEXT_ANSWER');
    seen.push(`${req.role}/${req.actor?.name ?? '?'}${req.role === 'validate-result' ? ` sawAnswer=${has}` : ''}`);
    let reply: unknown;
    if (req.role === 'prefilter') reply = { kind: 'reuse', target: leaf.name, confidence: 'high', reasoning: 'one molecule answers it' };
    else if (req.role === 'plan' && req.actor?.tier === 2) reply = [
      // The cell's own model plan (remediation pass: the prefilter target is now excluded). Its delivery
      // field is whatever the model writes; L2_PLAN_DELIVERY=omit simulates a model leaving it out.
      { strategy: 'reuse', target: leaf.name, reasoning: 'same molecule, address the refusal' },
      { reasoning: 'answer in text', subtasks: [{ description: 'Compute and define the median of 40, 42, 44.', preferredChild: leaf.name }],
        aggregation: { mode: 'concat' }, expectedOutput: 'the answer', ...(process.env.L2_PLAN_DELIVERY === 'omit' ? {} : { delivery: 'text' }) },
    ];
    else if (req.role === 'plan') reply = { reasoning: 'read then answer', proposedAction: 'list files, answer', expectedOutput: 'the answer' };
    else if (req.role === 'execute') {
      const started = Date.now();
      const value = await req.executor!.execute('list_files', { path: '.' });
      req.onToolInvocation?.({ name: 'list_files', args: { path: '.' }, result: value, startedAt: started, durationMs: 1 });
      reply = { output: ANSWER, summary: 'Answered the question in text.' };
    } else if (req.role === 'validate-result' && req.actor?.name === 'run-text-reference') {
      return { text: 'Reference: the median is 42, the middle value.', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    } else if (req.role === 'validate-result' || req.role === 'validate-plan') {
      const asked = /Review ONLY these criteria: (\[.*\])/.exec(req.userContent);
      const ids = asked ? (JSON.parse(asked[1]!) as Array<{ id: string }>).map(i => i.id) : req.actor?.name === 'run-root' ? ['c1', 'c2'] : [];
      reply = { approved: has || req.role === 'validate-plan', reasoning: has ? 'answer seen' : 'answer text not in evidence: unverified', scope: 'ephemeral', modifications: {},
        ...(ids.length ? { criteria: ids.map(id => ({ id, met: has, reason: has ? 'stated in the answer' : 'unverified: no answer text supplied' })) } : {}) };
    } else throw new Error(`unexpected role ${req.role}`);
    return { text: jsonText(reply), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  for (let i = 0; i < 80; i++) ctx.llm.enqueue(respond);
  const deliveries: Array<string | undefined> = [];
  const task: Task = { description: 'Compute and define the median of 40, 42, 44.' };
  let result: any;
  try { result = await runDepthTask({ mode: 'short', task, ctx, floor: [], checklist, checklistOrigin: { source: 'user', digest: 'd' },
    restart: async () => { throw new Error('no deepening expected'); }, onTopology: () => {}, onAcceptance: () => {},
    createExecutor: () => {
      const cell = L2Atom.fromType(cellType, reg, [], null);
      return { actor: cell, handle: async (t: Task, c: any) => {
        const plan = await cell.plan(t, c);            // runner.ts:1187
        const recorded: Plan = arm.startsWith('B') ? { ...plan, delivery: 'text' } : plan;
        deliveries.push(recorded.delivery);
        c.recordRootPlan?.(recorded);                  // runner.ts:1188
        return cell.execute(t, plan, c);               // runner.ts:1189
      } };
    } }); } catch (error) { console.log('THREW', String(error).slice(0, 200), '\n calls:', seen.join(' | ')); continue; }
  console.log(`\n${arm}: recorded plan.delivery per pass = ${JSON.stringify(deliveries.map(d => d ?? 'undefined'))}`);
  console.log(`  refusal = ${result.refusal ? JSON.stringify(result.refusal.slice(0, 160)) : 'none (delivered)'}; output has answer = ${String(result.output).includes('THE_DELIVERED')}`);
  console.log(`  calls: ${seen.join(' | ')}`);
}
```

Sortie par défaut (le plan de remédiation pose `delivery: "text"`) :

```text
A: plan as production records it: recorded plan.delivery per pass = ["undefined","text"]
  refusal = none (delivered); output has answer = true
  calls: prefilter/Tracheid | plan/Water | validate-plan/Tracheid | execute/Water | validate-result/Tracheid sawAnswer=true | validate-result/run-root sawAnswer=true | validate-result/run-criteria sawAnswer=false | plan/Tracheid | plan/Water | validate-plan/Tracheid | execute/Water | validate-result/Tracheid sawAnswer=true | validate-result/run-text-reference sawAnswer=false | validate-result/run-root sawAnswer=true
B: same plan + delivery:text: recorded plan.delivery per pass = ["text"]
  refusal = none (delivered); output has answer = true
  calls: prefilter/Tracheid | plan/Water | validate-plan/Tracheid | execute/Water | validate-result/Tracheid sawAnswer=true | validate-result/run-text-reference sawAnswer=false | validate-result/run-root sawAnswer=true
```

Sortie avec `L2_PLAN_DELIVERY=omit` :

```text
A: plan as production records it: recorded plan.delivery per pass = ["undefined","undefined"]
  refusal = "c1: unverified: no answer text supplied; c2: unverified: no answer text supplied"; output has answer = true
B: same plan + delivery:text: recorded plan.delivery per pass = ["text"]
  refusal = none (delivered); output has answer = true
```

## 1.3 et 2.3 — Lignée de publication et message de bail (MEDIUM, LOW)

Bout en bout : `ProjectService.acceptDelivery`, coordinateur et
`GitHubPublisher` de production, faux GitHub des tests, bail sur un fichier
temporaire câblé comme en production (jamais `~/.atoma/mcp-run-lock.db`).
Script : `repro/projects/verify-e2e.mts`.

```ts
// Verifier repro (PRJ-1 + PRJ-2) through PRODUCTION ProjectService -> ProjectRunCoordinator -> GitHubPublisher,
// with the FakeGitHub used by tests/repository-sync-coordinator.test.ts. No network, tmp stores, tmp lease file.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubAppClient } from '../../ref/src/github/client.js';
import { GitHubStore } from '../../ref/src/github/store.js';
import { GitHubPublisher } from '../../ref/src/projects/publisher.js';
import { ProjectRunCoordinator, type ProjectRunDriver } from '../../ref/src/projects/coordinator.js';
import { ProjectService, ProjectHttpError } from '../../ref/src/projects/service.js';
import { acquireRunLease } from '../../ref/src/mcp/runLock.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../../ref/src/run/runner.js';
import { HAYSTACK_LAUNCH_ENV } from '../../ref/src/contracts/retrievalHaystack.js';
import { projectRetrievalFixture } from '../../ref/tests/helpers/projectRetrievalLaunch.js';
import { haystackTestRuntime } from '../../ref/tests/helpers/haystack.js';
import { FakeGitHub } from '../../ref/tests/github-api-fake.js';

function setup(lockPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-verify-prj-'));
  const f = projectRetrievalFixture(root);
  const fake = new FakeGitHub();
  const client = new GitHubAppClient({ appId: '123', appSlug: 'test',
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, apiBaseUrl: 'https://api.github.test' },
  { fetch: fake.fetch, now: () => Date.UTC(2026, 7, 23, 12) });
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '123', orgId: f.viewer.orgId, accountId: '701', accountLogin: 'owner',
    targetType: 'Organization', repositorySelection: 'all', permissions: { administration: 'write', contents: 'write' }, connectedByPrincipalId: f.viewer.principalId });
  const publisher = new GitHubPublisher({ client, github, store: f.projects, resolveUserAccessToken: async () => 'user-token' });
  let edit: (w: string) => void = () => {};
  const driver: ProjectRunDriver = async options => {
    const workspace = options.env!['ATOMA_BUILD_WORKSPACE']!;
    const idx = options.extraArgs!.indexOf('--seed');
    if (idx >= 0) cpSync(options.extraArgs![idx + 1]!, workspace, { recursive: true });
    else mkdirSync(workspace, { recursive: true });
    edit(workspace);
    const id = options.env!['ATOMA_RUN_ID']!;
    const manifest = options.env![ARTIFACT_MANIFEST_PATH_ENV]!;
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: 1, runId: id, generatedAt: new Date().toISOString(), outputs: ['app.js'] }));
    const traces = options.env!['ATOMA_RUNS_DIR']!;
    mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${id}.json`), JSON.stringify({ id, endedAt: new Date().toISOString(), result: { summary: 'Verified' } }));
    return '✓ build finished';
  };
  const acquireLease = lockPath
    ? (id: string, scope?: Parameters<typeof acquireRunLease>[2]) => acquireRunLease(id, lockPath, scope) // == production default, tmp path
    : async () => ({ path: 'test', attachChild: () => {}, release: () => {} });
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
    hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)), ATOMA_MODEL_L1: 'api:ollama:qwen3:8b',
      ATOMA_MODEL_L2: 'api:ollama:qwen3:8b', ATOMA_MODEL_L3: 'api:ollama:qwen3:8b', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
    publisher, driver, acquireLease: acquireLease as never });
  const service = new ProjectService({ store: f.projects, coordinator, github });
  const run = async (change: typeof edit) => {
    edit = change;
    const r = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { idempotencyKey: randomUUID(), goal: 'Improve the application.' } });
    await coordinator.waitForIdle();
    const done = f.projects.getProjectRun(f.viewer.orgId, r.projectRunId)!;
    if (done.status !== 'delivered') throw new Error(`run ${done.status}: ${done.error}`);
    return done;
  };
  const accept = (r: { projectRunId: string; artifactManifestHash?: string | null }) =>
    service.acceptDelivery(f.viewer, f.project.projectId, r.projectRunId, { manifestHash: r.artifactManifestHash!, review: 'Client tested it.' });
  const repo = () => Object.fromEntries(['F.txt', 'G.txt', 'H.txt'].map(p => [p, fake.filesOn('owner', 'docs', 'main').get(p)?.text]));
  return { f, fake, coordinator, service, run, accept, repo };
}

// ---------- PRJ-2 ----------
{
  const s = setup();
  const put = (o: Record<string, string>) => (w: string) => { for (const [p, t] of Object.entries(o)) writeFileSync(join(w, p), t); };
  const W = await s.run(put({ 'app.js': 'app', 'F.txt': 'f0', 'G.txt': 'g0', 'H.txt': 'h0' }));
  await s.accept(W);
  console.log('[PRJ-2] W published:', s.f.projects.getPublicationForRun(s.f.viewer.orgId, W.projectRunId)?.status, 'repo', s.repo());
  const X = await s.run(put({ 'F.txt': 'f1', 'G.txt': 'g1' }));           // delivered, NOT accepted
  const Y = await s.run(put({ 'F.txt': 'f2', 'H.txt': 'h2' }));           // ordinary new run: automatic seed
  const yWs = (p: string) => readFileSync(join(Y.hostPaths.workspacePath, p), 'utf8');
  console.log('[PRJ-2] Y seeded from X automatically? G.txt in Y =', yWs('G.txt'), '| Y sync base F sha recorded =',
    JSON.stringify(s.f.projects.getRepositorySync(s.f.viewer.orgId, Y.projectRunId)?.base['F.txt']?.sha?.slice(0, 7)));
  await s.accept(X);                                                       // atoma_run_accept on the OLDER run
  console.log('[PRJ-2] X accepted+published:', s.f.projects.getPublicationForRun(s.f.viewer.orgId, X.projectRunId)?.status, 'repo', s.repo());
  await s.accept(Y);                                                       // then the newer run
  const pubY = s.f.projects.getPublicationForRun(s.f.viewer.orgId, Y.projectRunId) as unknown as Record<string, unknown>;
  console.log('[PRJ-2] Y accepted+published:', pubY?.status, 'conflicts =', pubY?.keptRemote ?? pubY?.kept_remote, '| repo', s.repo(), '| Y accepted F.txt = f2');
  const Z = await s.run(() => {});
  console.log('[PRJ-2] next run Z (seed Y) F.txt =', readFileSync(join(Z.hostPaths.workspacePath, 'F.txt'), 'utf8'), '(Y accepted f2)');
}

// ---------- PRJ-1 ----------
{
  const lockPath = join(mkdtempSync(join(tmpdir(), 'atoma-verify-lock-')), 'lock.db');
  const s = setup(lockPath);
  const V = await s.run((w) => writeFileSync(join(w, 'app.js'), 'v'));     // org B run, scoped lease, released at end
  const orgA = randomUUID();
  const other = await acquireRunLease(`project:${randomUUID()}`, lockPath, { orgId: orgA, maxConcurrent: () => 10 });
  try { await s.accept(V); console.log('[PRJ-1] UNEXPECTED: accepted and published'); }
  catch (e) {
    const err = e as ProjectHttpError;
    console.log('[PRJ-1] acceptDelivery (atoma_run_accept / POST accept) ->', err.constructor.name, (err as { status?: number }).status, err.message);
    console.log('[PRJ-1] acceptance recorded anyway:', !!s.f.projects.getDeliveryAcceptance(s.f.viewer.orgId, V.projectRunId),
      '| publication row:', s.f.projects.getPublicationForRun(s.f.viewer.orgId, V.projectRunId)?.status ?? 'none');
  } finally { other.release(); }
  await s.service.retryPublication(s.f.viewer, s.f.project.projectId, V.projectRunId);
  console.log('[PRJ-1] after org A releases, retry ->', s.f.projects.getPublicationForRun(s.f.viewer.orgId, V.projectRunId)?.status);
}
process.exit(0);
```

Sortie :

```text
[PRJ-2] W published: published repo { 'F.txt': 'f0', 'G.txt': 'g0', 'H.txt': 'h0' }
[PRJ-2] Y seeded from X automatically? G.txt in Y = g1 | Y sync base F sha recorded = "78177fa"
[PRJ-2] X accepted+published: published repo { 'F.txt': 'f1', 'G.txt': 'g1', 'H.txt': 'h0' }
[PRJ-2] Y accepted+published: published conflicts = undefined | repo { 'F.txt': 'f1', 'G.txt': 'g1', 'H.txt': 'h2' } | Y accepted F.txt = f2
[PRJ-2] next run Z (seed Y) F.txt = f1 (Y accepted f2)
[PRJ-1] acceptDelivery (atoma_run_accept / POST accept) -> ProjectHttpError 502 publication retry failed: another MCP server owns the run slot (project:84ede6ad-4b75-43ee-9814-00bce13d9b10, pid 72328, since 2026-10-09T06:37:42.067Z)
[PRJ-1] acceptance recorded anyway: true | publication row: none
[PRJ-1] after org A releases, retry -> published
```

## 1.4 — Reprise refusée après consommation de la source (MEDIUM)

Vrais `AtomRegistry`, `seedTissueCatalog`, `RunCheckpointStore` et
`SequentialCheckpoint` ; le contrôle de `tissueFor` est recopié (closure de
`startTask`). Script : `repro/run/actor-version-resume.mts`.

```ts
// Does an unrelated run (with/without project docs) or a deploy bump Meristem's
// version, and does a project continuation consume its source BEFORE the
// runner's actor check refuses it ("Saved root actor has changed")?
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../ref/src/registry/db.ts';
import { AtomRegistry } from '../../ref/src/registry/atomRegistry.ts';
import { seedTissueCatalog } from '../../ref/src/run/tissues.ts';
import { RunCheckpointStore, SequentialCheckpoint } from '../../ref/src/run/checkpoint.ts';
import { withRecoveryEffects } from '../../ref/src/core/recoveryEffects.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-actor-')));
const dbPath = join(root, 'atoma.db');
const registry = new AtomRegistry(openDb(dbPath));
const schema = { type: 'object', properties: {} };
const base = [{ name: 'read_file', description: 'Read a file', inputSchema: schema }, { name: 'write_file', description: 'Write a file', inputSchema: schema }];
const docs = { name: 'search_project_docs', description: 'Search the project documents', inputSchema: schema };
const log = () => {};
const v = (t: { version: number }) => t.version;
const withDocs = seedTissueCatalog({ registry, toolDecls: [...base, docs], log } as never);
console.log('project run WITH retrieval corpus seeds Meristem   -> v' + v(withDocs));
const again = seedTissueCatalog({ registry, toolDecls: [...base, docs], log } as never);
console.log('same tool set again (no-op guard)                   -> v' + v(again));

// A paused project run rooted in Meristem v(withDocs).
const ws = join(root, 'ws-src'); mkdirSync(ws); writeFileSync(join(ws, 'index.html'), '<p>phase 1 validated</p>');
const store = new RunCheckpointStore(dbPath);
const srcId = randomUUID();
const scope = { orgId: 'org', projectId: 'proj', principalId: 'alice', runId: srcId };
const data: any = { version: 1, id: srcId, scope, goal: 'Build the app', workspace: ws, policy: '{}',
  actor: { name: withDocs.name, atomId: withDocs.atomId, version: withDocs.version }, checklist: [], root: null, completed: [],
  workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600000, lastRunId: null };
const sub = (n: number) => ({ description: `phase ${n}`, child: 'Cell' });
const approved = { output: { ok: true }, summary: 'phase 1 done', producedBy: { name: 'Cell', tier: 2, viaFallback: false },
  trace: [{ kind: 'verdict-result', payload: { approved: true } }] };
await withRecoveryEffects(async () => {
  const cp = new SequentialCheckpoint(data, store, { fresh: true, automatic: true, account: () => ({ tokens: 1000, costUsd: 0.42 }),
    deadlineAt: Date.now() + 600000, settle: async () => {}, processes: () => [], pauseAfter: 1 } as never);
  cp.planned({ description: 'Build the app' } as never, { subtasks: [sub(1), sub(2)], aggregation: { mode: 'sequential' } } as never, {}, 2);
  await cp.beforePhase(0, sub(1) as never);
  try { await cp.afterPhase(0, approved as never); } catch (e) { console.log('phase 1 boundary ->', (e as Error).name); }
  cp.release();
});
console.log('source status while paused:', JSON.stringify(store.projectStatus(srcId, 'org')));

// Meanwhile ANOTHER run of the platform commons has no retrieval corpus (CLI run, other project):
const without = seedTissueCatalog({ registry, toolDecls: base, log } as never);
console.log('unrelated run WITHOUT retrieval corpus seeds Meristem -> v' + v(without));

// The client resumes: the runner reads the source, constructs the successor (consumes the source)...
const saved = store.read(srcId);
const nextId = randomUUID();
const ws2 = join(root, 'ws-next');
await withRecoveryEffects(async () => {
  new SequentialCheckpoint({ ...saved, id: nextId, workspace: ws2, scope: { ...scope, runId: nextId } } as never, store, {
    fresh: false, source: saved, automatic: true, account: () => saved.consumed, deadlineAt: Date.now() + 600000,
    settle: async () => {}, processes: () => [], restoreWorkspace: () => store.materialize(saved, ws2, false) } as never);
  // ...and the successor's own seeding runs before tissueFor (runner.ts:1118-1131):
  const successorSeed = seedTissueCatalog({ registry, toolDecls: [...base, docs], log } as never);
  const stored = registry.getByName(saved.actor!.name)!;
  console.log(`successor seeding -> v${successorSeed.version}; saved actor v${saved.actor!.version}; runner check: ` +
    (stored.version !== saved.actor!.version ? 'THROWS "Saved root actor has changed; resume refused"' : 'passes'));
});
console.log('source status after the refused continuation:', JSON.stringify(store.projectStatus(srcId, 'org')));
try { store.read(srcId); console.log('source still readable'); } catch (e) { console.log('second resume of the source ->', (e as Error).message); }
```

Sortie :

```text
project run WITH retrieval corpus seeds Meristem   -> v1
same tool set again (no-op guard)                   -> v1
phase 1 boundary -> PhaseBoundaryPause
source status while paused: {"state":"paused","completed":1,"total":2}
unrelated run WITHOUT retrieval corpus seeds Meristem -> v2
successor seeding -> v3; saved actor v1; runner check: THROWS "Saved root actor has changed; resume refused"
source status after the refused continuation: {"state":"unavailable","completed":1,"total":2}
second resume of the source -> Checkpoint is not at a resumable phase boundary (in-flight or finished)
```

## 1.5 et 1.6 — Liens rendus absolus par le semis ; frontière de question sans dégradation (MEDIUM)

Vrais `seedWorkspace`, `checkpointWorkspaceDigest` et `SequentialCheckpoint`
automatique. Script : `repro/run/seeded-symlink-question.mts`.

```ts
// Verifier repro for RUN-4 reachability: a project run is seeded by seedWorkspace (cpSync, runner.ts:1006-1012).
// Does an ordinary npm `node_modules/.bin` RELATIVE link survive as a relative link, and what does the
// phase-0 client-question boundary do with the seeded tree (no file over any limit)?
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedWorkspace } from '../../ref/src/run/workspace.ts';
import { checkpointWorkspaceDigest } from '../../ref/src/run/checkpointWorkspace.ts';
import { RunCheckpointStore, SequentialCheckpoint } from '../../ref/src/run/checkpoint.ts';
import { withRecoveryEffects } from '../../ref/src/core/recoveryEffects.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-seed-')));
const seed = join(root, 'previous-run-workspace');
mkdirSync(join(seed, 'node_modules', 'vite', 'bin'), { recursive: true });
mkdirSync(join(seed, 'node_modules', '.bin'), { recursive: true });
writeFileSync(join(seed, 'node_modules', 'vite', 'bin', 'vite.js'), '#!/usr/bin/env node\n');
symlinkSync('../vite/bin/vite.js', join(seed, 'node_modules', '.bin', 'vite'));
writeFileSync(join(seed, 'index.html'), '<p>hi</p>');
console.log('seed digest (relative link):', checkpointWorkspaceDigest(seed).slice(0, 12));
for (const question of [false, true]) {
  const ws = join(root, `ws-${question}`);
  seedWorkspace(seed, ws);
  if (!question) console.log('link after seedWorkspace:', readlinkSync(join(ws, 'node_modules', '.bin', 'vite')));
  const store = new RunCheckpointStore(join(root, `atoma-${question}.db`));
  const id = randomUUID(); const warnings: string[] = [];
  const data: any = { version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace: ws,
    policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [], workspaceDigest: null,
    processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600000, lastRunId: null };
  await withRecoveryEffects(async () => {
    const cp = new SequentialCheckpoint(data, store, { fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }),
      deadlineAt: Date.now() + 600000, settle: async () => {}, processes: () => [], warn: (m: string) => warnings.push(m),
      assessClientQuestion: async () => question ? { question: 'Which database?', options: [
        { id: 'a', label: 'SQLite', consequence: 'file' }, { id: 'b', label: 'Postgres', consequence: 'server' }] } : null } as never);
    cp.planned({ description: 'g' } as never, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
    try {
      await cp.beforePhase(0, {} as never);
      await cp.afterPhase(0, { output: {}, summary: 's', producedBy: { name: 'C', tier: 2, viaFallback: false },
        trace: [{ kind: 'verdict-result', payload: { approved: true } }] } as never);
      console.log(`question=${question}: run continues; warnings=${JSON.stringify(warnings)}`);
    } catch (e) { console.log(`question=${question}: THROWS ${(e as Error).name}: ${(e as Error).message}`); }
  });
}
```

Sortie :

```text
seed digest (relative link): e9e247460ec2
link after seedWorkspace: <tmp>
question=false: run continues; warnings=["Durable continuation unavailable: workspace snapshot could not be committed"]
question=true: THROWS Error: Checkpoint workspace contains an escaping link or special file
```

Même asymétrie avec un fichier de 11 MiB au lieu du lien. Script :
`repro/run/question-boundary-unsupported.mts`.

```ts
// Same unsupported workspace content (a >10 MiB file, as in an imported repo or a seeded node_modules
// binary): afterPhase degrades gracefully for an automatic project checkpoint; does the client-question
// boundary in beforePhase do the same, or does it throw out of the dispatch?
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunCheckpointStore, SequentialCheckpoint } from '../../ref/src/run/checkpoint.ts';
import { withRecoveryEffects } from '../../ref/src/core/recoveryEffects.ts';

async function scenario(label: string, question: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-q-')));
  const ws = join(root, 'ws'); mkdirSync(ws);
  writeFileSync(join(ws, 'dataset.bin'), Buffer.alloc(11 * 1024 * 1024));   // seeded/imported file over maxFileBytes
  const store = new RunCheckpointStore(join(root, 'atoma.db'));
  const id = randomUUID();
  const data: any = { version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace: ws,
    policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [], workspaceDigest: null,
    processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600000, lastRunId: null };
  const warnings: string[] = [];
  await withRecoveryEffects(async () => {
    const cp = new SequentialCheckpoint(data, store, { fresh: true, automatic: true, account: () => ({ tokens: 1, costUsd: 0.1 }),
      deadlineAt: Date.now() + 600000, settle: async () => {}, processes: () => [], warn: (m: string) => warnings.push(m),
      assessClientQuestion: async () => question ? { question: 'Which database should the app use?', options: [
        { id: 'a', label: 'SQLite', consequence: 'local file' }, { id: 'b', label: 'Postgres', consequence: 'server' }] } : null } as never);
    cp.planned({ description: 'g' } as never, { subtasks: [{}, {}], aggregation: { mode: 'sequential' } } as never, {}, 2);
    try {
      await cp.beforePhase(0, {} as never);
      await cp.afterPhase(0, { output: {}, summary: 's', producedBy: { name: 'C', tier: 2, viaFallback: false },
        trace: [{ kind: 'verdict-result', payload: { approved: true } }] } as never);
      console.log(`${label}: run continues; warnings=${JSON.stringify(warnings)}`);
    } catch (e) { console.log(`${label}: THROWS ${(e as Error).name}: ${(e as Error).message}`); }
  });
}
await scenario('afterPhase boundary, no question', false);
await scenario('client-question boundary (phase 0)', true);
```

Sortie :

```text
afterPhase boundary, no question: run continues; warnings=["Durable continuation unavailable: workspace snapshot could not be committed"]
client-question boundary (phase 0): THROWS Error: Checkpoint workspace exceeds file limits
```

## 1.7 — Lot d'appels Codex après épuisement du budget (MEDIUM)

`CodexCliLlmClient` de production contre un faux app-server qui livre les
appels d'une réponse ensemble, comme le test du projet
(`tests/codex-app-server-tool-loop.test.ts`). Le nombre d'appels est le premier
argument. `repro/core/batch-refusals.mts` épuise d'abord le budget ;
`repro/core/batch-refusals-first-response.mts` envoie le lot dès la première
réponse, avec `maxToolIterations: 1`.

```ts
// Repro: a batch of N tool calls issued past the budget. With N > 16 the
// interrupt+finalizing-turn design is pre-empted by MAX_REFUSALS.
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliLlmClient } from '../../ref/src/core/llmCodexCli.ts';

const N = Number(process.argv[2] ?? 20);
const root = mkdtempSync(path.join(tmpdir(), 'atoma-repro-'));
const home = path.join(root, 'codex'); mkdirSync(home);
writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"refresh_token":"r1"}}');

let interrupts = 0, turnStarts = 0;
const spawnFn = (_args: readonly string[], _env: NodeJS.ProcessEnv, _cwd: string) => {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter(); const stderr = new EventEmitter();
  let closed = false; let nextId = 100;
  const emit = (m: unknown) => setImmediate(() => { if (!closed) stdout.emit('data', Buffer.from(JSON.stringify(m) + '\n')); });
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false, end: () => undefined,
    write: (chunk: string) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.method === 'initialize') emit({ id: 1, result: {} });
        else if (m.method === 'thread/start') emit({ id: 2, result: { thread: { id: 't' } } });
        else if (m.method === 'turn/start') {
          emit({ id: m.id, result: { turn: { id: 'u' } } });
          turnStarts++;
          if (turnStarts === 1) {
            emit({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 1, outputTokens: 1 }, last: {} } } });
            for (let i = 0; i < N; i++) emit({ id: nextId++, method: 'item/tool/call', params: { tool: 'fetch_url', arguments: { url: `http://localhost:1/${i}` } } });
          } else {
            emit({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'final in finalizing turn' } } });
            emit({ method: 'turn/completed', params: { turn: { id: 'u2', status: 'completed' } } });
          }
        } else if (m.method === 'turn/interrupt') { interrupts++; emit({ id: m.id, result: {} }); emit({ method: 'turn/completed', params: { turn: { id: 'u', status: 'interrupted' } } }); }
      }
      return true;
    },
  });
  Object.assign(child, { stdout, stderr, stdin, pid: undefined, exitCode: null, signalCode: null,
    kill: () => { if (!closed) { closed = true; setImmediate(() => child.emit('close', null)); } return true; } });
  return child;
};

const client = new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: spawnFn as any });
const executed: string[] = [];
try {
  const r = await client.complete({
    model: 'gpt-5.6-luna', systemPrompt: 's', userContent: 'u', maxToolIterations: 1,
    tools: [{ name: 'fetch_url', description: 'd', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }],
    executor: { has: () => true, execute: async (n: string) => { executed.push(n); return 'ok'; } },
  });
  console.log(`N=${N}: OK text="${r.text}" toolBudgetExhausted=${r.toolBudgetExhausted} interrupts=${interrupts} turnStarts=${turnStarts} executed=${executed.length}`);
} catch (e: any) {
  console.log(`N=${N}: FAILED "${e.message}" partialUsage=${JSON.stringify(e.partialUsage)} interrupts=${interrupts} turnStarts=${turnStarts} executed=${executed.length}`);
}
```

```ts
// Repro: a batch of N tool calls issued past the budget. With N > 16 the
// interrupt+finalizing-turn design is pre-empted by MAX_REFUSALS.
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliLlmClient } from '../../ref/src/core/llmCodexCli.ts';

const N = Number(process.argv[2] ?? 20);
const root = mkdtempSync(path.join(tmpdir(), 'atoma-repro-'));
const home = path.join(root, 'codex'); mkdirSync(home);
writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"refresh_token":"r1"}}');

let interrupts = 0, turnStarts = 0;
const spawnFn = (_args: readonly string[], _env: NodeJS.ProcessEnv, _cwd: string) => {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter(); const stderr = new EventEmitter();
  let closed = false; let nextId = 100;
  const emit = (m: unknown) => setImmediate(() => { if (!closed) stdout.emit('data', Buffer.from(JSON.stringify(m) + '\n')); });
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false, end: () => undefined,
    write: (chunk: string) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.method === 'initialize') emit({ id: 1, result: {} });
        else if (m.method === 'thread/start') emit({ id: 2, result: { thread: { id: 't' } } });
        else if (m.method === 'turn/start') {
          emit({ id: m.id, result: { turn: { id: 'u' } } });
          turnStarts++;
          if (turnStarts === 1) {
            for (let i = 0; i < N; i++) emit({ id: nextId++, method: 'item/tool/call', params: { tool: 'fetch_url', arguments: { url: `http://localhost:1/${i}` } } });
          } else {
            emit({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'final in finalizing turn' } } });
            emit({ method: 'turn/completed', params: { turn: { id: 'u2', status: 'completed' } } });
          }
        } else if (m.method === 'turn/interrupt') { interrupts++; emit({ id: m.id, result: {} }); emit({ method: 'turn/completed', params: { turn: { id: 'u', status: 'interrupted' } } }); }
      }
      return true;
    },
  });
  Object.assign(child, { stdout, stderr, stdin, pid: undefined, exitCode: null, signalCode: null,
    kill: () => { if (!closed) { closed = true; setImmediate(() => child.emit('close', null)); } return true; } });
  return child;
};

const client = new CodexCliLlmClient({ env: { CODEX_HOME: home }, appServerSpawnFn: spawnFn as any });
const executed: string[] = [];
try {
  const r = await client.complete({
    model: 'gpt-5.6-luna', systemPrompt: 's', userContent: 'u', maxToolIterations: 1,
    tools: [{ name: 'fetch_url', description: 'd', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }],
    executor: { has: () => true, execute: async (n: string) => { executed.push(n); return 'ok'; } },
  });
  console.log(`N=${N}: OK text="${r.text}" toolBudgetExhausted=${r.toolBudgetExhausted} interrupts=${interrupts} turnStarts=${turnStarts} executed=${executed.length}`);
} catch (e: any) {
  console.log(`N=${N}: FAILED "${e.message}" partialUsage=${JSON.stringify(e.partialUsage)} interrupts=${interrupts} turnStarts=${turnStarts} executed=${executed.length}`);
}
```

Sorties :

```text
$ npx tsx ../repro/core/batch-refusals.mts 16
N=16: OK text="final in finalizing turn" toolBudgetExhausted=true interrupts=1 turnStarts=2 executed=0
$ npx tsx ../repro/core/batch-refusals.mts 17
N=17: FAILED "Codex requested a tool after its tool budget was exhausted" partialUsage={"inputTokens":1,"outputTokens":1} interrupts=1 turnStarts=1 executed=0
$ npx tsx ../repro/core/batch-refusals-first-response.mts 20
N=20: OK text="final in finalizing turn" toolBudgetExhausted=true interrupts=1 turnStarts=2 executed=12
$ npx tsx ../repro/core/batch-refusals-first-response.mts 29
N=29: FAILED "Codex requested a tool after its tool budget was exhausted" partialUsage={"inputTokens":0,"outputTokens":0} interrupts=1 turnStarts=1 executed=12
```

## 1.8 — Plafond de serveurs node contourné par un handler SIGTERM (MEDIUM)

`startNodeServerTool` de production ; sept démarrages de serveurs qui ignorent
SIGTERM, puis comptage de ceux qui répondent ; fin par `drain()`. Script :
`repro/tools/cap-sigterm-ignored-v2.mts`.

```ts
// Verifier variant: same production tool, logs each start, counts live PIDs, ends with drain() (SIGKILL + confirm).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../../ref/src/tools/sandbox.ts';
import { startNodeServerTool, MAX_LIVE_NODE_SERVERS, type ServedOrigins } from '../../ref/src/tools/builtin.ts';
const ignore = process.argv[2] !== 'obey';
const dir = mkdtempSync(join(tmpdir(), 'cap2-'));
writeFileSync(join(dir, 'server.mjs'), [
  "import { createServer } from 'node:http';",
  ignore ? "process.on('SIGTERM', () => { console.error('draining...'); });" : '',
  "const s = createServer((_q, r) => r.end('ok'));",
  "s.listen(Number(process.env.PORT) || 0, () => console.log('LISTENING_ON_PORT=' + s.address().port));",
].join('\n'));
const sandbox = new ToolSandbox(dir);
const origins: ServedOrigins = new Map();
const tool = startNodeServerTool({ sandbox, servedOrigins: origins });
const started: any[] = [];
for (let i = 0; i < MAX_LIVE_NODE_SERVERS + 3; i++) {
  const t0 = Date.now();
  const r: any = await tool.execute({ entry: 'server.mjs' });
  started.push(r);
  console.log(`start ${i + 1}: ok=${r.ok} port=${r.port} ${Date.now() - t0}ms`);
}
await new Promise((r) => setTimeout(r, 800));
let alive = 0, pidsAlive = 0;
for (const s of started) { try { if ((await fetch(s.url, { signal: AbortSignal.timeout(2000) }).then((r) => r.text())) === 'ok') alive++; } catch {} }
for (const o of origins.values()) { try { if (o.pid) { process.kill(o.pid, 0); pidsAlive++; } } catch {} }
console.log(`mode=${ignore ? 'ignores SIGTERM' : 'obeys SIGTERM'} cap=${MAX_LIVE_NODE_SERVERS} started=${started.length} answering=${alive} pidsAlive=${pidsAlive} stoppedByHost=${[...origins.values()].filter((o) => o.stoppedByHost).length} exited=${[...origins.values()].filter((o) => o.exited).length}`);
await sandbox.drain();
process.exit(0);
```

Sortie :

```text
start 1: ok=true port=… 36ms
start 2: ok=true port=… 36ms
start 3: ok=true port=… 32ms
start 4: ok=true port=… 33ms
start 5: ok=true port=… 33ms
start 6: ok=true port=… 33ms
start 7: ok=true port=… 32ms
mode=ignores SIGTERM cap=4 started=7 answering=7 pidsAlive=7 stoppedByHost=3 exited=0
```

## 1.9 — Liens `.bin` sautés par la copie du terminal de preview (MEDIUM)

`materializePreviewWorkspace` de production sur un workspace avec
`node_modules/.bin/vitest` en lien relatif. Script :
`repro/preview/bin-symlinks.mts`.

```ts
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializePreviewWorkspace } from '../../ref/src/preview/policy.ts';
const root = mkdtempSync(join(tmpdir(), 'bin-symlinks-'));
const src = join(root, 'src'); const dst = join(root, 'dst');
mkdirSync(join(src, 'node_modules', '.bin'), { recursive: true });
mkdirSync(join(src, 'node_modules', 'vitest'), { recursive: true });
writeFileSync(join(src, 'node_modules', 'vitest', 'vitest.mjs'), '#!/usr/bin/env node\nconsole.log("vitest ok")\n');
chmodSync(join(src, 'node_modules', 'vitest', 'vitest.mjs'), 0o755);
symlinkSync('../vitest/vitest.mjs', join(src, 'node_modules', '.bin', 'vitest'));
writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'cli', scripts: { test: 'vitest' } }));
const result = materializePreviewWorkspace({ sourceRoot: src, destinationRoot: dst });
console.log('copy result', result);
console.log('.bin in copy:', existsSync(join(dst, 'node_modules', '.bin')) ? readdirSync(join(dst, 'node_modules', '.bin')) : 'ABSENT');
console.log('vitest.mjs in copy:', existsSync(join(dst, 'node_modules', 'vitest', 'vitest.mjs')));
```

Sortie :

```text
copy result { files: 2, bytes: 87, skipped: 1 }
.bin in copy: []
vitest.mjs in copy: true
```

## 1.10 — Store de test partiel dans le répertoire courant (MEDIUM)

Export propre de la référence, sans store, puis deux lancements successifs du
même fichier de test :

```bash
git archive c07e3548 | tar -x -C <export>
ln -s <checkout>/node_modules <export>/node_modules
cd <export>
npx vitest run tests/mcp-http.test.ts   # 1er passage
npx vitest run tests/mcp-http.test.ts   # 2e passage
```

Sortie :

```text
== pass 1 (atoma.db before: none)
      Tests  54 passed (54)
== pass 2 (atoma.db before: atoma.db)
 FAIL  tests/mcp-http.test.ts > the HTTP host > serves the operator on loopback without a token, tools filtered by what the host honours
SyntaxError: Unexpected token 'o', "no such tab"... is not valid JSON
$ sqlite3 atoma.db .tables
platform_settings
```

Le relecteur a obtenu la même erreur en lançant `tests/mcp-modern.test.ts` puis
`tests/mcp-http.test.ts -t "serves the operator on loopback"` dans une archive
propre.

## 1.11 — Contournement du deny `gh pr merge *--admin*` (MEDIUM)

Pas de script : lancer Claude Code coûterait un appel modèle. Le vérificateur a
lu l'appariement des règles Bash dans les binaires installés (2.1.123 et
2.1.289). Le motif deny devient `^gh pr merge .*--admin.*$`, testé sur le texte
brut de chaque sous-commande ; l'argv désquoté n'est ajouté qu'après retrait
d'affectations d'environnement ou d'un enrobeur. Conclusions par variante :

| Commande | Effet attendu |
|---|---|
| `gh pr merge 12 --adm""in` | deny manqué, allow `gh pr merge *` appliqué : contournement sans invite |
| `gh pr merge 12 $'--admin'` | nœud trop complexe : demande de confirmation |
| `F=--admin; gh pr merge 12 $F` | texte recomposé `… --admin` : refusé |
| `gh pr merge 12 "--admin"` | sous-chaîne présente : refusé |

## 2.1 — Replay hérité sans aucun check exécutable (LOW)

Vrais `inheritedChecksFor` et `renderInheritedChecksBlock`, exécuteur dont
`validate_html` jette après l'échauffement. Le déclencheur de revue est une
copie fidèle des termes de `src/atoms/rootAcceptance.ts:505-509`. La constante
`R` doit pointer vers le checkout. Script : `repro/closures/r1_10b-cannotrun.mts`.

```ts
// 1.10 class variant: the start replay is NOT stopped, but every selected check is `cannot-run`
// (validate_html throws / pre-flight refusal / per-call cap) -> kept=0, stopped undefined.
// Does the acceptor block say the net never ran, and is review forced (rootAcceptance.ts:505-510)?
import { mkdtempSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';
const R = '<scratch>/ref';
const { inheritedChecksFor } = await import(`${R}/src/run/inheritedChecks.ts`);
const { renderInheritedChecksBlock } = await import(`${R}/src/contracts/inheritedChecks.ts`);
const root = mkdtempSync(join(tmpdir(), 'atoma-cannotrun-'));
writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><nav>Menu</nav>Long break</body></html>');
writeFileSync(join(root, '.atoma-probes.json'), JSON.stringify({ version: 1, entries: [
  { probe: 'web', file: 'index.html', smoke: "document.body.textContent.includes('Long break')", expected: 'true' },
  { probe: 'web', file: 'index.html', smoke: "!!document.querySelector('nav')", expected: 'true' }] }, null, 2));
let calls = 0;
const executor = { has: (n: string) => ['start_static_server', 'validate_html'].includes(n),
  execute: async (n: string) => { if (n === 'start_static_server') return { url: 'http://127.0.0.1:5999/' };
    calls += 1; if (calls === 1) return { ok: true }; // warm-up call
    throw new Error('browser crashed (Target closed)'); } };
const runtime = inheritedChecksFor({ workspaceRoot: root, executor: () => executor as never, log: (l: string) => console.log('[log]', l) } as any);
if (!runtime) { console.log('runtime undefined'); process.exit(1); }
const baseline = await runtime.baseline(); console.log('baseline =', JSON.stringify(baseline));
const report = await runtime.compare({});
console.log('report: replayed', report.replayed, 'notReplayed', report.notReplayed, 'stopped', report.stopped, 'baseline.stopped', report.baseline?.stopped);
const block = renderInheritedChecksBlock(report, [], []);
console.log('acceptor block empty?', block === '');
const forced = 0 > 0 || (report.notReplayed ?? 0) > 0 || report.baseline.stopped !== undefined; // rootAcceptance.ts:506-508 inherited triggers
console.log('inherited review trigger (items/notReplayed/baseline.stopped) =>', forced);
process.exit(0);
```

Sortie :

```text
[log] inherited checks: 0 of 2 tried passed twice on the starting page (2 selected), in 0 s
baseline = {"selected":2,"considered":2,"kept":0,"cannotRun":2,"note":"validate_html threw: browser crashed (Target closed)"}
report: replayed 0 notReplayed 0 stopped undefined baseline.stopped undefined
acceptor block empty? true
inherited review trigger (items/notReplayed/baseline.stopped) => false
```
