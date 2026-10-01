import { MAX_VIEWPORT_PX, MIN_VIEWPORT_PX } from './attestation.js';

/**
 * WHAT A BROWSER CHECK RUNS, read once: the interactions, settle time and
 * viewport of a `validate_html` call, as the tool that runs a check, the
 * manifest merge that records it and the host's replay of an inherited one
 * all read them. Run 0b51e494 (2026-10-01) is why it is one module: the merge
 * keyed web entries by file and smoke, and dropped a check the tool and the
 * replay told apart.
 */

export interface ParsedInteraction {
  type: 'click' | 'rightclick' | 'type' | 'keydown' | 'keyup' | 'keypress' | 'upload' | 'select';
  selector?: string;
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  holdMs?: number;
  /** upload-only: the workspace-relative file to attach. */
  file?: string;
  /** select-only: the option value or label, or the control value, to choose. */
  value?: string;
}

/** The settle time of a `validate_html` call that names none. */
export const DEFAULT_WAIT_MS = 500;
/** The hold of a `keypress` that names none. */
export const DEFAULT_HOLD_MS = 120;

/**
 * Upper bound on a single `keypress` hold, in ms.
 *
 * A headless browser runs in REAL TIME and cannot fast-forward. Measured
 * 2026-08-09 on a Quiz Timer task: the model asked for
 * `keypress (270500ms)` — 4.5 minutes of held key — trying to advance an
 * in-page countdown to zero. The tool obeyed, the call took 273s, and the
 * run's wall-clock tripled. It is never a real interaction: no user holds a
 * key for minutes, and the app under test cannot be steered that way. So the
 * hold is clamped and the caller is TOLD, with the technique that does work
 * (expose a hook and drive the clock from `smoke`) — a clamp the model
 * cannot see just turns a 273s dead end into a 3s mystery.
 */
export const MAX_HOLD_MS = 3_000;

/**
 * Upper bound on the post-load settle `waitMs`. Same class as MAX_HOLD_MS —
 * unbounded model-supplied durations convert arithmetic slips straight into
 * dead wall-clock. The largest legitimate value observed across 208 archived
 * calls is 6000ms, so this leaves real headroom.
 */
export const MAX_WAIT_MS = 15_000;

export function parseInteractions(raw: unknown): ParsedInteraction[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedInteraction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const t = rec['type'];
    if (
      t !== 'click' &&
      t !== 'rightclick' &&
      t !== 'type' &&
      t !== 'keydown' &&
      t !== 'keyup' &&
      t !== 'keypress' &&
      t !== 'upload' &&
      t !== 'select'
    )
      continue;
    const parsed: ParsedInteraction = { type: t };
    if (typeof rec['file'] === 'string' && rec['file']) {
      parsed.file = rec['file'];
    }
    if (typeof rec['selector'] === 'string' && rec['selector']) {
      parsed.selector = rec['selector'];
    }
    if (typeof rec['x'] === 'number' && Number.isFinite(rec['x'])) {
      parsed.x = rec['x'];
    }
    if (typeof rec['y'] === 'number' && Number.isFinite(rec['y'])) {
      parsed.y = rec['y'];
    }
    if (typeof rec['key'] === 'string' && rec['key']) {
      parsed.key = rec['key'];
    }
    if (typeof rec['text'] === 'string') {
      parsed.text = rec['text'];
    }
    // A number is the same choice as its digits: `{ value: 12 }` for a slider.
    if (typeof rec['value'] === 'string' || (typeof rec['value'] === 'number' && Number.isFinite(rec['value']))) {
      parsed.value = String(rec['value']);
    }
    if (typeof rec['holdMs'] === 'number' && Number.isFinite(rec['holdMs'])) {
      parsed.holdMs = rec['holdMs'];
    }
    out.push(parsed);
  }
  return out;
}

/** Letters, digits, `_ - . /` and spaces: a path that reaches a prompt as itself. */
const SERVABLE_PATH = /^[\p{L}\p{N}_\-. /]+$/u;

/**
 * The page path a static server rooted at the workspace serves for this entry,
 * or null. Only a relative HTML path of plain characters is one: no scheme,
 * leading slash, backslash, quote or control character, no `.` or `..`
 * segment, and nothing under an `.atoma` directory. The host still requires a
 * regular file at that path, reached through no symlink.
 */
export function servableCheckFile(file: string): string | null {
  if (file.length === 0 || file.length > 512 || !SERVABLE_PATH.test(file) || file.startsWith('/')) return null;
  const parts = file.replace(/^\.\//, '').split('/');
  if (parts.some((part) => part.trim() !== part || part === '' || part === '.' || part === '..' || part.startsWith('.atoma'))) return null;
  return /\.html?$/i.test(file) ? parts.join('/') : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A recorded viewport as `validate_html` accepts it; `null` when one is present but no size it accepts. */
export function recordedViewport(raw: unknown): { readonly width: number; readonly height?: number } | null | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const px = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_VIEWPORT_PX && value <= MAX_VIEWPORT_PX;
  if (!px(raw['width'])) return null;
  if (raw['height'] !== undefined && !px(raw['height'])) return null;
  return { width: raw['width'], ...(px(raw['height']) ? { height: raw['height'] } : {}) };
}

/** JSON with object keys sorted at every depth: key order never makes two values differ. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner) ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]])) : inner);
}

/**
 * WEB identity, the ONE definition: what a replay runs, as `validate_html`
 * reads it. The page (`servableCheckFile`, or the file as written when it is
 * not one), the interactions `parseInteractions` keeps (a keypress with its
 * hold, defaulted and capped; no other step holds), the smoke, the viewport as
 * recorded, and the settle time, defaulted and capped. A field the tool never
 * reads, the order of keys, and `12` against `"12"` change nothing. The
 * manifest merge replaces by it (`matchesWebIdentity`), and the
 * inherited-check replay groups entries by it. Run 0b51e494 (2026-10-01)
 * recorded a Space check and an S check that read one state smoke; under a
 * file+smoke identity, the S check replaced the Space one in the same write.
 */
export function webEntryIdentity(entry: Readonly<Record<string, unknown>>): string {
  const file = entry['file'];
  const interactions = parseInteractions(entry['interactions']).map(({ holdMs, ...step }) =>
    step.type === 'keypress' ? { ...step, holdMs: Math.min(Math.max(0, Math.floor(holdMs ?? DEFAULT_HOLD_MS)), MAX_HOLD_MS) } : step);
  const viewport = recordedViewport(entry['viewport']);
  const wait = entry['waitMs'];
  return canonicalJson([
    typeof file === 'string' ? servableCheckFile(file) ?? file : null,
    interactions,
    typeof entry['smoke'] === 'string' ? entry['smoke'] : null,
    viewport === undefined ? null : viewport ?? entry['viewport'],
    typeof wait === 'number' && Number.isFinite(wait) ? Math.min(Math.max(0, Math.floor(wait)), MAX_WAIT_MS) : DEFAULT_WAIT_MS,
  ]);
}

/**
 * Dotted paths of every `false` boolean in a structured smoke result, `ok`
 * itself excluded.
 *
 * MEASURED 2026-08-23, project run `a786358a`: twelve smoke failures whose
 * only report was the pasted result object, so the caller had to diagnose
 * its own output to find which of a dozen fields came back false —
 * `themeToggledToDark`, `beforeResetElapsedGreaterThanZero`. The names were
 * in our hands and we were not saying them, and the 500-char truncation of
 * the pasted object could cut off the very field that failed.
 *
 * It NAMES, it does not judge: `isSmokeOk` keeps an explicit `ok` as the
 * only authority, because raw state legitimately contains false booleans.
 * Bounded in depth and count so a large state dump cannot turn one error
 * line into a page.
 */
export const FALSE_FIELD_LIMIT = 12;
export const FALSE_FIELD_DEPTH = 3;

export function falseBooleanFields(
  value: unknown,
  maxDepth = FALSE_FIELD_DEPTH,
  maxFields = FALSE_FIELD_LIMIT
): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (out.length >= maxFields || depth > maxDepth) return;
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (out.length >= maxFields) return;
      const here = path ? `${path}.${key}` : key;
      if (child === false) {
        if (here !== 'ok') out.push(here);
      } else if (child !== null && typeof child === 'object') {
        walk(child, here, depth + 1);
      }
    }
  };
  walk(smokeResultRecord(value), '', 1);
  return out;
}

function smokeResultRecord(value: unknown): unknown {
  return Array.isArray(value) ? { ...value } : value;
}
