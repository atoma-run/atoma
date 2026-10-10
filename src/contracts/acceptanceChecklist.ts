import { z } from 'zod';
import { MAX_VIEWPORT_PX, MIN_VIEWPORT_PX, type httpObservationSchema } from './attestation.js';

/**
 * THE ACCEPTANCE CHECKLIST — what a run says, before planning, it will prove.
 * docs/acceptance-checklist-2026-09-25.md.
 *
 * Drafted once per run from the goal by the cheapest tier, handed to the
 * planner through the root task's `inputs`, and covered at root acceptance
 * from the HOST's own attempt-scoped observations. It has no authority to
 * accept: it can only add things the acceptor looks for.
 */

export const MAX_CHECKLIST_ITEMS = 12;
export const MAX_CHECKLIST_BEHAVIOUR_CHARS = 160;

const httpMethodSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']));

/** A path the goal itself names: absolute, no scheme, no host, no fragment. */
const checklistPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('#') && !/\s/.test(value), {
    message: 'path must be an absolute request path',
  });

const httpCheckObject = z.object({
  kind: z.literal('http'),
  method: httpMethodSchema,
  path: checklistPathSchema,
  status: z.number().int().min(100).max(599).optional(),
});
const reviewCheckObject = z.object({ kind: z.literal('review') });
const behaviourSchema = z.string().trim().min(1).max(MAX_CHECKLIST_BEHAVIOUR_CHARS);

export const checklistCheckSchema = z.discriminatedUnion('kind', [httpCheckObject, reviewCheckObject]);
export type ChecklistCheck = z.infer<typeof checklistCheckSchema>;

export const checklistItemSchema = z.object({
  id: z.string().regex(/^c\d{1,2}$/),
  behaviour: behaviourSchema,
  check: checklistCheckSchema,
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const acceptanceChecklistSchema = z.array(checklistItemSchema).max(MAX_CHECKLIST_ITEMS);
export type AcceptanceChecklist = z.infer<typeof acceptanceChecklistSchema>;

/**
 * WHO WROTE THE LIST. A `drafted` list is the model's reading of the goal and
 * may only add what the acceptor looks for. A `user` list is what the person
 * who launched the run approved before it started: the host captured it,
 * digested it and carried it to the child, and no model output replaces it.
 */
export const checklistSourceSchema = z.enum(['drafted', 'user']);
export type ChecklistSource = z.infer<typeof checklistSourceSchema>;

/**
 * One criterion as a PHASE carries it (`Task.criteria`): the exact words the
 * root acceptor judges and who wrote them. Runs 50be47bf and ebc60ee4
 * (2026-10-10) clicked before a journey their criterion said had "no mouse":
 * the molecule that wrote the check saw the phase description, never the
 * criterion's text.
 */
export interface PhaseCriterion {
  readonly id: string;
  readonly behaviour: string;
  readonly source: ChecklistSource;
  /** No subtask of the plan named it: the last phase hears it, as context only. */
  readonly unassigned?: true;
}

export function phaseCriteriaOf(checklist: AcceptanceChecklist, source: ChecklistSource): PhaseCriterion[] {
  // An http item is covered only by a request with that method and path, so
  // the phase hears them as the planner does (checklistPlanningLines).
  return checklist.map((item) => ({ id: item.id, source,
    behaviour: item.check.kind === 'http' ? `${item.behaviour} (fetch_url ${describeCheck(item.check)})` : item.behaviour }));
}

/**
 * THE USER-APPROVED LIST, as a caller submits it — docs/acceptance-contract-2026-09-14.md.
 *
 * STRICT where the drafted parse is lenient: an unknown key, a malformed item
 * or a thirteenth item refuses the whole request instead of being dropped,
 * because silently losing a criterion the user approved is exactly what the
 * contract forbids. Ids are not accepted: the host assigns `c1..cN` in the
 * submitted order at capture.
 */
const approvedCheckSchema = z.discriminatedUnion('kind', [httpCheckObject.strict(), reviewCheckObject.strict()]);
export const approvedChecklistItemInputSchema = z.object({
  behaviour: behaviourSchema,
  check: approvedCheckSchema,
}).strict();
export const approvedChecklistInputSchema = z.array(approvedChecklistItemInputSchema).min(1).max(MAX_CHECKLIST_ITEMS)
  // The coordinator hands the child the captured spec in ONE environment
  // variable bounded to `MAX_ACCEPTANCE_SPEC_BYTES`. Per-field limits alone let
  // a list escape-heavy enough to pass here fail the run AFTER it started
  // (2026-09-25 review, 2.3); the whole encoded size is checked at the door.
  .superRefine((items, ctx) => {
    const bytes = encodedSpecBytes(items);
    if (bytes > MAX_ACCEPTANCE_SPEC_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the criteria are too long together (${bytes} bytes encoded; at most ${MAX_ACCEPTANCE_SPEC_BYTES})` });
    }
  });
export type ApprovedChecklistInput = z.input<typeof approvedChecklistInputSchema>;

/** The captured specification: numbered items and the digest the host computed over them. */
export const acceptanceSpecSchema = z.object({
  version: z.literal(1),
  items: z.array(checklistItemSchema.extend({ check: approvedCheckSchema }).strict()).min(1).max(MAX_CHECKLIST_ITEMS),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AcceptanceSpec = z.infer<typeof acceptanceSpecSchema>;

/** Environment variable carrying the captured spec from the coordinator to the child runner. */
export const ACCEPTANCE_SPEC_ENV = 'ATOMA_ACCEPTANCE_SPEC';
/**
 * Who wrote the carried spec. Absent is a USER list, every spec carried before
 * 2026-09-25; `drafted` is a comparison rerun carrying the list its origin
 * drafted for itself, judged as a draft is judged (`withAcceptanceChecklist`).
 */
export const ACCEPTANCE_SOURCE_ENV = 'ATOMA_ACCEPTANCE_SOURCE';
export const MAX_ACCEPTANCE_SPEC_BYTES = 16_384;

/** The UTF-8 size of the spec the host would capture from `items`, digest included. */
function encodedSpecBytes(items: ReadonlyArray<z.infer<typeof approvedChecklistItemInputSchema>>): number {
  const canonical = items.map((item, index) => ({ id: `c${index + 1}`, behaviour: item.behaviour, check: item.check }));
  return new TextEncoder().encode(JSON.stringify({ version: 1, items: canonical, digest: '0'.repeat(64) })).length;
}

/**
 * The items in their ONE canonical order and key order, the bytes the digest
 * is computed over. Numbered here, from the submitted order.
 */
export function canonicalAcceptanceItems(input: ApprovedChecklistInput): AcceptanceSpec['items'] {
  return approvedChecklistInputSchema.parse(input).map((item, index) => ({
    id: `c${index + 1}`,
    behaviour: item.behaviour,
    check: item.check.kind === 'http'
      ? { kind: 'http' as const, method: item.check.method, path: item.check.path,
          ...(item.check.status !== undefined ? { status: item.check.status } : {}) }
      : { kind: 'review' as const },
  }));
}

// The status directly after the path: `404`, `→ 404` / `-> 404` (the notation
// the host itself renders, `describeCheck`) or `(404)`, with or without a space,
// and followed by punctuation or the text. A path never holds `(`, `→` or `>`.
const LINE_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s(→>]*)(?:\s*(?:→|->)\s*([1-5]\d\d)|\s*\(\s*([1-5]\d\d)\s*\)|\s+([1-5]\d\d))?(?!\d)(?:\s*(?:—|–|-|:|\.|,|;)\s*|\s+|$)(.*)$/;
/**
 * A standalone 2xx–5xx number: a status the line NAMES, wherever it was
 * written. Not after `:` (a port) or `.` (a version), not followed by a digit
 * or `.digit`; 1xx is left out, being no status a criterion asserts.
 */
const STATUS_IN_TEXT = /(?<![\d.:])[2-5]\d\d(?!\d)(?!\.\d)/g;

/**
 * THE LINE GRAMMAR a person types, one criterion per line — deterministic,
 * written by the user, never inferred from the goal:
 *
 *   GET /api/notes/:id 404 — an unknown id is refused
 *   The monthly total is shown under the chart
 *
 * A line that starts with an UPPERCASE HTTP method and an absolute path is an
 * `http` criterion (status optional; without one, any 2xx); every other line
 * is a `review` criterion with its text kept as written. Blank lines and a
 * leading `- ` or `* ` bullet are ignored. Errors are reported per line, and
 * the caller refuses the whole list while any remain.
 *
 * An HTTP line whose status is not where the grammar reads it but which still
 * NAMES one (`POST /api/notes returns 400 for invalid input`) is REFUSED:
 * read as written it would accept any 2xx and show OBSERVED on the happy path
 * for an error the run never provoked (2026-09-25 review, 1.5).
 */
export function parseChecklistLines(text: string): {
  readonly items: ApprovedChecklistInput;
  readonly errors: ReadonlyArray<{ readonly line: number; readonly message: string }>;
} {
  const items: Array<z.input<typeof approvedChecklistItemInputSchema>> = [];
  const errors: Array<{ line: number; message: string }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim().replace(/^[-*]\s+/, '').trim();
    if (!line) return;
    const http = LINE_METHOD.exec(line);
    // A trailing `:` ends the path, so `POST /api/notes: creates one` separates
    // like a dash; a `:name` segment inside the path is untouched.
    const path = http?.[2]!.replace(/:$/, '');
    const status = http ? http[3] ?? http[4] ?? http[5] : undefined;
    const rest = http ? http[6]!.trim() : '';
    const named = http ? [...rest.matchAll(STATUS_IN_TEXT)].map((match) => match[0]).find((value) => value !== status) : undefined;
    if (named && status === undefined) {
      errors.push({ line: index + 1, message:
        `this HTTP criterion names ${named} but not where its status is read, so it would accept any 2xx. ` +
        `If ${named} is the expected status, write it right after the path ("${http![1]} ${path} ${named} — ..."); ` +
        'otherwise drop the method to make it a review criterion' });
      return;
    }
    if (named) {
      errors.push({ line: index + 1, message:
        `this HTTP criterion checks ${status} but also names ${named}; write one criterion per expected status` });
      return;
    }
    const candidate = http
      ? {
          behaviour: rest || `${http[1]} ${path}${status ? ` ${status}` : ''}`,
          check: { kind: 'http' as const, method: http[1]!, path: path!,
            ...(status ? { status: Number(status) } : {}) },
        }
      : { behaviour: line, check: { kind: 'review' as const } };
    // Said in the caller's terms: the bound is on the criterion's TEXT, which
    // for an http line excludes its method, path and status. zod's own
    // "expected string to have <=160 characters" named no field, and the MCP
    // entry it reached was bounded at 400 (run start refused 2026-10-03).
    const chars = candidate.behaviour.trim().length;
    if (chars > MAX_CHECKLIST_BEHAVIOUR_CHARS) {
      errors.push({ line: index + 1, message:
        `this criterion's text is ${chars} characters; at most ${MAX_CHECKLIST_BEHAVIOUR_CHARS}` +
        (http && rest ? ' (its method, path and status are not counted)' : '') });
      return;
    }
    const parsed = approvedChecklistItemInputSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push({ line: index + 1, message: parsed.error.issues[0]?.message ?? 'invalid criterion' });
      return;
    }
    items.push(candidate);
  });
  if (items.length > MAX_CHECKLIST_ITEMS) {
    errors.push({ line: 0, message: `at most ${MAX_CHECKLIST_ITEMS} criteria` });
  }
  return { items, errors };
}

/**
 * Parse a drafted checklist. The model's ids are ignored and renumbered, and
 * a malformed ITEM is dropped rather than failing the list: one bad line must
 * not cost the run its other checks. Returns [] for anything unusable.
 */
export function parseAcceptanceChecklist(raw: unknown): AcceptanceChecklist {
  const items = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)['items']
    : raw;
  if (!Array.isArray(items)) return [];
  const parsed: ChecklistItem[] = [];
  for (const item of items) {
    if (parsed.length >= MAX_CHECKLIST_ITEMS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = checklistItemSchema.safeParse({ ...(item as Record<string, unknown>), id: `c${parsed.length + 1}` });
    if (candidate.success) parsed.push(candidate.data);
  }
  return parsed;
}

/** What the host observed of one request to a server this run started. */
export type HttpObservation = z.infer<typeof httpObservationSchema>;

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** Segments decoded ONE BY ONE (an encoded `/` stays inside its segment), and the query. */
function splitPath(path: string): { segments: string[]; query: URLSearchParams | null } {
  const q = path.indexOf('?');
  const pathname = q >= 0 ? path.slice(0, q) : path;
  return {
    segments: pathname.split('/').filter((segment) => segment.length > 0).map(decodeSegment),
    query: q >= 0 ? new URLSearchParams(path.slice(q + 1)) : null,
  };
}

/** Every named parameter present with the same values, in any order. */
function queryIncludes(want: URLSearchParams, got: URLSearchParams | null): boolean {
  for (const key of new Set(want.keys())) {
    const expected = want.getAll(key).sort();
    const actual = (got?.getAll(key) ?? []).sort();
    if (expected.length !== actual.length || expected.some((value, i) => value !== actual[i])) return false;
  }
  return true;
}

/**
 * Does an observed request satisfy an http check? Same method; the path
 * matches segment by segment, case-insensitively (the default of the routers
 * runs build on), where a `:name` segment matches any one segment; a
 * trailing slash is not significant; the query is compared only when the
 * check names one, parameter by parameter; the status is the named one, or
 * any 2xx when none is named.
 */
export function httpCheckMatches(check: Extract<ChecklistCheck, { kind: 'http' }>, observed: HttpObservation): boolean {
  if (observed.method.toUpperCase() !== check.method) return false;
  if (check.status !== undefined ? observed.status !== check.status : observed.status < 200 || observed.status > 299) {
    return false;
  }
  const want = splitPath(check.path);
  const got = splitPath(observed.path);
  if (want.segments.length !== got.segments.length) return false;
  for (let i = 0; i < want.segments.length; i += 1) {
    const segment = want.segments[i]!;
    if (segment.startsWith(':') && segment.length > 1) continue;
    if (segment.toLowerCase() !== got.segments[i]!.toLowerCase()) return false;
  }
  return want.query === null || queryIncludes(want.query, got.query);
}

export const checklistCoverageSchema = z.object({
  id: z.string(),
  behaviour: z.string(),
  kind: z.enum(['http', 'review']),
  status: z.enum(['covered', 'uncovered', 'review']),
  observationRefs: z.array(z.string()),
  /**
   * The root acceptor's own judgement of this criterion, when its verdict
   * gave one: what a person who approved seven criteria reads to learn which
   * ones the delivery was judged to meet. A model's word, beside the
   * mechanical status, never in place of it.
   */
  judgement: z.object({ met: z.boolean(), reason: z.string().max(400).optional() }).strict().optional(),
  /**
   * Each width the criterion's text names, and whether THIS attempt laid a
   * page out at it: `passed` when a browser check there came back ok,
   * `failed` when every one there failed, `not-laid-out` when none ran there.
   */
  layouts: z.array(z.object({
    width: z.number().int().positive(),
    status: z.enum(['passed', 'failed', 'not-laid-out']),
    observationRefs: z.array(z.string()),
  }).strict()).optional(),
});
export type ChecklistCoverage = z.infer<typeof checklistCoverageSchema>;

/** One browser check of this attempt: the width it laid the page out at and its verdict. */
export interface LayoutObservation { readonly eventId: string; readonly width: number; readonly ok: boolean }

// "375 px", "1280px", "375-pixel", and the widths listed before one unit:
// "375 and 1280 px", "320, 768 or 1024px".
const NAMED_WIDTHS = /(?<![\d.,])((?:\d{3,4}\s*(?:px)?\s*(?:,|\band\b|\bor\b|&|\/)\s*)*\d{3,4})\s*-?\s*(?:px|pixels?)\b/gi;
// "375 x 667 px" and "1920×1080 px" name a width then a height.
const WIDTH_BY_HEIGHT = /(?<![\d.,])(\d{3,4})\s*[x×]\s*\d{3,4}(?!\d)/gi;
// The width must be a SCREEN's, said by what surrounds the number: a screen
// noun after it ("a 375 px wide phone", "a 375-pixel phone"), a screen width
// before it ("viewport width of 375 px"), or "at 375 px" read as a width —
// followed by "wide" or "on desktop", or in a criterion about horizontal
// scroll or overflow.
// Element sizes and thresholds are left out: "the sidebar is fixed at 280 px
// wide", "max width of 720 px", "thumbnails render at 256 px", "below 768 px".
const SCREEN_AFTER = /^\s*(?:-?\s*wide\s+)?(?:screen|viewport|phone|mobile|tablet|desktop|laptop|window|display|device)s?\b/i;
const SCREEN_WIDTH_BEFORE = /(?:\b(?:viewport|screen|window|device)s?(?:\s+widths?)?|\bat\s+widths?)(?:\s+of)?\s+(?:(?:a|an|the)\s+)?$/i;
const AT_BEFORE = /\bat\s+(?:(?:a|an)\s+)?$/i;
const ELEMENT_AT_BEFORE = /\b(?:is|are|fixed|set|kept|stays?|capped|limited)\s+at\s+(?:(?:a|an)\s+)?$/i;
const WIDE_AFTER = /^\s*wide\b(?!\s+(?:banner|image|column|sidebar|panel|card|button|logo|chart|table)s?\b)/i;
const ON_SCREEN_AFTER = /^\s*(?:on|for)\s+(?:(?:a|an|the)\s+)?(?:screen|viewport|phone|mobile|tablet|desktop|laptop|window|display|device)s?\b/i;
const HORIZONTAL_FIT = /\bhorizontal(?:ly)?\s+scroll|\boverflow/i;

/**
 * The viewport widths a criterion's text names, in CSS px, in the order
 * written: only a screen's width, and only one `validate_html` can lay a page
 * out at. Production runs a939374e and 7389feee (2026-09-27) were approved on
 * "no horizontal scroll at 375 px" with every page laid out at 800x600, the
 * second after its own refusal had named the gap: a comparison the acceptor
 * was shown, and did not make. What this returns is shown beside the item and
 * handed to the planner and the molecule; it overrides no judgement.
 */
export function namedLayoutWidths(raw: string): number[] {
  const text = raw.replace(WIDTH_BY_HEIGHT, '$1');
  const widths: number[] = [];
  for (const match of text.matchAll(NAMED_WIDTHS)) {
    const before = text.slice(Math.max(0, match.index - 32), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 32);
    const at = AT_BEFORE.test(before) && !ELEMENT_AT_BEFORE.test(before) &&
      (WIDE_AFTER.test(after) || ON_SCREEN_AFTER.test(after) || HORIZONTAL_FIT.test(text));
    if (!at && !SCREEN_WIDTH_BEFORE.test(before) && !SCREEN_AFTER.test(after)) continue;
    for (const digits of match[1]!.match(/\d{3,4}/g) ?? []) {
      const width = Number(digits);
      if (width >= MIN_VIEWPORT_PX && width <= MAX_VIEWPORT_PX && !widths.includes(width)) widths.push(width);
    }
  }
  return widths;
}

function coverLayouts(behaviour: string, layouts: readonly LayoutObservation[]): NonNullable<ChecklistCoverage['layouts']> {
  return namedLayoutWidths(behaviour).map((width) => {
    const there = layouts.filter((layout) => layout.width === width);
    return {
      width,
      status: there.length === 0 ? 'not-laid-out' as const : there.some((layout) => layout.ok) ? 'passed' as const : 'failed' as const,
      observationRefs: there.map((layout) => layout.eventId),
    };
  });
}

function describeStanding(entry: ChecklistCoverage): string {
  if (!isStandingCoverage(entry)) return '';
  const [run, , ...file] = entry.observationRefs[0]!.slice('standing:'.length).split('/');
  return ` — recorded by run ${(run ?? '').slice(0, 8)} against ${file.join('/') || 'the server'}`;
}

/** Covered only by host-recorded observations of earlier runs (`standing:` refs). */
export function isStandingCoverage(entry: Pick<ChecklistCoverage, 'status' | 'observationRefs'>): boolean {
  return entry.status === 'covered' && entry.observationRefs.length > 0 &&
    entry.observationRefs.every((ref) => ref.startsWith('standing:'));
}

/** Mechanical coverage of each item from this attempt's HTTP and browser observations. */
export function coverAcceptanceChecklist(
  checklist: AcceptanceChecklist,
  observations: ReadonlyArray<{ readonly eventId: string; readonly http: HttpObservation }>,
  layouts: readonly LayoutObservation[] = []
): ChecklistCoverage[] {
  return checklist.map((item) => {
    if (item.check.kind === 'review') {
      const widths = coverLayouts(item.behaviour, layouts);
      return { id: item.id, behaviour: item.behaviour, kind: 'review', status: 'review', observationRefs: [],
        ...(widths.length > 0 ? { layouts: widths } : {}) };
    }
    const check = item.check;
    const refs = observations.filter((o) => httpCheckMatches(check, o.http)).map((o) => o.eventId);
    return { id: item.id, behaviour: item.behaviour, kind: 'http', status: refs.length > 0 ? 'covered' : 'uncovered', observationRefs: refs };
  });
}

function describeCheck(check: ChecklistCheck): string {
  if (check.kind === 'review') return 'judged by review';
  return `${check.method} ${check.path} → ${check.status ?? '2xx'}`;
}

/** The lines the PLANNER receives, in the root task's inputs. */
export function checklistPlanningLines(checklist: AcceptanceChecklist): string[] {
  return checklist.map((item) => {
    const widths = item.check.kind === 'review' ? namedLayoutWidths(item.behaviour) : [];
    const layout = widths.length > 0
      ? `; lay the page out at ${widths.map((width) => `${width} px`).join(' and ')} wide with validate_html viewport`
      : '';
    return `${item.id}: ${item.behaviour} (${describeCheck(item.check)}${layout})`;
  });
}

const LAYOUT_LABEL = { 'passed': 'laid out, passed', 'failed': 'laid out, every check there FAILED', 'not-laid-out': 'NOT LAID OUT' } as const;

function describeLayouts(layouts: ChecklistCoverage['layouts']): string {
  return layouts?.length ? `; ${layouts.map((layout) => `${layout.width} px: ${LAYOUT_LABEL[layout.status]}`).join(', ')}` : '';
}

/**
 * The block the ROOT ACCEPTOR reads beside the delivery proof, or '' when a
 * DRAFTED checklist names no HTTP check: a model's list of REVIEW items alone
 * adds no observation and would only read as extra requirements. A USER list
 * always renders, because its review items are requirements the person who
 * launched the run approved, not a model's reading of the goal. On a LANDED
 * result the phases that never ran could not be observed, and the block says
 * so, because the landing guidance tells the acceptor not to refuse for that.
 */
export function renderChecklistCoverage(
  checklist: AcceptanceChecklist,
  coverage: readonly ChecklistCoverage[],
  options: { readonly landed?: boolean; readonly source?: ChecklistSource } = {}
): string {
  const user = options.source === 'user';
  const layouts = coverage.some((entry) => entry.layouts?.length);
  if (coverage.length === 0 || (!user && !layouts && !coverage.some((entry) => entry.kind === 'http'))) return '';
  const lines = coverage.map((entry, i) => {
    const label = entry.status === 'covered'
      ? (isStandingCoverage(entry) ? 'RECORDED EARLIER' : 'OBSERVED')
      : entry.status === 'uncovered' ? 'NOT OBSERVED' : 'REVIEW';
    return `- [${label}] ${entry.id} ${entry.behaviour} (${describeCheck(checklist[i]!.check)}${describeLayouts(entry.layouts)})${describeStanding(entry)}`;
  });
  return [
    user
      ? 'ACCEPTANCE CRITERIA — approved by the user before launch; the host captured them and no model wrote them.\n' +
        'They are what the user asked this delivery to show. This block decides nothing by itself: judge each one.'
      : 'ACCEPTANCE CHECKLIST — drafted from the goal before planning. It adds nothing the goal did not ask\n' +
        'for and decides nothing by itself.',
    'OBSERVED / NOT OBSERVED are mechanical: whether THIS attempt made',
    'that request through fetch_url to a server it started, and got that status. OBSERVED is status only,',
    'not bound to the current bytes. NOT OBSERVED means no such request was seen — a request made with',
    'run_shell is invisible here — not that the behaviour is broken; weigh it with the rest of the evidence.',
    ...(coverage.some(isStandingCoverage)
      ? ['RECORDED EARLIER is mechanical too: an earlier run of this project made that request, as the host recorded',
        'it, to the server entry the delivery still runs, whose code (entry, literal relative imports, package.json,',
        'by digest) is unchanged since. This attempt did not repeat it. A module loaded through a computed path, data',
        'files the server reads, dependencies and the environment are not in the digest: it is standing evidence of',
        'that status, not a new observation.']
      : []),
    ...(layouts
      ? ['A width after an item is a screen width its text names. LAID OUT / NOT LAID OUT are mechanical too:',
        'whether a validate_html call of THIS attempt laid a page out at that width. A layout at another width,',
        'or a stylesheet read, shows nothing about that width.']
      : []),
    ...(options.landed
      ? ['This result LANDED before all its phases ran: NOT OBSERVED items from unfinished phases are expected.']
      : []),
    'REVIEW items are yours to judge against the evidence, and met only on what it SHOWS: a file read back, a',
    'request and its response, a page checked after the action. A file existing, an implementation described,',
    'a restart with no request after it, or one record where an order is claimed shows nothing by itself.',
    ...lines,
  ].join('\n');
}
