import { GROUND_TRUTH_MARKER } from '../../contracts/scriptEnvelope.js';
// The browser-safe record module ONLY: `contracts/parentTests.ts` needs node:crypto.
import {
  summarizeParentTests,
  type ParentTestCause,
  type ParentTestLimits,
  type ParentTestRow,
  type ParentTestStatus,
  type ParentTestSummary,
} from '../../contracts/parentTestRecord.js';
import type { RunParentTests } from '../../contracts/clientExperience.js';
import type { VizProjectRun, VizRun } from '../client/types.js';

/**
 * The text parts of an answer aggregated by concatenation, nested at any
 * depth (an L3 concat over L2 concats); null as soon as one part is not text.
 */
function textParts(output: unknown): string[] | null {
  if (!Array.isArray(output) || output.length === 0) return null;
  const parts: string[] = [];
  for (const part of output) {
    if (typeof part === 'string') parts.push(part);
    else {
      const nested = textParts(part);
      if (!nested) return null;
      parts.push(...nested);
    }
  }
  return parts;
}

/** Only the persisted final output is a delivery; intermediate events are not. */
export function resultText(run: VizRun | null): string | null {
  const output = run?.result?.output;
  if (output === undefined || output === null) return null;
  if (typeof output === 'string') return output;
  // Copy and export read text as text, not as its JSON encoding.
  const parts = textParts(output);
  if (parts) return parts.filter(part => part.trim()).join('\n\n');
  return JSON.stringify(output, null, 2);
}

export function resultSections(run: VizRun): { title: string; text: string }[] {
  const output = run.result?.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return Object.entries(output).map(([title, value]) => ({
      title, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }));
  }
  const text = resultText(run);
  return text === null ? [] : [{ title: '', text }];
}

/** Prose for the reader; the complete structured output stays in details/export. */
export function resultNarrative(run: VizRun): { title: string; text: string }[] {
  const output = run.result?.output;
  if (typeof output === 'string') return [{ title: '', text: output }];
  // Concatenated phases of a text delivery: one answer in parts.
  const parts = textParts(output);
  if (parts) return parts.filter(part => part.trim()).map(text => ({ title: '', text }));
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return Object.entries(output).flatMap(([title, value]) =>
      typeof value === 'string' && value.trim() ? [{ title, text: value }] : []);
  }
  return [];
}

/**
 * A summary is what was done, then — after the host-taught marker line — how
 * it was checked. A reader leads with the first; the second is evidence.
 */
export function splitSummary(summary: string): { lead: string; checks: string | null } {
  const lines = summary.split(/\r?\n/);
  const at = lines.findIndex(line => line.trim() === GROUND_TRUTH_MARKER);
  if (at < 0) return { lead: summary.trim(), checks: null };
  const checks = lines.slice(at + 1).filter(line => line.trim() !== GROUND_TRUTH_MARKER).join('\n').trim();
  return { lead: lines.slice(0, at).join('\n').trim(), checks: checks || null };
}

export interface ReadableBlock { readonly kind: 'heading' | 'text'; readonly text: string }

const inlineMarkdown = (text: string) =>
  text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`\n]+)`/g, '$1');

/**
 * Markdown an answer was written in, as blocks the canvas can draw: headings
 * become headings, emphasis and inline code marks go, list items take a
 * bullet, table rows read as cells, and fenced code stays verbatim. The
 * canvas draws text, never HTML, so this changes how it reads, not what runs.
 */
export function readableBlocks(source: string): ReadableBlock[] {
  const blocks: ReadableBlock[] = [];
  let paragraph: string[] = [];
  let fenced = false;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'text', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (const raw of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fenced = !fenced; continue; }
    if (fenced) { paragraph.push(raw); continue; }
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: inlineMarkdown(heading[1]!) }); continue; }
    // A table's separator row, or a horizontal rule: structure, not content.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      paragraph.push(line.trim().slice(1, -1).split('|').map(cell => inlineMarkdown(cell.trim())).join('  ·  '));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    paragraph.push(bullet ? `${bullet[1]}• ${inlineMarkdown(bullet[2]!)}` : inlineMarkdown(line));
  }
  flush();
  return blocks;
}

/** Pin file links to THIS delivery, never to the repository's moving main. */
export function resultFileUrl(run: VizProjectRun, path: string): string | null {
  const publication = run.publication;
  if (publication?.status !== 'published' || !publication.repositoryUrl ||
      !publication.commitSha || !/^[a-f0-9]{40}$/i.test(publication.commitSha)) return null;
  try {
    const url = new URL(publication.repositoryUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password ||
        !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) return null;
    if (path.split('/').some(part => !part || part === '..' || part === '.') || path.includes('\\')) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/blob/${publication.commitSha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  } catch { return null; }
}

export function latestDeliveredResult(runs: readonly VizProjectRun[]): VizProjectRun | undefined {
  return runs.filter(run => run.status === 'delivered' && !run.rerunOf && run.traceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** What the result view lists: every record a person may want, bounded. */
export const VIZ_PARENT_TEST_LIMITS: ParentTestLimits = { rows: 24, requirementChars: 600, detailsChars: 600, detailRows: 24 };

const NO_RESULT = summarizeParentTests(undefined, VIZ_PARENT_TEST_LIMITS);
const parentTestSummaries = new WeakMap<object, ParentTestSummary>();

/** The shared projection of this run's records, computed once per result object (the view redraws often). */
export function resultParentTests(run: VizRun): ParentTestSummary {
  const result = run.result;
  if (!result) return NO_RESULT;
  const held = parentTestSummaries.get(result);
  if (held) return held;
  const summary = summarizeParentTests(result, VIZ_PARENT_TEST_LIMITS);
  parentTestSummaries.set(result, summary);
  return summary;
}

/** Typed tables: a new status or cause does not compile without its copy. */
export const PARENT_TEST_STATUS_KEYS: Record<ParentTestStatus, string> = {
  passed: 'result.tests.status.passed',
  failed: 'result.tests.status.failed',
  unavailable: 'result.tests.status.unavailable',
};
export const PARENT_TEST_CAUSE_KEYS: Record<ParentTestCause | 'unknown', string> = {
  'ran': 'result.tests.cause.ran',
  'timeout': 'result.tests.cause.timeout',
  'exited-without-report': 'result.tests.cause.exited-without-report',
  'source-changed': 'result.tests.cause.source-changed',
  'report-oversize': 'result.tests.cause.report-oversize',
  'report-invalid': 'result.tests.cause.report-invalid',
  'report-tampered': 'result.tests.cause.report-tampered',
  'snapshot-link': 'result.tests.cause.snapshot-link',
  'snapshot-bounds': 'result.tests.cause.snapshot-bounds',
  'snapshot-timeout': 'result.tests.cause.snapshot-timeout',
  'snapshot-special-file': 'result.tests.cause.snapshot-special-file',
  'worker-missing': 'result.tests.cause.worker-missing',
  'assertions-tampered': 'result.tests.cause.assertions-tampered',
  'runner-error': 'result.tests.cause.runner-error',
  'no-executor': 'result.tests.cause.no-executor',
  'invalid-observation': 'result.tests.cause.invalid-observation',
  'executor-error': 'result.tests.cause.executor-error',
  'landing': 'result.tests.cause.landing',
  'deadline-timeout': 'result.tests.cause.deadline-timeout',
  'unknown': 'result.tests.cause.unknown',
};

/** Suite counts that are not zero, failures first, and the records no reader could read. */
export function parentTestCountFragments(summary: Pick<ParentTestSummary, 'suites' | 'records'>): { key: string; count: number }[] {
  const fragments = [
    { key: 'result.tests.suitesFailed', count: summary.suites.failed },
    { key: 'result.tests.suitesUnavailable', count: summary.suites.unavailable },
    { key: 'result.tests.suitesPassed', count: summary.suites.passed },
    { key: 'result.tests.unreadable', count: summary.records.invalid },
  ];
  return fragments.filter(fragment => fragment.count > 0);
}

export interface ParentTestLine {
  readonly text: string;
  readonly heading?: boolean;
  readonly muted?: boolean;
}

// The requirement is plan prose and drawn as text: it never goes through t(),
// whose interpolation and nesting would read `{{x}}` or `$t(x)` inside it.
function rowTitle(row: ParentTestRow, t: Translate): string {
  return `${t(PARENT_TEST_STATUS_KEYS[row.status])} · ${row.requirement ?? t('result.tests.noRequirement')}`;
}

function rowNote(row: ParentTestRow, t: Translate): string {
  const counts = [
    row.failed > 0 ? t('result.tests.testsFailed', { count: row.failed }) : null,
    row.passed > 0 ? t('result.tests.testsPassed', { count: row.passed }) : null,
    row.skipped > 0 ? t('result.tests.testsSkipped', { count: row.skipped }) : null,
  ].filter((part): part is string => part !== null);
  const outcome = row.status !== 'unavailable' && counts.length > 0
    ? counts.join(' · ')
    : t(PARENT_TEST_CAUSE_KEYS[row.cause ?? 'unknown']);
  const flags = [
    row.judged ? t('result.tests.judged') : null,
    row.superseded ? t('result.tests.superseded') : null,
  ].filter((part): part is string => part !== null);
  return [outcome, ...flags].join(' ');
}

const MAIN_VIEW_ROWS = 5;

/**
 * The result view's main block: counts, then the open records (not passed
 * and not superseded), at most five. Nothing at all when the result records
 * none: absence is not drawn as a pass.
 */
export function parentTestLines(summary: ParentTestSummary, t: Translate, detailsOpen: boolean): ParentTestLine[] {
  if (summary.state !== 'recorded') return [];
  const lines: ParentTestLine[] = [{ text: t('result.tests.title'), heading: true }];
  const fragments = parentTestCountFragments(summary).map(fragment => t(fragment.key, { count: fragment.count }));
  if (fragments.length > 0) lines.push({ text: fragments.join(' · ') });
  lines.push({ text: t('result.tests.hint'), muted: true });
  const open = summary.observations.filter(row => row.status !== 'passed' && !row.superseded).slice(0, MAIN_VIEW_ROWS);
  for (const row of open) {
    lines.push({ text: rowTitle(row, t) });
    lines.push({ text: rowNote(row, t), muted: true });
  }
  const more = summary.records.distinct - open.length;
  if (more > 0 && !detailsOpen) lines.push({ text: t('result.tests.more', { count: more }), muted: true });
  return lines;
}

const shortDigest = (digest: string, t: Translate): string =>
  /^[0-9a-f]+$/i.test(digest) ? digest.slice(0, 12) : t('result.tests.notRecorded');

/** Every listed record, for the technical details: counts, flags, digests and the raw bounded details. */
export function parentTestRecordLines(summary: ParentTestSummary, t: Translate): ParentTestLine[] {
  if (summary.state !== 'recorded') return [];
  const lines: ParentTestLine[] = [{ text: t('result.tests.records'), heading: true }];
  for (const row of summary.observations) {
    lines.push({ text: rowTitle(row, t) });
    lines.push({ text: rowNote(row, t), muted: true });
    lines.push({ text: t('result.tests.digests', { suite: shortDigest(row.suiteDigest, t), workspace: shortDigest(row.workspaceDigest, t) }), muted: true });
    // Child-controlled and often cut mid-JSON: shown as raw text, never parsed.
    if (row.details !== null) lines.push({ text: row.detailsTruncated ? `${row.details}…` : row.details });
  }
  if (summary.records.omitted > 0) lines.push({ text: t('result.tests.omitted', { count: summary.records.omitted }), muted: true });
  if (summary.records.invalid > 0) lines.push({ text: t('result.tests.unreadable', { count: summary.records.invalid }), muted: true });
  return lines;
}

/**
 * The receipt card's one line at the acceptance moment: only when a suite
 * failed or did not run, a record could not be read, or the trace itself
 * could not be. An all-passed or absent record set adds nothing.
 */
export function parentTestCardLine(parentTests: RunParentTests | undefined, t: Translate): string | null {
  if (!parentTests) return null;
  if (parentTests.state === 'unavailable') return t('result.tests.recordsUnavailable');
  if (parentTests.suites.failed + parentTests.suites.unavailable + parentTests.records.invalid === 0) return null;
  return parentTestCountFragments(parentTests).map(fragment => t(fragment.key, { count: fragment.count })).join(' · ');
}
