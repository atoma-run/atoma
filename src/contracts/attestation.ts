import { z } from 'zod';

/**
 * PROOF ATTESTATION — transport-observed evidence, and what it covers.
 * ====================================================================
 * This module owns three shapes and nothing else: the typed observation a
 * tool call produces, the record the runtime appends for it, and the closed
 * vocabulary of proof obligations a plan may declare.
 *
 * WHY it exists (measured, cold `web-counter` run 2026-08-22): the browser
 * tool already distinguishes interactions the model REQUESTED from
 * interactions Puppeteer EXECUTED, and that distinction was lost after the
 * tool returned. The result kept content-free `{name, ok}` pairs, the witness
 * extractor only recognised shell commands, and the web probe manifest was
 * written by the model from its own intent. A run whose eight requested
 * clicks were all filtered away was approved on its own narration, and the
 * skill distilled from it taught the next run to drive state through
 * `window.__*` hooks. See
 * `docs/archive/reviews/supervisor-attestation-a1-review-2026-08-22.md` for the contract and
 * `docs/incidents/supervisor-attestation-evidence-2026-08-22.md` for the
 * evidence.
 *
 * The invariant: an observation is only ever OBSERVED here, never claimed. A
 * model-authored payload cannot enter this module; the only writer is the
 * runtime seam that saw the raw tool result.
 */

/**
 * The obligation vocabulary is CLOSED and currently has exactly one member.
 * Coverage is a semantic match between a task claim and an observation;
 * every generalisation of it is either a vocabulary-frozen detector or
 * another paid, spoofable model call. One mechanical member refuses to
 * generalise before it is measured. A second member is a new review.
 */
export const PROOF_OBLIGATIONS = ['dom-interaction'] as const;
export type ProofObligation = (typeof PROOF_OBLIGATIONS)[number];

export function isProofObligation(value: unknown): value is ProofObligation {
  return typeof value === 'string' && (PROOF_OBLIGATIONS as readonly string[]).includes(value);
}

/**
 * The document a browser observation was taken against: the workspace file
 * the static server actually served, plus its content digest AT OBSERVATION
 * TIME. The digest is what relates an observation to an artifact revision —
 * without it a later `write_file` and an earlier proof are mechanically
 * unrelated, and a stale proof reads exactly like a fresh one.
 *
 * Scope, deliberately narrow: ONE served file. Import trees, assets and
 * bundles are NOT covered, so a deliverable whose behaviour lives in a
 * sibling module can go stale unnoticed. That under-detection is chosen over
 * the alternative — a digest over a guessed file set produces FALSE
 * staleness, which withholds credit silently, and silence is the failure
 * mode this contract exists to remove.
 */
export const observedDocumentSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
});

/**
 * What the browser tool observed. `requestedInteractions` and
 * `executedInteractions` are SEPARATE FACTS: the smoke filter
 * (`smokeDrivesOwnState`) removes every external interaction when the smoke
 * expression drives its own state, so a call can return `ok: true` having
 * executed none of the input the task named.
 */
export const browserObservationSchema = z.object({
  kind: z.literal('browser'),
  ok: z.boolean(),
  url: z.string().optional(),
  /** How many interactions the caller asked for. */
  requestedInteractions: z.number().int().nonnegative(),
  /** How many the runtime removed before opening the page. */
  ignoredInteractions: z.number().int().nonnegative(),
  /** One entry per interaction Puppeteer actually performed, in order. */
  executedInteractions: z.array(z.string()),
  smoke: z.string().optional(),
  smokeResult: z.unknown().optional(),
  consoleErrors: z.number().int().nonnegative(),
  failedRequests: z.number().int().nonnegative(),
  document: observedDocumentSchema.optional(),
  /**
   * The size the page was LAID OUT at, as `validate_html` reports it. Carried
   * so a validator can tell a 320px proof from an 800px one: until 2026-09-26
   * the tool reported it to its caller and the attestation dropped it, so the
   * two rendered identically (2026-09-25 review, 1.6). Absent on observations
   * recorded before it, which were all laid out at 800x600.
   */
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
});

/** The narrowest and widest layout `validate_html` accepts, in CSS px. */
export const MIN_VIEWPORT_PX = 240;
export const MAX_VIEWPORT_PX = 3840;

export type ObservedDocument = z.infer<typeof observedDocumentSchema>;
export type BrowserObservation = z.infer<typeof browserObservationSchema>;

/**
 * Every error string a `validate_html` PRE-FLIGHT refusal produces starts with
 * this prefix. A refusal is a statement about the REQUEST (its smoke shape,
 * its interaction order), made before any page is opened: no browser ran, no
 * document was bound, nothing about the artefact was observed. The writer
 * (`src/tools/builtin.ts`) and every reader — the L1 validation ledger, the
 * sentinel — spell the prefix from here so a refusal is never mistaken for a
 * failed observation of the artefact. Measured 2026-09-14, seeded counter:
 * three successful observations of one unchanged document were discarded
 * because the LAST call was a refusal, and the run replayed its whole
 * verification twice before its deadline.
 */
export const SMOKE_PREFLIGHT_REFUSAL_PREFIX = 'smoke rejected pre-flight: ';

/**
 * The same request-statement semantics for a URL that cannot name a server
 * this tool set started: a loopback URL with no port. `start_node_server` and
 * `start_static_server` bind OS-assigned ports and never the protocol
 * default, so `http://localhost/` is a shape error, not an observation of a
 * dead service. Measured on project run `d3098d25` (2026-09-21,
 * docs/incidents/progressive-runs-2026-09-21.md): the final review probed the
 * bare origin, read the connection refusal as a dead service although the
 * bound origin was serving, and replayed near-duplicate executions into the
 * 1800 s deadline — $3.50 recorded, nothing delivered.
 */
export const PROBE_URL_REFUSAL_PREFIX = 'url rejected pre-flight: ';

const PREFLIGHT_REFUSAL_PREFIXES: readonly string[] = [
  SMOKE_PREFLIGHT_REFUSAL_PREFIX,
  PROBE_URL_REFUSAL_PREFIX,
];

/** True when a raw `validate_html` result is a pre-flight refusal, not an observation. */
export function isPreflightRefusal(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const errors = (raw as Record<string, unknown>)['errors'];
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every(
      (entry) =>
        typeof entry === 'string' &&
        PREFLIGHT_REFUSAL_PREFIXES.some((prefix) => entry.startsWith(prefix))
    )
  );
}

/**
 * The structured half of a `fetch_url` observation, present ONLY when the
 * tool reported that a server this tool set started answered on that port
 * (`servedBy`), without a redirect. Same three fields as a manifest HTTP
 * entry. It is what the acceptance checklist is a projection over.
 */
export const httpObservationSchema = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().int(),
});

/** Bounded historical execution evidence, not a new proof obligation. */
export const executionObservationSchema = z.object({
  kind: z.literal('execution'),
  request: z.string(),
  response: z.string(),
  /** Host-owned truncation fact; absent on historical observations. */
  responseTruncated: z.boolean().optional(),
  http: httpObservationSchema.optional(),
  filePath: z.string().optional(),
});

function servedHttpObservation(args: Record<string, unknown>, raw: unknown): z.infer<typeof httpObservationSchema> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!r['servedBy'] || typeof r['servedBy'] !== 'object' || typeof r['status'] !== 'number') return undefined;
  if (typeof args['url'] !== 'string') return undefined;
  let url: URL;
  try { url = new URL(args['url']); } catch { return undefined; }
  const method = typeof args['method'] === 'string' ? args['method'].toUpperCase() : 'GET';
  return { method, path: `${url.pathname}${url.search}` || '/', status: r['status'] };
}
export type ToolObservation = BrowserObservation | z.infer<typeof executionObservationSchema>;

/** Preserve request/result association and mark every omitted byte explicitly. */
function evidenceExcerpt(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  return `${text.slice(0, head)} [truncated] ${text.slice(-(limit - head))}`;
}

export function parseExecutionObservation(tool: string, args: Record<string, unknown>, raw: unknown): ToolObservation | null {
  // `record_probe` is the shell EVIDENCE tool the writer contract prescribes
  // instead of run_shell: attesting run_shell and not it showed validators the
  // scratch commands and hid the evidence invocations (review 2.10).
  // A WRITE is attested by its path and the tool's reply, never its content:
  // what a validator needs is the ORDER — that a file it sees read was
  // rewritten afterwards (`renderObservations`), which a cell once missed and
  // judged a page on its pre-rewrite read (production run 74fe5cec).
  if (tool === 'write_file' || tool === 'edit_file') {
    // An edit whose strings were identical wrote nothing: attesting it would
    // mark a still-current read stale.
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>)['unchanged'] === true) return null;
    return executionObservationSchema.parse({ kind: 'execution',
      ...(typeof args['path'] === 'string' ? { filePath: args['path'] } : {}),
      request: evidenceExcerpt({ path: args['path'] }, 400), response: evidenceExcerpt(raw, 300) });
  }
  if (!['fetch_url', 'run_shell', 'record_probe', 'read_file', 'start_node_server'].includes(tool)) return null;
  const http = tool === 'fetch_url' ? servedHttpObservation(args, raw) : undefined;
  const response = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'null';
  return executionObservationSchema.parse({ kind: 'execution',
    ...(tool === 'read_file' && typeof args['path'] === 'string' ? { filePath: args['path'] } : {}),
    request: evidenceExcerpt(args, 800), response: evidenceExcerpt(response, 1600),
    ...(tool === 'read_file' && response.length > 1600 ? { responseTruncated: true } : {}), ...(http ? { http } : {}) });
}

/**
 * One appended record. `branchId` is the ADDRESS: it comes from the fork
 * wrapper that saw the call, never from ambient "current actor" state, which
 * would race the moment two fan-out lanes run at once.
 */
export interface AttestationRecord {
  readonly eventId: string;
  readonly attempt?: number;
  readonly branchId?: string;
  readonly tool: string;
  readonly observation: ToolObservation;
}

/**
 * Run-scoped, append-only, memory-only. NOT a new product store: nothing
 * here needs to outlive the run, and `src/core/stores.ts` stays the one
 * product store. Cross-run proof reuse is therefore out of scope HERE; the
 * one exception reads earlier runs' TRACES, never this log
 * (`src/contracts/standingHttpEvidence.ts`).
 */
export interface AttestationLog {
  append(record: AttestationRecord): void;
  /** Records observed under one branch, in append order. */
  forBranch(branchId: string | undefined): readonly AttestationRecord[];
  /** Missing historical tags belong to the first attempt. */
  forAttempt(attempt: number): readonly AttestationRecord[];
  readonly size: number;
}

/**
 * Does this record establish that real user input reached the page?
 * A non-empty EXECUTED log is the whole test: `ok: true` with an empty one
 * is the cold counter case, and it must not cover.
 */
export function establishesDomInteraction(record: AttestationRecord): boolean {
  return (
    record.observation.kind === 'browser' &&
    record.observation.executedInteractions.length > 0
  );
}

/**
 * Parse a raw browser tool result into the typed observation. Returns null
 * for anything that is not a browser result — the caller then has no
 * attestation, which is the correct outcome: absence of proof, not proof of
 * absence.
 *
 * `args` supplies the REQUESTED count because the request is the caller's
 * fact and the result is the runtime's; reading both from one side would
 * lose exactly the distinction this module exists for.
 */
export function parseBrowserObservation(
  args: Record<string, unknown>,
  raw: unknown
): BrowserObservation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ok'] !== 'boolean') return null;
  // The interaction log is the load-bearing field. A result without one is
  // not a browser observation we can reason about (a pre-flight rejection,
  // or another tool's payload).
  const log = r['interactionLog'];
  if (!Array.isArray(log)) return null;
  const requestedFromArgs = Array.isArray(args['interactions'])
    ? (args['interactions'] as unknown[]).length
    : 0;
  const requested =
    typeof r['requestedInteractions'] === 'number'
      ? r['requestedInteractions']
      : requestedFromArgs;
  const ignored = typeof r['ignoredInteractions'] === 'number' ? r['ignoredInteractions'] : 0;
  const errors = Array.isArray(r['errors']) ? r['errors'].length : 0;
  const failed = Array.isArray(r['failedRequests']) ? r['failedRequests'].length : 0;
  const parsed = browserObservationSchema.safeParse({
    kind: 'browser',
    ok: r['ok'],
    ...(typeof r['url'] === 'string' ? { url: r['url'] } : {}),
    requestedInteractions: Math.max(0, Math.floor(requested)),
    ignoredInteractions: Math.max(0, Math.floor(ignored)),
    executedInteractions: log.filter((entry): entry is string => typeof entry === 'string'),
    ...(typeof args['smoke'] === 'string' ? { smoke: args['smoke'] } : {}),
    ...(r['smokeResult'] !== undefined ? { smokeResult: r['smokeResult'] } : {}),
    consoleErrors: errors,
    failedRequests: failed,
    ...(r['document'] !== undefined ? { document: r['document'] } : {}),
    ...(isViewport(r['viewport']) ? { viewport: { width: r['viewport'].width, height: r['viewport'].height } } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function isViewport(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v['width']) && Number.isInteger(v['height']) &&
    (v['width'] as number) > 0 && (v['height'] as number) > 0;
}

/**
 * How much of a smoke expression a validator's line shows, JSON-encoded: its
 * head and its tail, where the checks and the `return` usually sit.
 */
export const MAX_RENDERED_SMOKE_CHARS = 600;
/** Bounded, encoded runtime action log; omitted actions establish no coverage. */
export const MAX_RENDERED_ACTIONS_CHARS = 600;

/** Runtime log inventory, not coverage: keys may fail, target another page or be focused by selector. */
export function renderBrowserInputs(records: readonly AttestationRecord[]): string {
  const browsers = records.filter((record) => record.observation.kind === 'browser');
  if (browsers.length === 0) return '';
  const counts = { click: 0, rightclick: 0, type: 0, select: 0, upload: 0, keydown: 0, keyup: 0, keypress: 0, other: 0 };
  for (const record of browsers) {
    if (record.observation.kind !== 'browser') continue;
    for (const action of record.observation.executedInteractions) {
      // The tool authors the prefix; selector/text suffixes remain untrusted.
      const kind = action.slice(0, action.indexOf(' '));
      const known = Object.keys(counts).find((key) => key !== 'other' && key === kind) as keyof typeof counts | undefined;
      counts[known ?? 'other'] += 1;
    }
  }
  return `BROWSER INPUTS OBSERVED IN THIS ATTEMPT (${browsers.length} validate_html calls): ` +
    Object.entries(counts).map(([kind, count]) => `${kind}=${count}`).join(', ') +
    '. Counts include failed calls and prove no outcome or keyboard-only journey. Requested/filtered actions are not counted. ' +
    'Tests executed outside validate_html are not counted here; judge those from their own evidence.';
}

/**
 * Every record's line, in order, with a repeated smoke expression written out
 * ONCE — on its latest occurrence, which is the one a bounded evidence block
 * keeps (`verdict.ts` keeps the latest browser lines). A responsive run
 * replays one smoke at five widths; five copies of it evicted execution
 * evidence from the same budget.
 */
export function renderObservations(records: readonly AttestationRecord[]): string[] {
  const latest = new Map<string, string>();
  for (const record of records) {
    if (record.observation.kind === 'browser' && record.observation.smoke !== undefined) latest.set(record.observation.smoke, record.eventId);
  }
  const superseded = supersededFileReads(records);
  return records.map((record) => {
    const smoke = record.observation.kind === 'browser' ? record.observation.smoke : undefined;
    const holder = smoke === undefined ? undefined : latest.get(smoke);
    const rewritten = superseded.get(record.eventId);
    return renderObservation(record, {
      ...(holder !== undefined && holder !== record.eventId ? { smokeSameAs: holder } : {}),
      ...(rewritten ? { rewrittenBy: rewritten.rewrittenBy } : {}),
    });
  });
}

/** Known later writes in the supplied observation scope; never infer shell effects. */
export function supersededFileReads(records: readonly AttestationRecord[]): ReadonlyMap<string, {
  readonly path: string; readonly rewrittenBy: string;
}> {
  const writtenLater = new Map<string, string>();
  const superseded = new Map<string, { path: string; rewrittenBy: string }>();
  for (const record of [...records].reverse()) {
    const path = requestedPath(record);
    if (path === undefined) continue;
    if (record.tool === 'write_file' || record.tool === 'edit_file') writtenLater.set(path, record.eventId);
    else if (record.tool === 'read_file' && writtenLater.has(path)) {
      superseded.set(record.eventId, { path, rewrittenBy: writtenLater.get(path)! });
    }
  }
  return superseded;
}

/** Read-back candidates, not proof: current truncated reads need their bodies too. */
export function fileReadsNeedingReadback(records: readonly AttestationRecord[]): ReadonlyMap<string, string> {
  const paths = new Map([...supersededFileReads(records)].map(([id, read]) => [id, read.path]));
  for (const record of records) {
    if (record.tool !== 'read_file' || record.observation.kind !== 'execution' || record.observation.responseTruncated !== true) continue;
    const path = requestedPath(record);
    if (path !== undefined) paths.set(record.eventId, path);
  }
  return paths;
}

/** The `path` an execution observation's request named, when it can be read back. */
function requestedPath(record: AttestationRecord): string | undefined {
  if (record.observation.kind !== 'execution') return undefined;
  const normalize = (path: string): string => {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else parts.push(part);
    }
    return (path.startsWith('/') ? '/' : '') + parts.join('/');
  };
  if (record.observation.filePath !== undefined) return normalize(record.observation.filePath);
  try {
    const request: unknown = JSON.parse(record.observation.request);
    const path = request && typeof request === 'object' ? (request as Record<string, unknown>)['path'] : undefined;
    return typeof path === 'string' ? normalize(path) : undefined;
  } catch {
    return undefined;
  }
}

/** The one-line rendering the supervisor shows a validator. */
export function renderObservation(
  record: AttestationRecord,
  options: { readonly smokeSameAs?: string; readonly rewrittenBy?: string } = {}
): string {
  const o = record.observation;
  if (o.kind === 'execution') {
    const stale = options.rewrittenBy !== undefined
      ? `[STALE: this file was rewritten afterwards by ${options.rewrittenBy}; this read is not its current content] `
      : '';
    // A warning beside obsolete bytes still let a root reviewer reject a
    // repaired README on those bytes (run bcf35298). Keep the observation in
    // the log, but make its decision-context rendering content-free.
    const response = options.rewrittenBy !== undefined
      ? '[superseded read result omitted; no evidence of current content]'
      : o.response;
    return `${stale}${record.tool} (attempt=${record.attempt ?? 1}, branch=${record.branchId ?? 'root'}): request=${o.request}; observed result=${response}`;
  }
  const bits = [
    `ok=${o.ok}`,
    `requested=${o.requestedInteractions}`,
    `executed=${o.executedInteractions.length}`,
  ];
  if (o.ignoredInteractions > 0) bits.push(`FILTERED=${o.ignoredInteractions}`);
  if (o.viewport) bits.push(`viewport=${o.viewport.width}x${o.viewport.height}`);
  if (o.document) bits.push(`doc=${o.document.path}`);
  bits.push(`consoleErrors=${o.consoleErrors}`, `failedRequests=${o.failedRequests}`);
  // A count cannot distinguish clicks/selects from a keyboard journey. Keep
  // the runtime log beside the outcome, never the requested interaction list.
  // JSON encoding prevents a selector or typed text from forging another line.
  bits.push(`executedActions=${evidenceExcerpt(JSON.stringify(o.executedInteractions), MAX_RENDERED_ACTIONS_CHARS)}`);
  // WHAT WAS ASSERTED, beside what came back. A result keyed
  // `controlsVisible: true` does not say that it measured `height >= 44`;
  // without the expression a validator refused a delivery for not verifying
  // exactly what that smoke verified (production run 5a5f1e27, 2026-09-26).
  // Model-authored, like an execution's request, and encoded like it: a raw
  // multi-line smoke could otherwise print lines that read as observations
  // of their own inside a block the supervisor labels machine-observed.
  if (o.smoke !== undefined) {
    bits.push(options.smokeSameAs !== undefined
      ? `smoke=(same as ${options.smokeSameAs})`
      : `smoke=${evidenceExcerpt(JSON.stringify(o.smoke), MAX_RENDERED_SMOKE_CHARS)}`);
  }
  if (o.smokeResult !== undefined) {
    try {
      const smoke = JSON.stringify(o.smokeResult) ?? '[not JSON serializable]';
      bits.push(`smokeResult=${smoke.length > 1200 ? `${smoke.slice(0, 1200)} [truncated]` : smoke}`);
    } catch {
      bits.push('smokeResult=[not JSON serializable]');
    }
  }
  return `${record.tool}: ${bits.join(', ')}`;
}
