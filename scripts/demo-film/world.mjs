/**
 * The demo world the film is recorded against: one organisation, four
 * projects, their run histories, and one fully traced run that the film
 * starts, follows live and inspects once delivered.
 *
 * SAMPLE DATA, SHAPED LIKE THE REAL THING. Every payload below is the shape
 * the server returns (the same contracts `scripts/viz-screenshot.mjs` stubs),
 * and the featured run follows the goal and outcome of a real project run
 * (`flags-service` 29b5dd57, docs/incidents/checklist-first-runs-2026-09-25.md).
 * Its per-call costs are not typed in: they come from the product's own cost
 * formula over the recorded token counts, so the tiles add up the way a real
 * run's do.
 *
 * Time is the PAGE's virtual clock (`virtual-clock.mjs`), which the capture
 * script mirrors into `world.now` after every advance. The featured run's
 * events carry offsets from the moment the film clicks Start; a poll only
 * sees the events already recorded at that moment, so the live timeline grows
 * exactly as a real one does.
 */
import { createHash } from 'node:crypto';
import { estimateCostUsd, pricesFor } from '../../src/core/metrics.ts';

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const PRINCIPAL_ID = '11111111-2222-3333-4444-555555555555';
export const ORG = { id: 'org-analytical', name: 'Analytical Engines' };

export const MODELS = {
  l1: { pin: 'api:anthropic:claude-haiku-4-5', served: 'claude-haiku-4-5-20251001' },
  l2: { pin: 'api:anthropic:claude-sonnet-5', served: 'claude-sonnet-5' },
  l3: { pin: 'api:anthropic:claude-opus-5', served: 'claude-opus-5' },
};

export const FLAGS_GOAL = [
  'Build a zero-dependency feature-flag service: server.js uses node:http only and stores flags',
  'in data/flags.json, written atomically and loaded on startup. A flag is {key, enabled, description}.',
  'Serve a small index.html at GET / that lists the flags and lets a user toggle one.',
  'Write a README with the endpoints and the actual verification results.',
].join(' ');

export const FLAGS_CRITERIA = [
  'GET /api/flags 200 — lists every flag',
  'POST /api/flags 201 — creates a flag',
  'POST /api/flags 409 — refuses a duplicate key',
  'DELETE /api/flags/:key 204 — deletes a flag',
  'Flags survive a server restart',
  'The page lists the flags and toggles one',
].join('\n');

const tierOf = { 1: 'l1', 2: 'l2', 3: 'l3' };

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** One LLM call: its start marker at `t`, its completion recorded at t+duration. */
function llmCall(ids, t, { role, tier, name, durationS, usage, response, branchId, child, subject, toolNames, goal = FLAGS_GOAL }) {
  // Routing and result checks are bounded decisions: they go to the cheapest
  // tier that can answer (prefilter on the L1 model, validation on L2's).
  const model = role === 'prefilter' ? MODELS.l1 : role === 'validate-result' ? MODELS.l2 : MODELS[tierOf[tier]];
  const full = {
    inputTokens: usage[0],
    outputTokens: usage[1],
    cacheReadInputTokens: usage[2] ?? 0,
    cacheCreationInputTokens: usage[3] ?? 0,
  };
  const costUsd = estimateCostUsd(full, pricesFor(model.served));
  const id = ids.next('llm');
  const common = {
    model: model.pin,
    role,
    actor: { tier, name },
    ...(child ? { child } : {}),
    ...(subject ? { subject } : {}),
    ...(branchId ? { branchId } : {}),
  };
  return [
    { at: t, event: { id: ids.next('start'), ts: t, kind: 'llm-start', llmEventId: id, ...common } },
    {
      at: t + durationS * S,
      event: {
        id,
        ts: t,
        kind: 'llm',
        ...common,
        servedModel: model.served,
        systemPrompt: `You are ${name}, the ${['', 'Molecule', 'Cell', 'Tissue'][tier]} of this run. Follow the atoma supervision protocol.`,
        userContent: goal,
        response: typeof response === 'string' ? response : JSON.stringify(response),
        stopReason: 'end_turn',
        durationMs: durationS * S,
        usage: full,
        costUsd,
        ...(toolNames ? { toolNames } : {}),
      },
    },
  ];
}

/** A stable UUID for a readable name, so the film can aim at "acceptance-1". */
export function uuidOf(name) {
  const hex = sha(name);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function counter(seed) {
  const counts = {};
  return { next: (prefix) => uuidOf(`${seed}:${prefix}-${(counts[prefix] = (counts[prefix] ?? 0) + 1)}`) };
}

/**
 * The featured run: timed entries `{at, event}` with `at` the moment the
 * recorder APPENDS the event (a tool or LLM completion is appended when it
 * ends, stamped with when it began) — the order a live poll sees them in.
 */
export function flagsRunEntries(t0) {
  const ids = counter('flags');
  const at = (s) => t0 + s * S;
  const entries = [];
  const push = (list) => entries.push(...(Array.isArray(list) ? list : [list]));
  const ev = (s, fields, appendS = s) => ({ at: at(appendS), event: { id: ids.next(fields.kind), ts: at(s), ...fields } });
  const L3 = { tier: 3, name: 'Meristem' };
  const L2 = { tier: 2, name: 'Tracheid' };
  const L1 = { tier: 1, name: 'Water' };

  push(ev(0.2, { kind: 'topology', at: 'entry', mode: 'deep', reason: 'arm', attempt: 1 }));
  push(llmCall(ids, at(0.4), {
    role: 'prefilter', ...L3, durationS: 1.9, usage: [2140, 96, 0],
    child: L2,
    response: { kind: 'reuse', target: 'Tracheid', confidence: 'high', decomposable: false, reasoning: 'Tracheid builds and verifies small node:http services with their page; one phase covers the whole goal.' },
  }));
  push(llmCall(ids, at(2.6), {
    role: 'plan', ...L3, durationS: 12.4, usage: [4180, 1320, 0, 2860],
    response: [
      { strategy: 'reuse', target: 'Tracheid', reasoning: 'The goal is one deliverable (a node:http service, its page and README) whose checks all run against the same server. Tracheid owns exactly that workflow.' },
      {
        reasoning: 'One sequential phase: write the service and its page, start it, prove every criterion with real HTTP requests and a restart, then document the observed results.',
        subtasks: [{
          description: 'Build server.js (node:http only, atomic writes to data/flags.json), index.html and README.md; start the server, verify every status code and a restart with real requests, and record the results in the README.',
          preferredChild: 'Tracheid',
          outputs: ['server.js', 'index.html', 'README.md', 'data/flags.json'],
          proofObligations: ['dom-interaction'],
        }],
        aggregation: { mode: 'sequential' },
      },
    ],
  }));
  const phase = 'p1';
  const phaseLabel = 'Build the flag service, its page and README; verify every criterion over HTTP';
  push(ev(15.2, { kind: 'branch', op: 'start', branchId: phase, index: 0, total: 1, aggregationMode: 'sequential', label: phaseLabel, actor: L3 }));
  push(llmCall(ids, at(15.4), {
    role: 'prefilter', ...L2, durationS: 1.6, usage: [1980, 88, 0], branchId: phase, child: L1,
    response: { kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'Water writes node:http services and verifies them in a real browser and over HTTP.' },
  }));
  push(ev(17.2, { kind: 'skill', op: 'match', l1Name: 'Water', l1AtomId: 'atom-water', skillId: 'serve-json-api-with-node-http', actor: L2, branchId: phase, reasoning: 'Workflow shape matches: write a node:http JSON service, start it, probe each route, document observed statuses.' }));
  push(ev(17.3, { kind: 'skill', op: 'inject', l1Name: 'Water', l1AtomId: 'atom-water', skillId: 'serve-json-api-with-node-http', actor: L2, branchId: phase }));

  // The worker's one long execute call; its tool calls land while it runs.
  const execStart = 17.6;
  const execDuration = 96.4;
  const execCall = llmCall(ids, at(execStart), {
    role: 'execute', ...L1, durationS: execDuration, usage: [9820, 14350, 61200, 7400], branchId: phase,
    toolNames: ['list_files', 'write_file', 'start_node_server', 'fetch_url', 'validate_html', 'read_file'],
    response: {
      summary: 'Delivered server.js, index.html, README.md and data/flags.json. Every status in the goal was observed over HTTP against the running server, and the flags read back identically after a restart.',
      files: ['server.js', 'index.html', 'README.md', 'data/flags.json'],
    },
  });
  push(execCall[0]);
  const execId = execCall[1].event.id;
  const tool = (s, durationS, name, args, result) =>
    push({ at: at(s + durationS), event: { id: ids.next('tool'), ts: at(s), kind: 'tool', llmEventId: execId, actor: L1, name, args, result, durationMs: durationS * S, branchId: phase } });
  const base = 'http://127.0.0.1:41873';
  const fetchUrl = (s, method, path, status, body) =>
    tool(s, 0.2, 'fetch_url', { url: `${base}${path}`, method, ...(body ? { body } : {}) }, {
      ok: status < 400, status, servedBy: { pid: 4312, port: 41873 }, body: status === 204 ? '' : body ?? '[]',
    });

  tool(19.0, 0.1, 'list_files', { path: '.' }, { files: [] });
  tool(33.5, 0.1, 'write_file', { path: 'server.js' }, { ok: true, bytes: 5853 });
  tool(47.8, 0.1, 'write_file', { path: 'index.html' }, { ok: true, bytes: 7081 });
  tool(49.0, 1.4, 'start_node_server', { entry: 'server.js', port: 41873 }, { ok: true, pid: 4312, port: 41873 });
  const flag = '{"key":"dark_mode","enabled":false,"description":"Dark theme for the dashboard"}';
  fetchUrl(51.2, 'GET', '/api/flags', 200, '[]');
  fetchUrl(52.4, 'POST', '/api/flags', 201, flag);
  fetchUrl(53.3, 'POST', '/api/flags', 409, '{"error":"flag dark_mode already exists"}');
  fetchUrl(54.1, 'POST', '/api/flags', 400, '{"error":"key must be a non-empty string"}');
  fetchUrl(55.0, 'GET', '/api/flags/dark_mode', 200, flag);
  fetchUrl(55.8, 'GET', '/api/flags/nope', 404, '{"error":"unknown flag"}');
  fetchUrl(56.9, 'PATCH', '/api/flags/dark_mode', 200, flag.replace('false', 'true'));
  fetchUrl(57.7, 'PATCH', '/api/flags/dark_mode', 400, '{"error":"enabled must be a boolean"}');
  fetchUrl(58.6, 'PATCH', '/api/flags/nope', 404, '{"error":"unknown flag"}');
  fetchUrl(59.9, 'POST', '/api/flags', 201, '{"key":"beta_banner","enabled":true,"description":"Beta banner"}');
  fetchUrl(61.0, 'DELETE', '/api/flags/beta_banner', 204);
  fetchUrl(61.8, 'DELETE', '/api/flags/beta_banner', 404, '{"error":"unknown flag"}');
  tool(64.0, 1.3, 'start_node_server', { entry: 'server.js', port: 41873, restart: true }, { ok: true, pid: 4388, port: 41873 });
  fetchUrl(66.1, 'GET', '/api/flags', 200, `[${flag.replace('false', 'true')}]`);
  fetchUrl(67.0, 'GET', '/', 200, '<!doctype html>…');
  tool(69.5, 6.8, 'validate_html', { path: 'index.html', url: `${base}/`, interact: 'click .toggle[data-key="dark_mode"]' }, {
    ok: true, errors: [], failedRequests: [], interactionLog: ['click .toggle[data-key="dark_mode"]', 'PATCH /api/flags/dark_mode 200'],
  });
  tool(84.2, 0.1, 'read_file', { path: 'data/flags.json' }, { ok: true, bytes: 94 });
  tool(104.0, 0.1, 'write_file', { path: 'README.md' }, { ok: true, bytes: 4950 });
  push(execCall[1]);

  push(llmCall(ids, at(114.3), {
    role: 'validate-result', ...L2, durationS: 9.1, usage: [6240, 410, 3100], branchId: phase, child: L1, subject: 'RESULT',
    response: { approved: true, activeSkillFollowed: true, reasoning: 'All four files exist; every status the goal names was observed on the server Water started, including 409, 400, 404 and the second DELETE. The restart read the flags back unchanged, and the page toggle issued a real PATCH.' },
  }));
  push(ev(123.5, { kind: 'registry', op: 'recordSuccess', tier: 1, name: 'Water', actor: L2, version: 3 }));
  push(ev(123.6, { kind: 'skill', op: 'success', l1Name: 'Water', l1AtomId: 'atom-water', skillId: 'serve-json-api-with-node-http', actor: L2, branchId: phase }));
  push(ev(123.8, { kind: 'branch', op: 'end', branchId: phase, index: 0, total: 1, aggregationMode: 'sequential', label: phaseLabel, actor: L3 }));

  // Root acceptance: one validation call, then the typed coverage it wrote.
  const acceptCall = llmCall(ids, at(124.2), {
    role: 'validate-result', ...L3, durationS: 14.6, usage: [7310, 690, 5400], child: L2, subject: 'RESULT',
    response: { approved: true, reasoning: 'Every HTTP criterion was observed on a server this run started; the restart and the page toggle are evidenced by the worker\'s recorded interactions.' },
  });
  push(acceptCall);
  const observation = (method, path, status) => entries.find(({ event }) =>
    event.kind === 'tool' && event.name === 'fetch_url' && event.args.method === method &&
    event.args.url.endsWith(path) && event.result.status === status)?.event.id;
  const criteria = [
    ['c1', 'lists every flag', 'http', observation('GET', '/api/flags', 200)],
    ['c2', 'creates a flag', 'http', observation('POST', '/api/flags', 201)],
    ['c3', 'refuses a duplicate key', 'http', observation('POST', '/api/flags', 409)],
    ['c4', 'deletes a flag', 'http', observation('DELETE', '/api/flags/beta_banner', 204)],
    ['c5', 'Flags survive a server restart', 'review', null],
    ['c6', 'The page lists the flags and toggles one', 'review', null],
  ];
  push(ev(138.9, {
    kind: 'acceptance', attempt: 1, approved: true,
    reasoning: 'Accepted: 4 of 4 HTTP criteria observed on servers this run started; 2 review criteria judged from the recorded evidence.',
    acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' },
    executor: { name: 'Tracheid', tier: 2, viaFallback: false },
    gates: [], probe: { requiresReview: false, contradiction: false },
    floorCoverage: [{ kind: 'dom-interaction', deliverable: 'index.html', status: 'covered', observationRefs: [entries.find(({ event }) => event.name === 'validate_html').event.id] }],
    phaseCoverage: [],
    checklistSource: 'user',
    checklistDigest: sha(FLAGS_CRITERIA),
    checklist: criteria.map(([id, behaviour, kind, ref]) => ({
      id, behaviour, kind,
      status: kind === 'http' ? (ref ? 'covered' : 'uncovered') : 'review',
      observationRefs: ref ? [ref] : [],
    })),
    basis: 'validation-call',
  }));
  push(ev(139.2, { kind: 'registry', op: 'recordSuccess', tier: 2, name: 'Tracheid', actor: L3, version: 5 }));
  entries.sort((a, b) => a.at - b.at);
  return entries;
}

export const FLAGS_DURATION_MS = 141_200;

/** The incomplete run: two phases delivered, the root refuses the third behaviour. */
export function salesPartialEvents(t0, goal) {
  const ids = counter('sales');
  const at = (s) => t0 + s * S;
  const out = [];
  const push = (list) => out.push(...(Array.isArray(list) ? list : [list]));
  const ev = (s, fields) => ({ at: at(s), event: { id: ids.next(fields.kind), ts: at(s), ...fields } });
  const L3 = { tier: 3, name: 'Meristem' };
  const L2 = { tier: 2, name: 'Sclereid' };
  const L1 = { tier: 1, name: 'Methane' };
  const phases = [
    ['p1', 'Add the product filter to the dashboard and keep the chart in sync'],
    ['p2', 'Add the monthly totals table under the chart'],
    ['p3', 'Export the filtered rows as CSV'],
  ];
  push(llmCall(ids, at(1), { role: 'plan', ...L3, durationS: 14, usage: [5200, 1400, 0, 3100], goal,
    response: [{ strategy: 'reuse', target: 'Sclereid', reasoning: 'Front-end changes against the existing dashboard.' },
      { reasoning: 'Three sequential phases on the same files.', subtasks: phases.map(([, label]) => ({ description: label, preferredChild: 'Sclereid' })), aggregation: { mode: 'sequential' } }] }));
  let t = 16;
  phases.forEach(([branchId, label], index) => {
    push(ev(t, { kind: 'branch', op: 'start', branchId, index, total: 3, aggregationMode: 'sequential', label, actor: L3 }));
    push(llmCall(ids, at(t + 0.5), { role: 'execute', ...L1, durationS: 160, usage: [4100, 9800, 38000, 2100], branchId, goal, response: { summary: label } }));
    push(ev(t + 40, { kind: 'tool', llmEventId: 'x', actor: L1, name: 'edit_file', args: { path: 'app.js' }, result: { ok: true }, durationMs: 100, branchId }));
    push(ev(t + 120, { kind: 'tool', llmEventId: 'x', actor: L1, name: 'validate_html', args: { path: 'index.html' }, result: { ok: true, errors: [] }, durationMs: 5200, branchId }));
    push(llmCall(ids, at(t + 170), { role: 'validate-result', ...L2, durationS: 9, usage: [5100, 380, 2800], branchId, goal, subject: 'RESULT',
      response: { approved: true, reasoning: index === 1 ? 'The table markup exists in index.html.' : 'Observed in the browser.' } }));
    push(ev(t + 180, { kind: 'branch', op: 'end', branchId, index, total: 3, aggregationMode: 'sequential', label, actor: L3 }));
    t += 190;
  });
  push(llmCall(ids, at(t + 2), { role: 'validate-result', ...L3, durationS: 16, usage: [8800, 720, 6100], goal, subject: 'RESULT',
    response: { approved: false, reasoning: 'The monthly totals table is not rendered under the chart: the markup is present but app.js never fills it. The product filter and the CSV export are present and observed.' } }));
  push(ev(t + 19, { kind: 'acceptance', attempt: 1, approved: false,
    reasoning: 'Refused: the monthly totals table is not rendered under the chart.',
    acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' }, executor: { name: 'Sclereid', tier: 2, viaFallback: false },
    gates: [], probe: { requiresReview: false, contradiction: false }, floorCoverage: [], phaseCoverage: [], basis: 'validation-call' }));
  return out.sort((a, b) => a.at - b.at).map((entry) => entry.event);
}

function totalsOf(events) {
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
  for (const event of events) {
    if (event.kind !== 'llm') continue;
    totals.calls += 1;
    totals.inputTokens += event.usage.inputTokens;
    totals.outputTokens += event.usage.outputTokens;
    totals.cacheReadInputTokens += event.usage.cacheReadInputTokens;
    totals.cacheCreationInputTokens += event.usage.cacheCreationInputTokens;
    totals.costUsd += event.costUsd;
  }
  return totals;
}

/** A compact finished trace for the history rows the film opens. */
function simpleTrace({ id, goal, startedAt, durationMs, calls, costUsd, result, events }) {
  return {
    id,
    label: `${goal.slice(0, 72)}… [build-app]`,
    task: { description: goal },
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + durationMs).toISOString(),
    durationMs,
    events,
    result,
    totals: events.length > 0 ? totalsOf(events) : { calls, inputTokens: Math.round(costUsd * 9000), outputTokens: Math.round(costUsd * 21000), costUsd },
  };
}

export function createWorld({ now }) {
  const world = {
    now,
    flagsStartedAt: null,
    previewUrl: 'about:blank',
  };
  const t = (offset) => new Date(world.now + offset).toISOString();
  const project = (fields) => ({
    status: 'active',
    repositoryStatus: 'ready',
    repositoryError: null,
    createdAt: new Date(now - 20 * DAY).toISOString(),
    updatedAt: new Date(now - 2 * DAY).toISOString(),
    ...fields,
    repositoryFullName: `${fields.repositoryTarget.owner}/${fields.repositoryTarget.name}`,
    repositoryUrl: `https://github.com/${fields.repositoryTarget.owner}/${fields.repositoryTarget.name}`,
  });
  const projects = {
    flags: project({ projectId: 'p-flags', name: 'Feature flags service', slug: 'flags-service', repositoryTarget: { installationId: '501', owner: 'analytical-engines', name: 'flags-service', visibility: 'private' }, createdAt: new Date(now - 3 * MIN).toISOString() }),
    sales: project({ projectId: 'p-sales', name: 'Sales dashboard', slug: 'sales-dashboard', repositoryTarget: { installationId: '501', owner: 'analytical-engines', name: 'sales-dashboard', visibility: 'private' } }),
    estimator: project({ projectId: 'p-estimator', name: 'Client project estimator', slug: 'client-estimator', repositoryTarget: { installationId: '501', owner: 'analytical-engines', name: 'client-estimator', visibility: 'private' } }),
    shipments: project({ projectId: 'p-shipments', name: 'Shipment status API', slug: 'shipment-status', repositoryTarget: { installationId: '501', owner: 'analytical-engines', name: 'shipment-status', visibility: 'private', source: { owner: 'analytical-engines', name: 'logistics-core', mode: 'pull-request' } } }),
  };

  const SALES_GOAL = 'Build a sales dashboard that lets me upload a CSV with date, product, region and revenue columns. Add filters, monthly totals and a chart by region. Include sample data and instructions to run it locally.';
  const salesHistory = [
    { projectRunId: 'r-sales-3', status: 'partial', goal: 'Add a product filter and a monthly totals table under the chart, and export the filtered rows as CSV.', costUsd: 0, durationS: 612, ago: 26 * MIN, publication: null },
    { projectRunId: 'r-sales-2', status: 'delivered', goal: 'Add a date range filter to the dashboard and keep the chart by region in sync with it.', costUsd: 0.31, durationS: 244, ago: 2 * DAY, publication: { status: 'published', commitSha: '9c41e07b2d8a5f31c6e0', repositoryUrl: projects.sales.repositoryUrl } },
    { projectRunId: 'r-sales-1', status: 'delivered', goal: SALES_GOAL, costUsd: 0.47, durationS: 389, ago: 3 * DAY, publication: { status: 'published', commitSha: '3fe2a91c07d44b8e9a15', repositoryUrl: projects.sales.repositoryUrl } },
  ];
  salesHistory[0].costUsd = Number(totalsOf(salesPartialEvents(0, salesHistory[0].goal)).costUsd.toFixed(4));
  const estimatorHistory = [
    { projectRunId: 'r-est-2', status: 'delivered', goal: 'Let the client pick a rate card and show the estimate as a printable one-page PDF-ready view.', costUsd: 0.22, durationS: 176, ago: 5 * DAY, publication: { status: 'published', commitSha: 'b77d02e1f9c3a4d58e21', repositoryUrl: projects.estimator.repositoryUrl } },
    { projectRunId: 'r-est-1', status: 'delivered', goal: 'Build an interactive project estimator: pick services and hours, see the total with VAT, share the result as a link.', costUsd: 0.36, durationS: 301, ago: 6 * DAY, publication: { status: 'published', commitSha: '51a0c3d9e8b27f64a0d2', repositoryUrl: projects.estimator.repositoryUrl } },
  ];
  const shipmentsHistory = [
    { projectRunId: 'r-ship-1', status: 'delivered', goal: 'Add GET /api/shipments/:id/status to the existing service, returning the latest scan with its timestamp, and document it.', costUsd: 0.19, durationS: 212, ago: 9 * DAY, publication: { status: 'published', commitSha: 'e03f9a6c1b72d58e44a9', repositoryUrl: projects.shipments.repositoryUrl, pullRequestUrl: `${projects.shipments.repositoryUrl}/pull/14` } },
  ];
  const historyRow = (projectId) => (row) => ({
    projectRunId: row.projectRunId,
    projectId,
    goal: row.goal,
    status: row.status,
    traceId: row.projectRunId,
    costUsd: row.costUsd,
    models: null,
    durationS: row.durationS,
    error: row.status === 'partial' ? 'refused at delivery: the monthly totals table is not rendered under the chart' : null,
    createdAt: t(-row.ago - row.durationS * S),
    endedAt: t(-row.ago),
    publication: row.publication,
  });

  function flagsEvents() {
    if (world.flagsStartedAt === null) return [];
    return flagsRunEntries(world.flagsStartedAt).filter((entry) => entry.at <= world.now).map((entry) => entry.event);
  }
  function flagsState() {
    if (world.flagsStartedAt === null) return null;
    const events = flagsEvents();
    const ended = world.now >= world.flagsStartedAt + FLAGS_DURATION_MS;
    return { events, ended, totals: totalsOf(events) };
  }

  function flagsProjectRun() {
    const state = flagsState();
    if (!state) return null;
    return {
      projectRunId: 'r-flags-1',
      projectId: 'p-flags',
      goal: FLAGS_GOAL,
      status: state.ended ? 'delivered' : 'running',
      traceId: 'r-flags-1',
      costUsd: state.ended ? state.totals.costUsd : null,
      models: Object.fromEntries(Object.entries(MODELS).map(([tier, model]) => [tier, { selection: model.pin, provider: 'anthropic', payer: 'organisation', source: 'org' }])),
      durationS: state.ended ? Math.round(FLAGS_DURATION_MS / S) : null,
      error: null,
      createdAt: new Date(world.flagsStartedAt).toISOString(),
      endedAt: state.ended ? new Date(world.flagsStartedAt + FLAGS_DURATION_MS).toISOString() : null,
      publication: state.ended
        ? { status: 'published', commitSha: '5d3adea5c9e14b7f02a8', repositoryUrl: projects.flags.repositoryUrl }
        : null,
    };
  }

  function flagsTrace() {
    const state = flagsState();
    return {
      id: 'r-flags-1',
      label: `${FLAGS_GOAL.slice(0, 72)}… [build-app]`,
      task: { description: FLAGS_GOAL },
      startedAt: new Date(world.flagsStartedAt).toISOString(),
      ...(state.ended
        ? { endedAt: new Date(world.flagsStartedAt + FLAGS_DURATION_MS).toISOString(), durationMs: FLAGS_DURATION_MS,
            result: { summary: 'Feature-flag service delivered: server.js, index.html, README.md and data/flags.json, every criterion observed.', producedBy: { tier: 3, name: 'Meristem' } } }
        : { inFlight: true }),
      events: state.events,
      totals: state.totals,
    };
  }

  const salesPartialTrace = () => simpleTrace({
    id: 'r-sales-3',
    goal: salesHistory[0].goal,
    startedAt: world.now - salesHistory[0].ago - salesHistory[0].durationS * S,
    durationMs: salesHistory[0].durationS * S,
    calls: 0,
    costUsd: salesHistory[0].costUsd,
    result: {
      summary: 'Product filter and CSV export delivered; the monthly totals table is missing.',
      refusal: 'the monthly totals table is not rendered under the chart; the product filter and the CSV export are present and observed',
      producedBy: { tier: 3, name: 'Meristem' },
    },
    events: salesPartialEvents(world.now - salesHistory[0].ago - salesHistory[0].durationS * S, salesHistory[0].goal),
  });

  function runIndex() {
    const rows = [];
    const flags = flagsState();
    if (flags) {
      rows.push({
        id: 'r-flags-1', label: `${FLAGS_GOAL.slice(0, 72)}…`, goal: FLAGS_GOAL.slice(0, 200),
        startedAt: new Date(world.flagsStartedAt).toISOString(),
        ...(flags.ended
          ? { endedAt: new Date(world.flagsStartedAt + FLAGS_DURATION_MS).toISOString(), durationMs: FLAGS_DURATION_MS, costUsd: flags.totals.costUsd, calls: flags.totals.calls, tokens: flags.totals.inputTokens + flags.totals.outputTokens }
          : { inFlight: true, lastEventAt: flags.events.at(-1)?.ts ?? world.flagsStartedAt }),
        hasError: false,
        projectId: 'p-flags', projectRunId: 'r-flags-1', projectName: projects.flags.name, projectSlug: projects.flags.slug,
      });
    }
    const historic = [
      ...salesHistory.map((row) => ({ row, project: projects.sales })),
      ...estimatorHistory.map((row) => ({ row, project: projects.estimator })),
      ...shipmentsHistory.map((row) => ({ row, project: projects.shipments })),
    ];
    for (const { row, project } of historic) {
      rows.push({
        id: row.projectRunId, label: `${row.goal.slice(0, 72)}…`, goal: row.goal.slice(0, 200),
        startedAt: t(-row.ago - row.durationS * S), endedAt: t(-row.ago), durationMs: row.durationS * S,
        costUsd: row.costUsd, calls: 9, tokens: Math.round(row.costUsd * 30000), hasError: false,
        projectId: project.projectId, projectRunId: row.projectRunId, projectName: project.name, projectSlug: project.slug,
      });
    }
    return rows;
  }

  function projectList() {
    const flagsRun = flagsProjectRun();
    return [
      { ...projects.flags, runCount: flagsRun ? 1 : 0, lastRunAt: flagsRun?.createdAt ?? null },
      { ...projects.sales, runCount: salesHistory.length, lastRunAt: t(-salesHistory[0].ago) },
      { ...projects.estimator, runCount: estimatorHistory.length, lastRunAt: t(-estimatorHistory[0].ago) },
      { ...projects.shipments, runCount: shipmentsHistory.length, lastRunAt: t(-shipmentsHistory[0].ago) },
    ];
  }

  function preview(projectId, runId) {
    const flags = flagsState();
    const live = runId === 'r-flags-1' && flags && !flags.ended;
    return {
      availability: runId === 'r-flags-1' || runId.startsWith('r-sales') ? 'available' : 'unavailable',
      kind: 'node',
      reason: null,
      state: world.previewReady?.[runId] ? 'ready' : 'stopped',
      generation: world.previewReady?.[runId] ? 1 : 0,
      source: live ? 'in-flight' : 'delivered',
      snapshotAt: live ? new Date(world.now - 4 * S).toISOString() : null,
      readyAt: world.previewReady?.[runId] ? new Date(world.previewReady[runId]).toISOString() : null,
      expiresAt: world.previewReady?.[runId] ? new Date(world.previewReady[runId] + 30 * MIN).toISOString() : null,
      errorCode: null, requestedHosts: [], allowedHosts: [], blockedHosts: [],
    };
  }

  const whoami = {
    enabled: true, authenticated: true, principalId: PRINCIPAL_ID,
    displayName: 'Ada Lovelace', displayNameSource: 'provider', avatarUrl: null,
    role: 'org:owner', platformAdmin: false,
    activeOrganisation: { ...ORG, role: 'org:owner' },
    organisations: [{ ...ORG, role: 'org:owner' }],
    providers: [{ id: 'github', label: 'GitHub' }],
  };

  const members = [
    ['Ada Lovelace', 'org:owner', 40], ['Grace Hopper', 'org:admin', 31], ['Alan Turing', 'org:member', 12], ['Katherine Johnson', 'org:member', 4],
  ].map(([displayName, role, days], index) => ({
    principalId: index === 0 ? PRINCIPAL_ID : `2222222${index}-2222-3333-4444-555555555555`,
    displayName, role, joinedAt: t(-days * DAY), platformAdmin: false, avatarUrl: null,
  }));

  const catalog = [
    { id: 'anthropic', label: 'Anthropic', selectorPrefix: 'api:anthropic', credentialEnvVar: 'ANTHROPIC_API_KEY', suggestive: false,
      models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }, { id: 'claude-opus-5', label: 'Claude Opus 5' }] },
    { id: 'openai', label: 'OpenAI', selectorPrefix: 'api:openai', credentialEnvVar: 'OPENAI_API_KEY', suggestive: false,
      models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }] },
    { id: 'zai', label: 'Z.ai', selectorPrefix: 'api:zai', credentialEnvVar: 'ZAI_API_KEY', suggestive: false, models: [{ id: 'glm-5.3', label: 'GLM-5.3' }] },
    { id: 'ollama', label: 'Ollama', selectorPrefix: 'api:ollama', credentialEnvVar: null, suggestive: true, models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }] },
  ];

  const molecules = [
    ['Water', 1, 1, 'Build and verify node:http services and static pages; verifies behaviour in a real browser and over HTTP.', ['write_file', 'read_file', 'start_node_server', 'fetch_url', 'validate_html'], 14, 1],
    ['Methane', 1, 6, 'Write single-file front-ends from a written specification.', ['write_file', 'read_file', 'validate_html'], 9, 2],
    ['Ethane', 1, 7, 'Read an existing codebase and apply a minimal, scoped change.', ['read_file', 'edit_file', 'list_files'], 6, 0],
    ['Tracheid', 2, 1, 'Route and validate web-service work: one phase per deliverable, every claim checked against evidence.', [], 11, 1],
    ['Sclereid', 2, 2, 'Route and validate front-end work against the running API it consumes.', [], 5, 1],
    ['Meristem', 3, 1, 'Decompose a product goal into phases and accept the delivery against its checklist.', [], 19, 2],
  ];
  const types = molecules.map(([name, tier, ordinal, description, tools, successes, failures]) => ({
    tier, rank: ['', 'molecule', 'cell', 'tissue'][tier], ordinal, name, description,
    systemPrompt: `You are ${name}. ${description}`,
    tools, elements: tools.map((toolName, i) => ({ tool: toolName, number: [1, 3, 6, 8, 11][i] ?? 12, name: ['Hydrogen', 'Lithium', 'Carbon', 'Oxygen', 'Sodium'][i] ?? 'Magnesium', symbol: ['H', 'Li', 'C', 'O', 'Na'][i] ?? 'Mg' })),
    params: {}, createdBy: 'bootstrap', createdAt: '2026-09-15T00:00:00.000Z', version: 3, successes, failures, history: [],
  }));
  const registry = { id: 'atoma', label: 'atoma', path: 'atoma.db', exists: true, counts: { 1: 3, 2: 2, 3: 1, total: 6 } };

  const skills = [
    { id: 'serve-json-api-with-node-http', description: 'Write a node:http JSON service, start it, probe every route and document the observed statuses.', whenToUse: 'A task asks for an HTTP JSON API with named routes and status codes, and no framework.', kind: 'llm', successes: 7, failures: 0, updatedAt: t(-1 * DAY) },
    { id: 'verify-browser-behaviour', description: 'Verify browser behaviour from an observed interaction.', whenToUse: 'When a page control must be proven to work, not just rendered.', kind: 'llm', successes: 5, failures: 1, updatedAt: t(-2 * DAY) },
    { id: 'document-static-site-readme', description: 'Document how to run the delivered site with the port it actually listened on.', whenToUse: 'A deliverable needs a README a newcomer can follow.', kind: 'compiled', successes: 12, failures: 0, updatedAt: t(-4 * DAY) },
  ];

  const routes = {
    '/auth/whoami': () => whoami,
    '/api/notifications': () => ({ notifications: world.flagsStartedAt && flagsState().ended ? [{
      seq: 51, at: new Date(world.flagsStartedAt + FLAGS_DURATION_MS).toISOString(), kind: 'run.finished', severity: 'info',
      title: 'Atoma — run delivered', body: 'Feature flags service', orgId: ORG.id, projectId: 'p-flags', runId: 'r-flags-1', traceId: 'r-flags-1',
    }] : [], nextBefore: null }),
    '/api/org': () => ({ id: ORG.id, name: ORG.name, createdAt: t(-40 * DAY), viewerRole: 'org:owner', members, projectCount: 4, pendingInvitations: 1, subscriptionDelegation: { available: false, mayManage: false } }),
    '/api/account/models': () => ({
      pins: { l1: null, l2: null, l3: null },
      defaults: { l1: MODELS.l1.pin, l2: MODELS.l2.pin, l3: MODELS.l3.pin },
      catalog: [],
    }),
    '/api/account/subscriptions': () => ({
      claude: { provider: 'claude', state: 'unavailable', connectedAt: null, lastVerifiedAt: null, reason: 'provider-approval-required' },
      codex: { provider: 'codex', state: 'connected', connectedAt: t(-6 * DAY), lastVerifiedAt: t(-1 * HOUR), reason: null },
      codexAttempt: null,
    }),
    '/api/tokens': () => ({ mode: 'bearer', tokens: [{ tokenId: 'tok-1', orgId: ORG.id, orgName: ORG.name, label: 'Claude Code', createdAt: t(-3 * DAY), lastUsedAt: t(-2 * HOUR), revokedAt: null }], mcpUrl: 'https://atoma.run/mcp' }),
    '/api/org/models': () => ({
      models: { l1: MODELS.l1.pin, l2: MODELS.l2.pin, l3: MODELS.l3.pin },
      keys: [{ provider: 'anthropic', configuredAt: t(-30 * DAY) }, { provider: 'openai', configuredAt: t(-12 * DAY) }],
      encryptionReady: true,
      catalog,
      operatorDefaults: { l1: MODELS.l1.pin, l2: MODELS.l2.pin, l3: MODELS.l3.pin },
    }),
    '/api/projects': () => projectList(),
    '/api/projects/p-flags/runs': () => [flagsProjectRun()].filter(Boolean),
    '/api/projects/p-sales/runs': () => salesHistory.map(historyRow('p-sales')),
    '/api/projects/p-estimator/runs': () => estimatorHistory.map(historyRow('p-estimator')),
    '/api/projects/p-shipments/runs': () => shipmentsHistory.map(historyRow('p-shipments')),
    '/api/registries': () => [registry],
    '/api/registry/atoma': () => ({ registry, types }),
    '/api/skills': () => [{ l1Name: 'shared-molecule', l1Label: 'Water', count: skills.length }],
    '/api/skills/shared-molecule': () => skills,
    '/api/runs': () => runIndex(),
    '/api/runs/r-flags-1': () => flagsTrace(),
    '/api/runs/r-sales-3': () => salesPartialTrace(),
    '/api/github/installations': () => [{ installationId: '501', accountLogin: 'analytical-engines', targetType: 'Organization', status: 'active', repositorySelection: 'all' }],
    '/api/goal-guidance': () => ({
      launchEnabled: false,
      guidance: {
        npmScript: 'run:build',
        help: 'Describe the artifact to build and its acceptance criteria in one or two sentences.',
        examples: [
          'Build a sales dashboard from a CSV export: filters, monthly totals and a chart by region.',
          'Add a JSON export of the filtered rows to the existing dashboard.',
        ],
      },
    }),
  };
  for (const skill of skills) {
    routes[`/api/skills/shared-molecule/${skill.id}`] = () => ({ ...skill, body: 'Write server.js with node:http only. Start it with start_node_server, then call fetch_url once per route and status the task names — including the refusals. Restart the server and read the data back before claiming persistence. Record the observed statuses, not the intended ones, in the README.' });
  }

  /** Answer one intercepted request, or undefined to let it through. */
  world.respond = (method, pathname) => {
    const previewMatch = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/preview(?:\/(open|heartbeat|stop|restart))?$/.exec(pathname);
    if (previewMatch) {
      const [, projectId, runId, action] = previewMatch;
      if (action === 'open') {
        world.previewReady = { ...(world.previewReady ?? {}), [runId]: world.now };
        return { summary: preview(projectId, runId), url: world.previewUrl };
      }
      if (action === 'stop') {
        if (world.previewReady) delete world.previewReady[runId];
        return preview(projectId, runId);
      }
      return action ? { summary: preview(projectId, runId) } : preview(projectId, runId);
    }
    if (method === 'POST' && pathname === '/api/projects/p-flags/runs') {
      world.flagsStartedAt = world.now;
      return flagsProjectRun();
    }
    const route = routes[pathname];
    return route ? route() : undefined;
  };
  return world;
}
