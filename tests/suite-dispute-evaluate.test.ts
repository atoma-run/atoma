import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LEGACY_UNITS, Refusal, evaluate } from '../benchmark/suite-dispute-2026-10-17/evaluate.mjs';

/**
 * The pre-registered evaluator of the suite-dispute measurement
 * (benchmark/suite-dispute-2026-10-17/): it refuses a gap, applies the
 * mechanical override, and reads the rule at 20 and at 40 units and nowhere
 * else, on units and on clusters.
 */

const UNTIL = '2026-12-01T00:00:00.000Z';
const LEGACY = LEGACY_UNITS[0]!.key;
type Unit = { key: string; cluster: string; firstCountAt: string; outcome: string; pending: boolean; evidenceUnreadable: number };

/** `count` listed units after the hand-entered one, one cluster each unless told otherwise. */
function units(count: number, shape: (index: number) => Partial<Unit> = () => ({})): Unit[] {
  return Array.from({ length: count }, (_, index) => ({
    key: createHash('sha256').update(`unit-${index}`).digest('hex'),
    cluster: `cluster-${index}`,
    firstCountAt: new Date(Date.parse('2026-10-20T00:00:00.000Z') + index * 60_000).toISOString(),
    outcome: 'never-passed', pending: false, evidenceUnreadable: 0,
    ...shape(index),
  }));
}

function page(list: Unit[], offset = 0, size = list.length, extra: Record<string, unknown> = {}) {
  return {
    view: 'rows', horizon: '2026-11-30T00:00:00.000Z', window: { since: null, until: UNTIL }, total: list.length, offset, limit: 20,
    listDigest: createHash('sha256').update(list.map((unit) => unit.key).join('\n')).digest('hex'),
    units: list.slice(offset, offset + size), legacy: [], unreadable: [], malformedEntries: 0, ...extra,
  };
}

/** Labels for the first `count` units of the sequence (the hand-entered one first). */
function labels(list: Unit[], count: number, classOf: (index: number) => string) {
  return [LEGACY, ...list.map((unit) => unit.key)].slice(0, count).map((key, index) => ({
    key, class: classOf(index), reason: `run r${index}: assertion A contradicts requirement clause B`, by: 'labeller', at: '2026-12-02T00:00:00.000Z',
  }));
}

const refusal = (run: () => unknown, message: RegExp) => {
  expect(run).toThrow(Refusal);
  expect(run).toThrow(message);
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the suite-dispute evaluator', () => {
  it('refuses a gap: an unlabelled unit before a labelled one, a label for no unit, pages that skip', () => {
    const list = units(30);
    const gap = labels(list, 6, () => 'wrong-suite').filter((_, index) => index !== 3);
    refusal(() => evaluate({ rows: page(list), labels: gap }), /a gap: unit 4/);
    refusal(() => evaluate({ rows: page(list), labels: [...labels(list, 2, () => 'wrong-suite'), { ...labels(list, 1, () => 'undecidable')[0]!, key: 'f'.repeat(64) }] }), /does not hold/);
    refusal(() => evaluate({ rows: [page(list, 0, 20), page(list, 21, 9)], labels: [] }), /a gap between pages/);
    refusal(() => evaluate({ rows: { ...page(list), listDigest: '0'.repeat(64) }, labels: [] }), /listDigest/);
    refusal(() => evaluate({ rows: { ...page(list), window: { since: null, until: null } }, labels: [] }), /fixed until/);
    refusal(() => evaluate({ rows: page(list, 0, 30, { unreadable: [{ runId: 'r-unread', reason: 'run trace was never written' }] }), labels: [] }), /could not read/);
    // The hand-entered unit's own run may expire: its unit does not come from rows.
    expect(evaluate({ rows: page(list, 0, 30, { unreadable: [{ runId: LEGACY_UNITS[0]!.firstRunId, reason: 'run bytes expired under retention' }] }), labels: [] }).status).toBe('pending');
    refusal(() => evaluate({ rows: page(list), labels: [{ ...labels(list, 1, () => 'wrong-suite')[0]!, reason: 'x'.repeat(281) }] }), /reason/);
    refusal(() => evaluate({ rows: page(list), labels: [...labels(list, 1, () => 'wrong-suite'), ...labels(list, 1, () => 'wrong-suite')] }), /two labels/);
    refusal(() => evaluate({ rows: page(list), labels: labels(list, 1, () => 'maybe') }), /class/);
    refusal(() => evaluate({ rows: page(list.map((unit, index) => ({ ...unit, pending: index === 0 }))), labels: labels(list, 2, () => 'undecidable') }), /in flight/);
  });

  it('reads nothing before 20, decides at 20 on a pass, and never reads 40 after one', () => {
    const list = units(45);
    const early = evaluate({ rows: page(list), labels: labels(list, 19, () => 'wrong-suite') });
    expect(early).toMatchObject({ status: 'pending', labelled: 19, readings: {} });
    const passed = evaluate({ rows: page(list), labels: labels(list, 40, (index) => (index % 2 === 0 ? 'wrong-suite' : 'undecidable')) });
    expect(passed).toMatchObject({ status: 'pass', decision: 'pass at 20', units: 46, labelled: 40 });
    expect(Object.keys(passed.readings)).toEqual(['20']);
    expect(passed.readings['20']).toMatchObject({ n: 20, units: { total: 20, 'wrong-suite': 10, undecidable: 10, pass: true }, pass: true });
    // The legacy unit leads the sequence, and the owner's five are drawn among the units read.
    expect(passed.ownerRelabel.units).toHaveLength(5);
    expect(new Set(passed.ownerRelabel.units).size).toBe(5);
  });

  it('continues past a fail at 20, reads 40, and closes the measurement on a fail there', () => {
    const list = units(45);
    const failing = (index: number) => (index < 9 ? 'wrong-suite' : 'wrong-implementation');
    expect(evaluate({ rows: page(list), labels: labels(list, 39, failing) })).toMatchObject({ status: 'continue', readings: { 20: { pass: false } } });
    const closed = evaluate({ rows: page(list), labels: labels(list, 40, failing) });
    expect(closed).toMatchObject({ status: 'fail', decision: 'fail at 40: the measurement is closed' });
    expect(Object.keys(closed.readings).sort()).toEqual(['20', '40']);
    const recovered = evaluate({ rows: page(list), labels: labels(list, 40, (index) => (index < 9 || index >= 20 ? 'wrong-suite' : 'undecidable')) });
    expect(recovered).toMatchObject({ status: 'pass', decision: 'pass at 40' });
  });

  it('applies the mechanical override: a suite that passed later is a wrong implementation whatever its label', () => {
    const list = units(25, (index) => ({ outcome: index < 2 ? 'passed-later' : 'never-passed' }));
    // Ten wrong suites of twenty would pass; two of them passed later.
    const result = evaluate({ rows: page(list), labels: labels(list, 20, (index) => (index < 10 ? 'wrong-suite' : 'wrong-implementation')) });
    expect(result.readings['20']).toMatchObject({ units: { 'wrong-suite': 8, 'wrong-implementation': 12, pass: false }, pass: false });
    expect(result.readings['20']!.overridden).toEqual([list[0]!.key, list[1]!.key]);
    expect(result.status).toBe('continue');
  });

  it('reads clusters too: wrong suites crowded into one run do not pass alone', () => {
    // Ten wrong suites, all in one cluster; ten wrong implementations, one cluster each.
    const list = units(25, (index) => ({ cluster: index < 9 ? 'one-run' : `cluster-${index}` }));
    const result = evaluate({ rows: page(list), labels: labels(list, 20, (index) => (index < 10 ? 'wrong-suite' : 'wrong-implementation')) });
    expect(result.readings['20']).toMatchObject({ units: { pass: true }, clusters: { total: 12, 'wrong-suite': 2, pass: false }, pass: false });
  });

  it('runs as a script: results.json on a reading, exit 1 and nothing written on a refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-suite-dispute-evaluate-'));
    dirs.push(dir);
    const script = resolve('benchmark/suite-dispute-2026-10-17/evaluate.mjs');
    const none = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('no rows.json yet');
    const list = units(25);
    writeFileSync(join(dir, 'rows.json'), JSON.stringify([page(list, 0, 20), page(list, 20, 5)]));
    writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels(list, 20, () => 'wrong-suite')));
    const read = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    expect(read.status, read.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))).toMatchObject({ status: 'pass', labelled: 20 });
    rmSync(join(dir, 'results.json'));
    writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels(list, 20, () => 'wrong-suite').filter((_, index) => index !== 7)));
    const refused = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refused: a gap');
    expect(existsSync(join(dir, 'results.json'))).toBe(false);
  });
});
