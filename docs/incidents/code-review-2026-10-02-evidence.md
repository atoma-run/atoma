# Reproductions — revue de code du 2 octobre 2026

Ces reproductions documentent la révision `cc631bb6`, avant toute correction.
Elles étayent les findings de la
[revue du 2 octobre](../archive/reviews/code-review-2026-10-02.md) ; ce ne
sont pas des résultats attendus d'une future suite de non-régression.
Référence : `cc631bb6301e31664bafcaa6455aac5250aebe22`.

Elles ont été écrites et exécutées par les vérificateurs adverses de la revue
à la référence, puis **rejouées par l'auteur** sur le dépôt de travail Windows
(Node v24.16.0, dépendances installées, depuis la racine) pour chaque script
dont les fichiers importés étaient identiques entre `cc631bb6` et le HEAD du
moment (vérifié par `git diff cc631bb6..HEAD --name-only -- src`). Les
scripts 1.4, 1.10, 1.11 et 1.12 importent des fichiers que des commits
POSTÉRIEURS à la fenêtre ont modifiés ; leur sortie est celle de l'exécution
du vérificateur à la référence, reportée telle quelle.

Elles appellent les fonctions de production ; les modèles sont le
`MockLlmClient` du dépôt ou des fixtures, les stores sont des fichiers
temporaires sous `os.tmpdir()`, et les serveurs HTTP n'écoutent que sur une
adresse loopback et un port éphémère. Aucun appel LLM payant, accès GitHub,
conteneur ni store utilisateur. Aucun script ne modifie le dépôt.

Chaque script se lance ainsi, depuis la racine :

```bash
npx tsx script.mts
```

Le script du finding 1.5 a besoin des pins de tiers :
`ATOMA_MODEL_L1=api:anthropic:claude-haiku-4-5` (idem L2/L3, tout sélecteur
valide convient — le LLM est le mock).

## 1.1 — outputSchema fermés d'`atoma_costs` / `atoma_sentinel_health` (HIGH)

Vrai serveur et vrai client SDK du dépôt (InMemoryTransport) ; shapes copiés
verbatim de `src/mcp/tools.ts`, payloads de `src/mcp/readers.ts:1020-1040` et
`tools.ts:1016-1023`.

```ts
// Repro: atoma_costs / atoma_sentinel_health emit fields absent from their
// closed outputSchema -> SDK client refuses the result.
// Shapes copied verbatim from src/mcp/tools.ts @ cc631bb6 (lines 947-957, 1008-1012).
const NM = 'file:///c:/Users/mgf/dev/atoma/node_modules';
const { McpServer } = await import(`${NM}/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`);
const { Client } = await import(`${NM}/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { InMemoryTransport } = await import(`${NM}/@modelcontextprotocol/sdk/dist/esm/inMemory.js`);
const { z } = await import(`${NM}/zod/index.js`);

const jsonResult = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  structuredContent: payload as Record<string, unknown>,
});

const server = new McpServer({ name: 'repro', version: '0.0.0' });

server.registerTool(
  'atoma_costs',
  {
    outputSchema: {
      runsDir: z.string(),
      window: z.number(),
      runsScanned: z.number(),
      totals: z.record(z.string(), z.unknown()),
      perModel: z.array(z.record(z.string(), z.unknown())),
      perTier: z.array(z.record(z.string(), z.unknown())),
      perRole: z.array(z.record(z.string(), z.unknown())),
      trend: z.record(z.string(), z.unknown()),
      runs: z.array(z.record(z.string(), z.unknown())),
    },
  },
  () =>
    jsonResult({
      runsDir: '/x/runs',
      window: 20,
      runsScanned: 0,
      unparseable: 0, // readers.ts:1024
      totals: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
      perModel: [],
      perTier: [],
      perRole: [],
      trend: { note: 'fewer than 4 runs in the window — no trend is computed' },
      runs: [],
      note: 'Derived from the persisted traces at call time. …', // readers.ts:1038-1039
    })
);

server.registerTool(
  'atoma_sentinel_health',
  {
    outputSchema: {
      sentinel: z.record(z.string(), z.unknown()).nullable(),
      rules: z.array(z.record(z.string(), z.unknown())),
      analyst: z.record(z.string(), z.unknown()).nullable(),
    },
  },
  () =>
    jsonResult({
      sentinel: null,
      rules: [],
      analyst: null,
      note: 'this host exposes no resident watch', // tools.ts:1020-1022
    })
);

const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: 'repro-client', version: '0.0.0' });
await client.connect(ct);

const tools = await client.listTools();
for (const t of tools.tools) {
  console.log(t.name, 'additionalProperties =', JSON.stringify((t.outputSchema as any)?.additionalProperties));
}
for (const name of ['atoma_costs', 'atoma_sentinel_health']) {
  try {
    await client.callTool({ name, arguments: {} });
    console.log(name, ': OK (client accepted)');
  } catch (e) {
    console.log(name, ': CLIENT REFUSED ->', (e as Error).message);
  }
}
process.exit(0);
```

Sortie (rejouée par l'auteur) :

```text
atoma_costs additionalProperties = false
atoma_sentinel_health additionalProperties = false
atoma_costs : CLIENT REFUSED -> MCP error -32602: Structured content does not match the tool's output schema: data must NOT have additional properties, data must NOT have additional properties
atoma_sentinel_health : CLIENT REFUSED -> MCP error -32602: Structured content does not match the tool's output schema: data must NOT have additional properties
```

## 1.2 — session 2025 reprise jamais comptée dans `health().clients`

```ts
// Repro: health().clients never counts a 2025 session resumed after a deployment.
import { createServer } from 'node:http';
import { McpServer } from 'file:///c:/Users/mgf/dev/atoma/node_modules/@modelcontextprotocol/server/dist/index.mjs';
import { McpHttpHost } from 'file:///c:/Users/mgf/dev/atoma/src/mcp/http.ts';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'repro-client', version: '1' },
} });

let host: McpHttpHost;
const server = createServer((req, res) => { void host.handle(req, res, {}).catch(() => res.destroy()); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('no address');
const url = `http://127.0.0.1:${address.port}/mcp`;
const options = {
  resolveCaller: () => ({ kind: 'operator' } as const),
  buildServer: () => new McpServer({ name: 'fixture', version: '0' }),
  allowedHosts: [`127.0.0.1:${address.port}`],
};

// Day 1: the server before the deployment. The client initializes once.
host = new McpHttpHost(options);
const init = await fetch(url, { method: 'POST', headers, body: initialize });
const sessionId = init.headers.get('mcp-session-id');
await init.text();
console.log('before deployment: status', init.status, 'session', sessionId?.slice(0, 8));
console.log('before deployment: health', JSON.stringify(host.health()));

// The deployment: the process restarts, counters and sessions start from zero.
await host.close();
host = new McpHttpHost(options);

// The client keeps working with its old session id (it never re-initializes).
const call = await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
await call.text();
const health = host.health();
console.log('after deployment: tools/list status', call.status);
console.log('after deployment: health', JSON.stringify(health));
console.log('VERDICT:', health.resumed === 1 && Object.keys(health.clients).length === 0
  ? 'BUG REPRODUCED — resumed 2025 session served, clients stays empty'
  : 'not reproduced');
await host.close();
server.closeAllConnections();
server.close();
```

Sortie (rejouée) :

```text
before deployment: status 200 session 163f8732
before deployment: health {"sessions":1,"initializing":0,"opened":1,"refused":0,"evicted":0,"overflowed":0,"resumed":0,"replayEvictions":0,"modernRequests":0,"clients":{"2025-11-25 repro-client":1}}
after deployment: tools/list status 200
after deployment: health {"sessions":1,"initializing":0,"opened":0,"refused":0,"evicted":0,"overflowed":0,"resumed":1,"replayEvictions":0,"modernRequests":0,"clients":{}}
VERDICT: BUG REPRODUCED — resumed 2025 session served, clients stays empty
```

## 1.3 — préemption pendant l'attente du bail Codex HOME

```ts
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireCodexHomeLease } from 'file:///C:/Users/mgf/dev/atoma/src/core/codexHomeLease.ts';

const home = join(mkdtempSync(join(tmpdir(), 'repro-lease-')), 'codex-home');
mkdirSync(home);
const release = await acquireCodexHomeLease(home);

// resident.ts:212 abort reason, codexSession.ts:87-88 signal composition.
const reason = new Error('preempted by a product run');
const controller = new AbortController();
const pending = acquireCodexHomeLease(home, AbortSignal.any([AbortSignal.timeout(60_000), controller.signal]));
controller.abort(reason);

try {
  await pending;
  console.log('UNEXPECTED: lease acquired');
} catch (error) {
  const e = error as Error;
  console.log('rejected message        :', JSON.stringify(e.message));
  console.log('signal.reason message   :', JSON.stringify(reason.message));
  // analyst.ts:376-377 preemption test, with options.signal = controller.signal:
  const signal = controller.signal;
  const isPreemption = signal.aborted && (error === signal.reason ||
    (error instanceof Error && signal.reason instanceof Error && e.message === (signal.reason as Error).message));
  console.log('analyst preemption test :', isPreemption, '=>', isPreemption ? 'preempted' : 'RETHROWN -> resident counts failed, run dropped from queue');
}
release();
```

Sortie (rejouée) :

```text
rejected message        : "Codex profile access was cancelled"
signal.reason message   : "preempted by a product run"
analyst preemption test : false => RETHROWN -> resident counts failed, run dropped from queue
```

## 1.4 — audits Jev perdus sur le chemin d'échec du runner

Exécuté par le vérificateur à la référence (`runner.ts`/`trace.ts` ont été
modifiés hors fenêtre ensuite) ; le script reflète `runner.ts:1277` (settle,
chemin de succès) contre `:1390` (catch sans settle).

```ts
// Repro: an in-flight jev audit's event is dropped when the runner's
// FAILURE path calls recorder.endRun() without awaiting jevAudit.settle(),
// mirroring runner.ts:1353-1396 at cc631bb6 (success path 1269-1296 settles).
import { createJevAudit } from 'C:/Users/mgf/dev/atoma/src/core/jev.js';
import { TraceRecorder } from 'C:/Users/mgf/dev/atoma/src/viz/trace.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'jev-repro-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scenario(settleBeforeEnd: boolean): Promise<number> {
  const recorder = new TraceRecorder(dir);
  recorder.beginRun({ description: 'goal' } as any);
  const { audit, settle } = createJevAudit(1);
  // A slow background audit, as a model call would be (records its llm event when done)
  audit.defer(async () => {
    await sleep(50);
    recorder.record({ id: 'a1', ts: Date.now(), kind: 'llm', purpose: 'jev-audit',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0 } as any);
  });
  // handle() throws -> runner catch path
  if (settleBeforeEnd) await settle(5000); // success-path behaviour (runner.ts:1277)
  const run = recorder.endRun({ error: 'transport crash' }); // catch path (runner.ts:1390)
  await sleep(100); // let the audit finish AFTER endRun
  return run!.events.filter((e: any) => e.purpose === 'jev-audit').length;
}

void (async () => {
  const withSettle = await scenario(true);
  const withoutSettle = await scenario(false);
  console.log(`success path (settle before endRun): jev-audit events = ${withSettle}`);
  console.log(`failure path (endRun without settle): jev-audit events = ${withoutSettle}`);
  console.log(withSettle === 1 && withoutSettle === 0 ? 'REPRODUCED: audit lost on failure path' : 'NOT REPRODUCED');
})();
```

Sortie (vérificateur, à la référence) :

```text
success path (settle before endRun): jev-audit events = 1
failure path (endRun without settle): jev-audit events = 0
REPRODUCED: audit lost on failure path
```

## 1.5 — garde d'auto-contradiction par critère inerte (id dévié / tableau omis)

Chemin de production (`acceptRootResult`), harnais des tests `depth-routing`.
Pins de tiers requis (voir l'en-tête).

```ts
// Repro: per-criterion self-contradiction guard is inert when judgement ids
// mismatch (case) or when the criteria array is omitted entirely.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const load = (p: string) => import(pathToFileURL(resolve(p)).href);

const { Atom } = await load('src/core/atom.ts');
const { createAttestationLog } = await load('src/core/attestation.ts');
const { acceptRootResult } = await load('src/atoms/rootAcceptance.ts');
const { makeCtx, jsonText } = await load('tests/helpers.ts');
const { makePlan, makeTools } = await load('tests/helpers/factories.ts');

const task = { description: 'Build the page' };
const result = { output: { complete: true }, summary: 'Done', trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } };
class Executor {
  files: Record<string, string> = { 'index.html': '<button>Click</button>' };
  has(name: string) { return ['read_file', 'validate_html'].includes(name); }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const path = typeof args['path'] === 'string' ? args['path'] : 'index.html';
    if (name === 'read_file') {
      if (!(path in this.files)) throw new Error('ENOENT');
      return { content: this.files[path] };
    }
    return { ok: true, url: 'http://localhost:5050/', errors: [], warnings: [], failedRequests: [] };
  }
}
class Actor extends Atom {
  readonly model = 'test';
  readonly tier = 2;
  constructor() { super({ name: 'actor-2', ordinal: 1, systemPrompt: '', tools: makeTools(['read_file', 'validate_html']), params: {} }); }
  async plan() { return makePlan(); }
  async execute() { return result; }
  async validatePlan() { return { approved: true, reasoning: 'fixture' }; }
  async validateResult() { return { approved: true, reasoning: 'fixture' }; }
}
const context = () => ({ ...makeCtx(), tools: new Executor(), attempt: 1, attestations: createAttestationLog() });

const checklist = [{ id: 'c1', behaviour: 'the page shows the monthly total', check: { kind: 'review' as const } }];
const origin = { checklistOrigin: { source: 'user' as const, digest: 'a'.repeat(64) } };

// Case A: acceptor judges c1 UNMET but spells the id "C1" (uppercase).
const a = context();
a.llm.enqueueText(jsonText({ approved: true, reasoning: 'looks done',
  criteria: [{ id: 'C1', met: false, reason: 'route absente' }] }));
const caseA = await acceptRootResult({ actor: new Actor(), task, result, ctx: a, floor: [], phaseCoverage: [], checklist, ...origin });
console.log('A (id "C1", met:false):', { approved: caseA.approved, judgements: caseA.checklist?.map((i: any) => i.judgement ?? null) });

// Case B: acceptor omits the criteria array entirely.
const b = context();
b.llm.enqueueText(jsonText({ approved: true, reasoning: 'looks done' }));
const caseB = await acceptRootResult({ actor: new Actor(), task, result, ctx: b, floor: [], phaseCoverage: [], checklist, ...origin });
console.log('B (no criteria array):', { approved: caseB.approved, judgements: caseB.checklist?.map((i: any) => i.judgement ?? null) });

// Control: exact lowercase id, met:false → refusal (the guard working).
const c = context();
c.llm.enqueueText(jsonText({ approved: true, reasoning: 'looks done',
  criteria: [{ id: 'c1', met: false, reason: 'route absente' }] }));
const caseC = await acceptRootResult({ actor: new Actor(), task, result, ctx: c, floor: [], phaseCoverage: [], checklist, ...origin });
console.log('C (id "c1", met:false):', { approved: caseC.approved, reasoning: caseC.reasoning.slice(0, 80) });
```

Sortie (rejouée) :

```text
A (id "C1", met:false): { approved: true, judgements: [ null ] }
B (no criteria array): { approved: true, judgements: [ null ] }
C (id "c1", met:false): {
  approved: false,
  reasoning: 'Approved criteria judged NOT met: c1 the page shows the monthly total (route abs'
}
```

## 1.6 — pin ChatGPT retiré non refusé sur le chemin opérateur

```ts
// Repro: a retired host ChatGPT pin passes the operator launch path's checks.
import { readTierSelectors } from 'c:/Users/mgf/dev/atoma/src/contracts/modelSelector.js';
import { resolveCodexModel } from 'c:/Users/mgf/dev/atoma/src/core/llmCodexCli.js';
import { assertServedHostChatGptModels } from 'c:/Users/mgf/dev/atoma/src/contracts/runPayers.js';

const env = {
  ATOMA_MODEL_L1: 'sub:openai:gpt-5.4-mini',
  ATOMA_MODEL_L2: 'sub:openai:gpt-5.6-sol',
  ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol',
} as NodeJS.ProcessEnv;

// 1. What startTask reads (grammar only):
const selectors = readTierSelectors(env);
console.log('readTierSelectors L1 ->', JSON.stringify(selectors[1]));

// 2. What the codex transport sends:
console.log('resolveCodexModel ->', resolveCodexModel('gpt-5.4-mini', {}));

// 3. The guard that would refuse it — never called on this path:
try {
  assertServedHostChatGptModels(['sub:openai:gpt-5.4-mini']);
  console.log('guard: PASSED (unexpected)');
} catch (e) {
  console.log('guard would refuse:', (e as Error).message);
}
```

Sortie (rejouée) :

```text
readTierSelectors L1 -> {"mode":"sub","vendor":"openai","model":"gpt-5.4-mini"}
resolveCodexModel -> gpt-5.4-mini
guard would refuse: ChatGPT model gpt-5.4-mini is not served by the host subscription any more. Choose gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna in Settings.
```

## 1.7 — `models refresh --apply` perd `cacheWrite: 0`

```ts
import { diffCatalog, applyPriceChanges, type SourceCatalog } from 'c:/Users/mgf/dev/atoma/src/cli/modelCatalogUpdate.js';
import { modelCatalogSchema, pricePointAt } from 'c:/Users/mgf/dev/atoma/src/contracts/modelCatalog.js';
import { estimateCostUsd } from 'c:/Users/mgf/dev/atoma/src/core/metrics.js';
import { readFileSync } from 'node:fs';

const catalog = modelCatalogSchema.parse(JSON.parse(readFileSync('src/core/modelCatalog.json', 'utf8')));
const at = new Date('2026-10-02T12:00:00Z');
const model = catalog.vendors.zai.models.find((m) => m.id === 'glm-4.7')!;
const current = pricePointAt(model, at)!;
console.log('current point:', JSON.stringify(current));

// LiteLLM-shaped source: zai glm-4.7 input moves 0.6 -> 0.7, no cache_creation cost declared.
const source: SourceCatalog = new Map([
  ['zai', new Map([['glm-4.7', { input: 0.7, output: current.output, cachedInput: current.cachedInput, toolCalling: true }]])],
]);

const drift = diffCatalog(catalog, source, { at, vendors: ['zai'] });
console.log('priceChanges:', drift.priceChanges.map((c) => c.id));
const next = applyPriceChanges(catalog, drift.priceChanges, '2026-10-02');
const nextModel = next.vendors.zai.models.find((m) => m.id === 'glm-4.7')!;
const nextPoint = pricePointAt(nextModel, at)!;
console.log('new point:', JSON.stringify(nextPoint));
console.log('cacheWrite kept?', nextPoint.cacheWrite !== undefined);

const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000 };
console.log('cost of 1M cache-creation tokens BEFORE:', estimateCostUsd(usage, current));
console.log('cost of 1M cache-creation tokens AFTER :', estimateCostUsd(usage, nextPoint));

// Second check: vendor later introduces a real cache-write price — is it ever proposed?
const source2: SourceCatalog = new Map([
  ['zai', new Map([['glm-4.7', { input: current.input, output: current.output, cachedInput: current.cachedInput, cacheWrite: 1.1, toolCalling: true }]])],
]);
const drift2 = diffCatalog(catalog, source2, { at, vendors: ['zai'] });
console.log('cacheWrite-only change proposed?', drift2.priceChanges.length > 0);
```

Sortie (rejouée) :

```text
current point: {"since":"2026-09-27","input":0.6,"output":2.2,"cachedInput":0.11,"cacheWrite":0,"source":"https://docs.z.ai/guides/overview/pricing"}
priceChanges: [ 'glm-4.7' ]
new point: {"since":"2026-10-02","input":0.7,"output":2.2,"cachedInput":0.11}
cacheWrite kept? false
cost of 1M cache-creation tokens BEFORE: 0
cost of 1M cache-creation tokens AFTER : 0.875
cacheWrite-only change proposed? true
```

## 1.8 — « 0 = illimité » accepté à l'écriture, refusé par le schéma HTTP, droppé à la relecture

```ts
import { PlatformSettingsStore } from 'c:/Users/mgf/dev/atoma/src/platform/settings.js';
import {
  assertPlatformSettingValue,
  platformSettingOverridesSchema,
} from 'c:/Users/mgf/dev/atoma/src/contracts/platformSettings.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1. assertPlatformSettingValue accepts 0 for llm.callTimeoutMs (min 30000)
try {
  assertPlatformSettingValue('llm.callTimeoutMs', 0);
  console.log('assert(llm.callTimeoutMs, 0): ACCEPTED');
} catch (e) {
  console.log('assert(llm.callTimeoutMs, 0): REFUSED', String(e));
}

// 2. HTTP overrides schema (PUT /api/admin/settings body shape) with 0
const parsed = platformSettingOverridesSchema.safeParse({ 'llm.callTimeoutMs': 0 });
console.log(
  'overridesSchema({llm.callTimeoutMs: 0}):',
  parsed.success ? 'ACCEPTED' : `REFUSED: ${parsed.error.issues.map((i) => i.message).join('; ')}`
);

// 3. Store round-trip: set(0) then rows()/overrides()
const dir = mkdtempSync(join(tmpdir(), 'atoma-settings-zero-'));
const store = PlatformSettingsStore.open(join(dir, 'store.db'));
store.set({ 'llm.callTimeoutMs': 600_000 }, null);
console.log('after set(600000): rows =', JSON.stringify(store.rows()));
store.set({ 'llm.callTimeoutMs': 0 }, null);
console.log('after set(0): rows =', JSON.stringify(store.rows()));
console.log('after set(0): overrides =', JSON.stringify(store.overrides()));
console.log('after set(0): limits.llm.callTimeoutMs =', store.limits()['llm.callTimeoutMs']);
// raw row still in the table?
const raw = (store as any).db
  .prepare('SELECT key, value FROM platform_settings')
  .all();
console.log('raw table rows =', JSON.stringify(raw));
```

Sortie (rejouée) :

```text
assert(llm.callTimeoutMs, 0): ACCEPTED
overridesSchema({llm.callTimeoutMs: 0}): REFUSED: Too small: expected number to be >=30000
after set(600000): rows = [{"key":"llm.callTimeoutMs","value":600000,"updatedAt":"2026-10-02T09:08:39.689Z","updatedBy":null}]
after set(0): rows = []
after set(0): overrides = {}
after set(0): limits.llm.callTimeoutMs = 0
raw table rows = [{"key":"llm.callTimeoutMs","value":0}]
```

## 1.9 — fichier de départ au-delà du cap présenté « REMOVED »

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotStartingWorkspace, snapshotDeliveredWorkspace } from 'c:/Users/mgf/dev/atoma/src/run/workspace.ts';
import { compareStartingWorkspace, renderStartingWorkspace } from 'c:/Users/mgf/dev/atoma/src/contracts/startingWorkspace.ts';

const root = mkdtempSync(join(tmpdir(), 'atoma-repro-'));
writeFileSync(join(root, 'app.html'), Buffer.alloc(6 * 1024 * 1024, 0x61)); // 6 MB
const start = snapshotStartingWorkspace(root);
console.log('start files:', start.files.map(f => `${f.path} ${f.bytes}`), 'truncated:', start.truncated);
// The run legitimately grows the file to 9 MB (> 8 MB per-file cap)
writeFileSync(join(root, 'app.html'), Buffer.alloc(9 * 1024 * 1024, 0x62));
const now = snapshotDeliveredWorkspace(root, start);
console.log('delivered files:', now.files.map(f => f.path), 'addedTruncated:', now.addedTruncated);
const cmp = compareStartingWorkspace(start, now);
console.log('changes:', JSON.stringify(cmp.changes));
console.log('--- rendered block ---');
console.log(renderStartingWorkspace(cmp));
```

Sortie (rejouée) :

```text
start files: [ 'app.html 6291456' ] truncated: false
delivered files: [] addedTruncated: false
changes: [{"path":"app.html","status":"removed","before":6291456}]
--- rendered block ---
STARTING WORKSPACE — this run began from an existing deliverable; the host compared the files it started
with to the files it delivers (mechanical):
- app.html: REMOVED (6291456 bytes at the start)
Unchanged starting files: 0.
```

## 1.10 — start replay kept=0 : bloc hérité vide, revue non forcée

Exécuté par le vérificateur à la référence (`contracts/inheritedChecks.ts` a
bougé hors fenêtre ensuite).

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inheritedChecksFor } from 'c:/Users/mgf/dev/atoma/src/run/inheritedChecks.ts';
import { renderInheritedChecksBlock } from 'c:/Users/mgf/dev/atoma/src/contracts/inheritedChecks.ts';

const root = mkdtempSync(join(tmpdir(), 'atoma-kept0-'));
writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Long break</body></html>');
writeFileSync(join(root, '.atoma-probes.json'), JSON.stringify({
  version: 1,
  entries: [{ probe: 'web', file: 'index.html', smoke: "document.body.textContent.includes('Long break')", expected: 'true' }],
}, null, 2));

const executor = {
  has: (name: string) => ['start_static_server', 'validate_html'].includes(name),
  execute: async (name: string) => { throw new Error(`${name}: server failed to start (port in use)`); },
};

const runtime = inheritedChecksFor({
  workspaceRoot: root,
  executor: () => executor as never,
  log: (line) => console.log('[log]', line),
});
async function main(): Promise<void> {
if (!runtime) { console.log('runtime undefined — not reproduced'); process.exit(1); }
const baseline = await runtime.baseline();
console.log('baseline =', JSON.stringify(baseline));
const report = await runtime.compare({});
console.log('report = { replayed:', report.replayed, ', notReplayed:', report.notReplayed,
  ', stopped:', report.stopped, ', listed:', report.listed.length, '}');
const block = renderInheritedChecksBlock(report, [], []);
console.log('renderInheritedChecksBlock =>', JSON.stringify(block));
// The review condition of rootAcceptance.ts:471-475 on the inherited side:
const inheritedTriggers = (0 /* items */) > 0 || (report.notReplayed ?? 0) > 0 || undefined !== undefined;
console.log('inherited-side review trigger =>', inheritedTriggers);
}
void main();
```

Sortie (vérificateur, à la référence) :

```text
[log] inherited checks: 0 of 0 tried passed twice on the starting page (1 selected, stopped: server), in 0 s
baseline = {"selected":1,"considered":0,"kept":0,"cannotRun":0,"stopped":"server"}
report = { replayed: 0 , notReplayed: 0 , stopped: undefined , listed: 0 }
renderInheritedChecksBlock => ""
inherited-side review trigger => false
```

## 1.11 — scope mono-critère malgré des checks hérités contredits

Exécuté par le vérificateur à la référence (`depth.ts` a bougé hors fenêtre
ensuite).

```ts
import { remediationTask } from 'c:/Users/mgf/dev/atoma/src/run/depth.js';
import type { AcceptanceInfo } from 'c:/Users/mgf/dev/atoma/src/contracts/depthRouting.js';
import type { Task } from 'c:/Users/mgf/dev/atoma/src/core/types.js';

const acceptance: AcceptanceInfo = {
  attempt: 1,
  approved: false,
  reasoning: 'Approved criteria judged NOT met: c3 the API returns 404 on missing ids',
  acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' },
  executor: { name: 'L2', tier: 2, viaFallback: false },
  gates: [],
  probe: { requiresReview: false, contradiction: false },
  floorCoverage: [],
  phaseCoverage: [],
  checklist: [
    { id: 'c1', behaviour: 'home page renders', status: 'covered', judgement: { met: true } },
    { id: 'c2', behaviour: 'form submits', status: 'covered', judgement: { met: true } },
    { id: 'c3', behaviour: 'API returns 404 on missing ids', status: 'covered', judgement: { met: false, reason: 'no probe' } },
  ],
  checklistSource: 'user',
  inheritedChecks: {
    baseline: { recordedAt: 'x', files: 1 },
    replayed: 1, passed: 0, failed: 1, notReplayed: 0,
    items: [{ id: 'r1', file: 'index.html', summary: 'nav regression: menu gone', checks: ['nav visible'], asked: false }],
  },
  basis: 'validation-call',
} as unknown as AcceptanceInfo;

const task: Task = { id: 't', description: 'build the site', inputs: {} } as unknown as Task;
const out = remediationTask(task, acceptance);
console.log(JSON.stringify(out.inputs, null, 2));
console.log('focused scope set:', 'rootRemediationScope' in (out.inputs ?? {}));
```

Sortie (vérificateur, à la référence) : `rootRemediationScope` posé en mode
`single-criterion` (critère c3, `metCriteria: [c1, c2]`, instruction « Keep
the deliverables behind the criteria it judged met ») pendant que
`inheritedChecksNoLongerPassing` porte la régression `r1` ;
`focused scope set: true`.

## 1.12 — recettes d'événement dans l'ensemble de jumeaux d'un brouillon de tâche

Exécuté par le vérificateur à la référence (`lifecycle.ts` a bougé hors
fenêtre ensuite).

```ts
// Repro: for a kind:'task' draft, the twin guard's `existing` set includes
// trigger-bearing (event recovery) recipes that the task prefilter excludes.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry } from 'c:/Users/mgf/dev/atoma/src/skills/registry.js';
import { SkillLifecycle } from 'c:/Users/mgf/dev/atoma/src/skills/lifecycle.js';
import { MockLlmClient } from 'c:/Users/mgf/dev/atoma/src/core/llm.js';
import { DEFAULT_LIMITS } from 'c:/Users/mgf/dev/atoma/src/core/limits.js';

const dir = mkdtempSync(join(tmpdir(), 'atoma-twin-repro-'));
try {
  const skills = new SkillRegistry(dir);
  const ns = 'glucose-ns' as any;
  // A task recipe (competes at prefilter) and an event recovery recipe (never competes for a task).
  skills.save(ns, { id: 'build-json-api', description: 'build a json api', whenToUse: 'api build tasks', kind: 'llm', body: 'steps' });
  skills.save(ns, { id: 'recover-missing-ground-truth-evidence', description: 'recover evidence', whenToUse: 'n/a', trigger: 'validator complains evidence missing', kind: 'llm', body: 'retry with evidence' } as any);

  const llm = new MockLlmClient();
  llm.enqueueText(JSON.stringify({
    id: 'verify-cli-invocations',
    description: 're-run the documented invocations and compare',
    when_to_use: 'rechecking a built CLI',
    body: '1. read README\n2. run_shell each\n3. compare',
  }));

  const twinRequests: any[] = [];
  const ctx: any = {
    llm,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    limits: DEFAULT_LIMITS,
    jev: {
      twin: async (req: any) => { twinRequests.push(req); return null; },
      choose: async () => null,
      approve: async () => null,
    },
  };

  const host = {
    name: 'Tracheid',
    model: 'mock',
    params: {},
    toLlmRequest: (_role: string, args: any) => ({ systemPrompt: 's', userContent: args.userContent, params: args.params ?? {}, ...(args.signal ? { signal: args.signal } : {}) }),
  } as any;

  const lifecycle = new SkillLifecycle(host, skills);
  await lifecycle.learnSkillFromRun({
    l1Name: ns,
    subTask: { description: 'recheck the CLI behaves' } as any,
    result: { summary: 'done', output: 'ok', toolCallResults: [{ ok: true }] } as any,
    child: { name: 'Glucose', toolNames: () => ['run_shell', 'read_file'] } as any,
    ctx,
  });

  for (const req of twinRequests) {
    console.log('kind =', req.kind, '| draft =', req.draft.id);
    console.log('existing candidates offered to Jev:');
    for (const e of req.existing) console.log('  -', e.id, '| whenToUse field =', JSON.stringify(e.whenToUse));
    const hasRecovery = req.existing.some((e: any) => e.id.startsWith('recover-'));
    console.log('INCLUDES event recovery recipe in task twin set:', hasRecovery);
  }
  if (twinRequests.length === 0) console.log('no twin request made (draft rejected earlier?)');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

Sortie (vérificateur, à la référence) :

```text
kind = task | draft = verify-cli-invocations
existing candidates offered to Jev:
  - build-json-api | whenToUse field = "api build tasks"
  - recover-missing-ground-truth-evidence | whenToUse field = "validator complains evidence missing"
INCLUDES event recovery recipe in task twin set: true
```

## 2.15 — `[STALE]` raté sur orthographe variée ou extrait tronqué

```ts
import { parseExecutionObservation, renderObservations, type AttestationRecord } from 'file:///C:/Users/mgf/dev/atoma/src/contracts/attestation.ts';

function rec(eventId: string, tool: string, args: Record<string, unknown>, raw: unknown): AttestationRecord {
  return { eventId, tool, observation: parseExecutionObservation(tool, args, raw)! };
}

// Case A: identical spelling -> STALE expected (sanity)
const a = [
  rec('r1', 'read_file', { path: 'index.html' }, { content: 'old' }),
  rec('w1', 'write_file', { path: 'index.html' }, { ok: true }),
];
console.log('A (same spelling):', renderObservations(a)[0].startsWith('[STALE'));

// Case B: './/index.html' read then 'index.html' write
const b = [
  rec('r1', 'read_file', { path: '././index.html' }, { content: 'old' }),
  rec('w1', 'write_file', { path: 'index.html' }, { ok: true }),
];
console.log('B (././ vs plain):', renderObservations(b)[0].startsWith('[STALE'));

// Case C: truncated read args (long path/options) -> JSON.parse fails
const longPath = 'a/'.repeat(500) + 'index.html';
const c = [
  rec('r1', 'read_file', { path: longPath }, { content: 'old' }),
  rec('w1', 'write_file', { path: longPath }, { ok: true }),
];
console.log('C (truncated 800):', renderObservations(c)[0].startsWith('[STALE'));
```

Sortie (rejouée) : `A (same spelling): true` ; `B (././ vs plain): false` ;
`C (truncated 800): false`.

## Autres reproductions de la revue

Exécutées par les vérificateurs à la référence, non rejouées (lecture seule
suffisante ou fichiers déplacés hors fenêtre) :

- **2.9** — `runTraceFile('C:/host/workspaces/org/proj/runs/r-123.json', {}, 'pr-123')`
  retourne `{"note":"no trace at C:/host/workspaces/org/proj/runs/r-123.json"}`
  (une ligne, `src/mcp/readers.ts`).
- **2.12** — `redactHostPaths('spawn C:\\\\Users\\\\mgf\\\\x failed',
  [{path:'C:\\Users\\mgf', label:'~'}])` rend le texte inchangé ; idem
  `file:///C:/Users/mgf/My%20Dir/x`.
- **CIMD (section 5 du rapport)** — 46 assertions sur
  `metadataClientUrl`/`isAllowedRedirectUri`/`matchesRegisteredRedirect`/
  `isPublicAddress`/`cacheLifetimeMs`, toutes vertes (ruses userinfo,
  backslash, IP décimale/hex, punycode, point final, v4-mapped), à l'appui du
  constat « SSRF fermé en profondeur ».
