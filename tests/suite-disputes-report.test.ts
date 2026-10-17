import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parentTestSuiteDigest } from '../src/contracts/parentTests.js';
import { MAX_TRACE_BYTES } from '../src/contracts/traceFields.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { suiteDisputeReport } from '../src/projects/suiteDisputes.js';
import { ProjectHttpError } from '../src/projects/service.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { executionProvenance } from '../src/viz/trace.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { addDisputeRun, countedFor, disputeSuite, laterFor, record } from './helpers/suiteDisputes.js';

/**
 * The suite-dispute report (2026-10-17) on traces the real recorder wrote:
 * units deduplicated by suite digest and ordered by first count, the three
 * outcomes, legacy and unreadable runs, a list digest that pins the order,
 * malformed entries and a trace past the materialisation ceiling. It is the
 * body the platform MCP tool and the CLI both mount.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  closeStoreHandles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-20T08:00:00.000Z');
const at = (minutes: number) => T0 + minutes * 60_000;

/** Two organisations, six runs, four disputed suites, one legacy and one unreadable run. */
function corpus() {
  vi.useFakeTimers({ toFake: ['Date'], now: at(0) });
  const root = mkdtempSync(join(tmpdir(), 'atoma-suite-disputes-'));
  dirs.push(root);
  const one = projectRetrievalFixture(root, { subject: 'first', slug: 'first' });
  const two = projectRetrievalFixture(root, { subject: 'second', slug: 'second' });
  const S1 = disputeSuite('REQ-ONE the parser keeps escapes');
  const S2 = disputeSuite('REQ-TWO the index is sorted');
  const S3 = disputeSuite('REQ-THREE the export names its columns');
  const S3b = disputeSuite('REQ-THREE the export names its columns', 'a revised suite');
  const S4 = disputeSuite('REQ-FOUR the cache expires');
  const c1 = countedFor(S1, at(1));
  const c2 = countedFor(S2, at(2));
  const c3 = countedFor(S3, at(3), { excerpt: '[{"name":"columns","failure":"another failing set"}]' });
  // Project one: the first run counts three suites, its resume counts S1 again and
  // sees it pass, a later run passes a revision of S3.
  vi.setSystemTime(at(0));
  const runA = addDisputeRun(one, { status: 'partial', disputes: 3, entries: [c1, c2, c3] });
  vi.setSystemTime(at(10));
  const again = countedFor(S1, at(11), { attempt: 1 });
  const runB = addDisputeRun(one, { status: 'partial', disputes: 1, entries: [again, laterFor(again, at(12), 'passed')] });
  vi.setSystemTime(at(20));
  const runC = addDisputeRun(one, { status: 'delivered', disputes: 0, parentTests: [record(S3b, 'passed', at(21)), record(S2, 'failed', at(21))] });
  // Project two: S4 passes in a later run's result; a legacy run; a run whose trace is gone.
  vi.setSystemTime(at(30));
  const c4 = countedFor(S4, at(31));
  const runD = addDisputeRun(two, { status: 'partial', disputes: 1, entries: [c4], raw: [{ type: 'counted', note: 'malformed' }] });
  vi.setSystemTime(at(40));
  const runE = addDisputeRun(two, { status: 'delivered', disputes: 0, parentTests: [record(S4, 'passed', at(41))] });
  vi.setSystemTime(at(50));
  const legacy = addDisputeRun(two, { status: 'partial', disputes: 1 });
  vi.setSystemTime(at(60));
  const gone = addDisputeRun(two, { status: 'partial', disputes: 1, entries: [countedFor(disputeSuite('REQ-GONE'), at(61))], removeTrace: true });
  vi.setSystemTime(at(90));
  const orgIds = [one.viewer.orgId, two.viewer.orgId];
  return { root, one, two, orgIds, store: one.projects, S1, S2, S3, S3b, S4, c1, c2, c3, c4, runA, runB, runC, runD, runE, legacy, gone };
}

type Row = { key: string; cluster: string; firstRunId: string; runIds: string[]; outcome: string; outcomeRunId: string | null; revisedBy?: string;
  counts: { observations: number; subjects: number; counted: number; later: number }; relatedSuites: string[]; evidenceUnreadable: number; firstCountAt: string };
type Report = { view: string; total: number; listDigest: string; nextOffset: number | null; units: Row[]; horizon: string;
  legacy: { runId: string; statsCount: number; countedEntries: number }[]; unreadable: { runId: string | null; reason: string }[]; malformedEntries: number };

describe('the suite-dispute report', () => {
  it('lists one unit per suite digest, ordered by first count, with its outcome as of the horizon', async () => {
    const c = corpus();
    const report = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, {}) as unknown as Report;
    const digest = (suite: typeof c.S1) => parentTestSuiteDigest(suite);
    expect(report.view).toBe('rows');
    expect(report.horizon).toBe(new Date(at(90)).toISOString());
    expect(report.units.map((unit) => unit.key)).toEqual([digest(c.S1), digest(c.S2), digest(c.S3), digest(c.S4)]);
    expect(report.total).toBe(4);
    expect(report.listDigest).toBe(createHash('sha256').update(report.units.map((unit) => unit.key).join('\n')).digest('hex'));
    const [one, two, three, four] = report.units;
    // A resume counted S1 again: one unit, first counted in the first run.
    expect(one).toMatchObject({ firstRunId: c.runA, runIds: [c.runA, c.runB], counts: { counted: 2, later: 1 },
      outcome: 'passed-later', outcomeRunId: c.runB, firstCountAt: new Date(at(1)).toISOString() });
    expect(two).toMatchObject({ outcome: 'never-passed', outcomeRunId: null, counts: { observations: 3, subjects: 3, counted: 1, later: 0 } });
    expect(three).toMatchObject({ outcome: 'revised', outcomeRunId: c.runC, revisedBy: digest(c.S3b), relatedSuites: [digest(c.S3b)] });
    expect(four).toMatchObject({ outcome: 'passed-later', outcomeRunId: c.runE, firstRunId: c.runD });
    // Same run, same failing set: one cluster; another failing set is another.
    expect(one!.cluster).toBe(two!.cluster);
    expect(three!.cluster).not.toBe(one!.cluster);
    // The revision the recorder stamped at launch, never today's.
    expect(report.legacy).toEqual([{ runId: c.legacy, revision: executionProvenance().revision, statsCount: 1, countedEntries: 0 }]);
    expect(report.unreadable).toEqual([{ runId: c.gone, reason: 'run trace was never written' }]);
    expect(report.malformedEntries).toBe(1);
  });

  it('carries no text in rows, bounded and marked text in review, and one whole unit by digest', async () => {
    const c = corpus();
    const rows = JSON.stringify(await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { view: 'rows' }));
    for (const text of ['REQ-ONE', 'TASK-TEXT', 'EXCERPT-TEXT', 'GOAL-TEXT', 'OUTPUT-TEXT', 'vitest', 'Tracheid', 'Methane']) expect(rows).not.toContain(text);
    const review = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { view: 'review', limit: 1 });
    expect(review['caveat']).toMatch(/UNTRUSTED/);
    expect((review['units'] as Record<string, unknown>[])[0]).toMatchObject({
      requirement: 'REQ-ONE the parser keeps escapes', goal: 'GOAL-TEXT repair the module', failingChild: 'Methane', owner: { name: 'Tracheid', tier: 2 },
      observations: [expect.objectContaining({ status: 'failed', sameSet: true }), expect.anything(), expect.anything()],
    });
    expect(JSON.stringify(review)).not.toContain('vitest');
    const unit = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { suiteDigest: parentTestSuiteDigest(c.S3).slice(0, 16) });
    expect(unit['view']).toBe('unit');
    expect(unit['unit']).toMatchObject({ suite: c.S3, suiteVerified: true, outcome: 'revised',
      counted: [expect.objectContaining({ runId: c.runA, excerpt: '[{"name":"columns","failure":"another failing set"}]' })] });
    await expect(suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { suiteDigest: 'f'.repeat(16) })).rejects.toMatchObject({ status: 404 });
    await expect(suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { suiteDigest: 'f'.repeat(16), view: 'rows' })).rejects.toBeInstanceOf(ProjectHttpError);
  });

  it('pages a window under one list digest, and refuses a window that cannot be answered', async () => {
    const c = corpus();
    const whole = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, {}) as unknown as Report;
    const first = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { limit: 2 }) as unknown as Report;
    const second = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { limit: 2, offset: 2 }) as unknown as Report;
    expect([first.listDigest, second.listDigest]).toEqual([whole.listDigest, whole.listDigest]);
    expect([...first.units, ...second.units].map((unit) => unit.key)).toEqual(whole.units.map((unit) => unit.key));
    expect([first.nextOffset, second.nextOffset]).toEqual([2, null]);
    // The window applies to the first count, never to a later one: S1 stays out though it was counted again at minute 11.
    const later = await suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { since: new Date(at(2)).toISOString(), until: new Date(at(31)).toISOString() }) as unknown as Report;
    expect(later.units.map((unit) => unit.key)).toEqual([parentTestSuiteDigest(c.S2), parentTestSuiteDigest(c.S3)]);
    await expect(suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { since: new Date(at(5)).toISOString(), until: new Date(at(5)).toISOString() })).rejects.toMatchObject({ status: 400 });
    await expect(suiteDisputeReport({ store: c.store, orgIds: c.orgIds }, { limit: 21 })).rejects.toMatchObject({ status: 400 });
    // An organisation not handed in is not read.
    const own = await suiteDisputeReport({ store: c.store, orgIds: [c.one.viewer.orgId] }, {}) as unknown as Report;
    expect(own.units.map((unit) => unit.key)).toEqual(whole.units.slice(0, 3).map((unit) => unit.key));
  });

  it('reads the record of a trace past the materialisation ceiling, and counts its unreadable result as missing evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: at(0) });
    const root = mkdtempSync(join(tmpdir(), 'atoma-suite-disputes-large-'));
    dirs.push(root);
    const f = projectRetrievalFixture(root);
    const suite = disputeSuite('REQ-LARGE');
    const runId = addDisputeRun(f, { status: 'partial', disputes: 1, entries: [countedFor(suite, at(1))], output: 'x'.repeat(MAX_TRACE_BYTES + 1024) });
    const file = join(projectRunHostLayout(root, f.viewer.orgId, f.project.projectId, runId).runsPath, `${runId}.json`);
    expect(statSync(file).size).toBeGreaterThan(MAX_TRACE_BYTES);
    const report = await suiteDisputeReport({ store: f.projects, orgIds: [f.viewer.orgId] }, {}) as unknown as Report;
    expect(report.units).toEqual([expect.objectContaining({ key: parentTestSuiteDigest(suite), firstRunId: runId, outcome: 'never-passed', evidenceUnreadable: 1 })]);
    expect(report.unreadable).toEqual([]);
  }, 60_000);

  it('answers the same through the projects CLI, read-only', () => {
    const c = corpus();
    vi.useRealTimers();
    const before = statSync(c.one.dbPath).mtimeMs;
    const cli = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/projects.ts'), 'disputes', '--db', c.one.dbPath], {
      encoding: 'utf8', env: { ...process.env, ATOMA_DB_PATH: c.one.dbPath },
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(statSync(c.one.dbPath).mtimeMs).toBe(before);
    const printed = JSON.parse(cli.stdout) as Report;
    expect(printed.units.map((unit) => [unit.key, unit.outcome])).toEqual([
      [parentTestSuiteDigest(c.S1), 'passed-later'], [parentTestSuiteDigest(c.S2), 'never-passed'],
      [parentTestSuiteDigest(c.S3), 'revised'], [parentTestSuiteDigest(c.S4), 'passed-later'],
    ]);
    const refused = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/projects.ts'), 'disputes', '--db', c.one.dbPath, '--limit', '99'], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/limit/);
  }, 60_000);
});
