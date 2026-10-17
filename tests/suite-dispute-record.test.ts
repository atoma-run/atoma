import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUITE_DISPUTE_EXCERPT_CHARS,
  SUITE_DISPUTE_OBSERVATIONS,
  SUITE_DISPUTE_TASK_CHARS,
  SUITE_DISPUTE_TRACE_ENTRIES,
  appendSuiteDisputeEntry,
  readSuiteDisputeEntries,
  suiteDisputeCountedEntry,
  suiteDisputeCountedSchema,
  suiteDisputeEntrySchema,
  suiteDisputeLaterEntry,
  type SuiteDisputeEntry,
} from '../src/contracts/suiteDisputeRecord.js';
import { parentTestSuiteDigest, type ParentTestSuite } from '../src/contracts/parentTests.js';
import { readTraceTopLevelFields } from '../src/contracts/traceFields.js';
import { TraceRecorder, type VizRun } from '../src/viz/trace.js';

/**
 * The record of a suite dispute (2026-10-17): a strict writer, a tolerant
 * reader and a capped top-level trace member. What a counted entry holds is
 * what the pre-registered classification reads, so a writer that refused a
 * real dispute, or a reader that threw on one odd entry, would lose units.
 */

const SUITE: ParentTestSuite = { requirement: 'adds two numbers', cwd: '.', source: "import { test, expect } from 'vitest';\ntest('adds', () => { expect(1 + 1).toBe(3); });" };
const DIGEST = parentTestSuiteDigest(SUITE);

const observation = (subjectDigest: string, status: 'failed' | 'passed' = 'failed') => ({
  observedAt: 1_000, subjectDigest, workspaceDigest: 'w'.repeat(64), status, cause: 'ran' as const, passed: 0, failed: 1, skipped: 0,
});

function counted(overrides: Partial<Parameters<typeof suiteDisputeCountedEntry>[0]> = {}) {
  return suiteDisputeCountedEntry({
    key: { id: randomUUID(), at: 2_000, attempt: 1, branchId: 'lane-1', suiteDigest: DIGEST },
    owner: { name: 'Cell', tier: 2 }, failingChild: 'Molecule', phase: 'repeat', task: 'add numbers', suite: SUITE,
    excerpt: '[{"name":"adds","failure":"AssertionError: expected 2 to be 3"}]', counts: { observations: 3, subjects: 3 },
    observations: ['a', 'b', 'c'].map((subject) => ({ observation: observation(subject), sameSet: true })),
    ...overrides,
  });
}

function later(countId: string) {
  return suiteDisputeLaterEntry({
    key: { id: randomUUID(), at: 3_000, suiteDigest: DIGEST }, countId,
    producedBy: { name: 'Cell', tier: 2, viaFallback: true }, observation: observation('d', 'passed'), sameSet: false,
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the writer', () => {
  it('writes a counted entry whose suite re-digests to its key, and a later entry that names its count', () => {
    const entry = counted();
    expect(suiteDisputeCountedSchema.parse(entry)).toEqual(entry);
    expect(parentTestSuiteDigest(entry.suite)).toBe(entry.suiteDigest);
    expect(entry).toMatchObject({ v: 1, type: 'counted', attempt: 1, branchId: 'lane-1', counts: { observations: 3, subjects: 3 } });
    const follow = later(entry.id);
    expect(suiteDisputeEntrySchema.parse(follow)).toEqual(follow);
    expect(follow).toMatchObject({ type: 'later', countId: entry.id, producedBy: { viaFallback: true }, observation: { status: 'passed', sameSet: false } });
    // An observation keeps no details and no child output: only what classifies it.
    expect(Object.keys(entry.observations[0]!).sort()).toEqual(
      ['cause', 'failed', 'observedAt', 'passed', 'sameSet', 'skipped', 'status', 'subjectDigest', 'workspaceDigest']);
  });

  it('bounds what a real dispute can make long, instead of refusing it', () => {
    const entry = counted({
      task: 't'.repeat(5_000), excerpt: 'e'.repeat(5_000),
      observations: Array.from({ length: 40 }, (_, index) => ({ observation: observation(`s${index}`), sameSet: true })),
    });
    expect(entry.task).toHaveLength(SUITE_DISPUTE_TASK_CHARS);
    expect(entry.excerpt).toHaveLength(SUITE_DISPUTE_EXCERPT_CHARS);
    // The latest observations are the ones kept.
    expect(entry.observations).toHaveLength(SUITE_DISPUTE_OBSERVATIONS);
    expect(entry.observations.at(-1)?.subjectDigest).toBe('s39');
    expect(entry.observations[0]?.subjectDigest).toBe('s8');
  });

  it('refuses what no host writes: a key that is not a digest, an unknown field', () => {
    expect(() => counted({ key: { id: randomUUID(), at: 1, suiteDigest: 'abc' } })).toThrow();
    expect(suiteDisputeEntrySchema.safeParse({ ...counted(), extra: true }).success).toBe(false);
  });
});

describe('the reader', () => {
  it('reads an absent member as no entries, and a member that is not a list as one malformed item', () => {
    expect(readSuiteDisputeEntries(undefined)).toEqual({ entries: [], malformed: 0 });
    expect(readSuiteDisputeEntries({ not: 'a list' })).toEqual({ entries: [], malformed: 1 });
  });

  it('keeps what it knows: an unknown cause, a later version, an unreadable observation dropped and its entry kept', () => {
    const entry = counted();
    const odd = {
      ...entry, v: 2, futureField: 'kept out',
      observations: [{ ...entry.observations[0], cause: 'a-cause-from-later' }, { status: 'exploded' }, entry.observations[2]],
    };
    const { entries, malformed } = readSuiteDisputeEntries([odd, { type: 'unknown-kind' }, { ...later(entry.id), suiteDigest: 'not hex' }]);
    expect(malformed).toBe(2);
    expect(entries).toHaveLength(1);
    const read = entries[0]!;
    if (read.type !== 'counted') throw new Error('expected a counted entry');
    expect(read.v).toBe(2);
    expect(read).not.toHaveProperty('futureField');
    expect(read.observations).toHaveLength(2);
    expect(read.observations[0]?.cause).toBeUndefined();
    expect(read.observations[0]?.subjectDigest).toBe('a');
  });
});

describe('the cap', () => {
  it('holds 64 entries; a counted entry displaces the newest later one, a later one displaces nothing', () => {
    const first = counted();
    const entries: SuiteDisputeEntry[] = [first];
    while (entries.length < SUITE_DISPUTE_TRACE_ENTRIES) entries.push(later(first.id));
    const newestLater = entries.at(-1)!;
    expect(appendSuiteDisputeEntry(entries, later(first.id))).toBe(false);
    const second = counted();
    expect(appendSuiteDisputeEntry(entries, second)).toBe(true);
    expect(entries).toHaveLength(SUITE_DISPUTE_TRACE_ENTRIES);
    expect(entries).not.toContain(newestLater);
    expect(entries.at(-1)).toBe(second);
    const full = Array.from({ length: SUITE_DISPUTE_TRACE_ENTRIES }, () => counted() as SuiteDisputeEntry);
    expect(appendSuiteDisputeEntry(full, counted())).toBe(false);
  });
});

describe('the trace member', () => {
  it('is one more top-level member of the one JSON object, absent on a run without a dispute, never an event', () => {
    const runs = mkdtempSync(join(tmpdir(), 'atoma-suite-dispute-trace-'));
    dirs.push(runs);
    const recorder = new TraceRecorder(runs);
    recorder.beginRun({ description: 'without a dispute' }, 'quiet', { runId: 'quiet' });
    recorder.endRun({ result: { summary: 's', output: 'o', producedBy: { tier: 3, name: 'T', viaFallback: false } } });
    const quiet = JSON.parse(readFileSync(join(runs, 'quiet.json'), 'utf8')) as VizRun;
    expect(quiet).not.toHaveProperty('suiteDisputes');

    recorder.beginRun({ description: 'with a dispute' }, 'disputed', { runId: 'disputed' });
    const entry = counted();
    recorder.recordSuiteDispute(entry);
    recorder.recordSuiteDispute(later(entry.id));
    recorder.endRun({ result: { summary: 's', output: 'o', producedBy: { tier: 3, name: 'T', viaFallback: false } } });
    const file = join(runs, 'disputed.json');
    const trace = JSON.parse(readFileSync(file, 'utf8')) as VizRun;
    expect(trace.suiteDisputes?.map((item) => item.type)).toEqual(['counted', 'later']);
    expect(trace.events).toEqual([]);
    // The coordinator's projection reads the same members it did.
    const fields = readTraceTopLevelFields(file, { values: ['id', 'endedAt'], shapes: ['result', 'error', 'suiteDisputes'] });
    expect(fields.values['id']).toBe('disputed');
    expect(fields.shapes).toMatchObject({ result: 'object', suiteDisputes: 'array' });
    expect(fields.shapes['error']).toBeUndefined();
  });
});
