import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePreviousResults } from '../src/contracts/previousRunResults.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { projectRunHostLayout } from '../src/projects/coordinator.js';
import { previousResultsFor } from '../src/projects/previousResults.js';
import { digestRun } from '../src/supervisor/digest.js';
import { TraceRecorder, type VizRun } from '../src/viz/trace.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { addDisputeRun, countedFor, disputeSuite, laterFor } from './helpers/suiteDisputes.js';

/**
 * WHAT NO MODEL IN A RUN READS (2026-10-17): the suite-dispute record is a top-level
 * trace member because every EVENT reaches the analyst's events file, and a
 * `result` field would go up the tree and into later runs. With the member
 * present, the readers that feed models read exactly what they read without
 * it. (The supervise loop's own result, which checkpoints persist, is held
 * apart in tests/parent-suite-dispute.test.ts, and the coordinator's
 * delivered/failed read in tests/project-coordinator.test.ts.)
 */

const dirs: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SUITE = disputeSuite('REQ-HIDDEN the parser keeps escapes', 'SOURCE-MARKER');

/** The same run twice, through the real recorder: once with the record, once without. */
function twinTraces(): { readonly withRecord: VizRun; readonly without: VizRun; readonly ids: string[] } {
  const runs = mkdtempSync(join(tmpdir(), 'atoma-suite-dispute-absence-'));
  dirs.push(runs);
  const counted = countedFor(SUITE, 1_000);
  const entries = [counted, laterFor(counted, 2_000, 'failed')];
  const write = (runId: string, record: boolean): VizRun => {
    const recorder = new TraceRecorder(runs);
    recorder.beginRun({ description: 'Repair the parser' }, 'parser', { runId });
    recorder.record({ id: 'llm-1', ts: 10, kind: 'llm', role: 'execute', model: 'm', systemPrompt: 's', userContent: 'u', response: '{}',
      stopReason: 'end_turn', durationMs: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0.01 });
    if (record) for (const entry of entries) recorder.recordSuiteDispute(entry);
    recorder.endRun({ result: { summary: 'refused', output: 'answer', producedBy: { tier: 3, name: 'Meristem', viaFallback: false }, refusal: 'suite failed' } });
    return JSON.parse(readFileSync(join(runs, `${runId}.json`), 'utf8')) as VizRun;
  };
  const withRecord = write('twin', true);
  const without = { ...write('twin', false), startedAt: withRecord.startedAt, endedAt: withRecord.endedAt, durationMs: withRecord.durationMs };
  expect(withRecord.suiteDisputes).toHaveLength(2);
  return { withRecord, without, ids: entries.map((entry) => entry.id) };
}

describe('the suite-dispute record reaches no model-read path', () => {
  it('leaves the analyst digest and its events file as they are', () => {
    const { withRecord, without, ids } = twinTraces();
    const recorded = digestRun(withRecord);
    expect(recorded).toEqual(digestRun(without));
    const read = JSON.stringify(recorded);
    for (const marker of [...ids, 'SOURCE-MARKER', 'REQ-HIDDEN', 'EXCERPT-TEXT', 'suiteDisputes']) expect(read).not.toContain(marker);
  });

  it('leaves the previous-results context of the next run as it is', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-suite-dispute-previous-'));
    dirs.push(root);
    const f = projectRetrievalFixture(root);
    const counted = countedFor(SUITE, 1_000);
    const disputed = addDisputeRun(f, { status: 'delivered', disputes: 1, output: 'The answer is 4.', entries: [counted] });
    const quiet = addDisputeRun(f, { status: 'delivered', disputes: 0, output: 'The answer is 4.' });
    const text = { version: 1 as const, files: [], totalBytes: 0, source: 'workspace' as const, delivery: 'text' as const };
    for (const runId of [disputed, quiet]) f.projects.saveArtifactManifest(f.viewer.orgId, runId, text);
    const context = (runId: string) => previousResultsFor(f.projects, f.projects.getProjectRun(f.viewer.orgId, runId))!;
    const recorded = context(disputed);
    expect(decodePreviousResults(recorded)?.runs).toEqual([expect.objectContaining({ runId: disputed, output: 'The answer is 4.', unavailable: false })]);
    expect(recorded.replaceAll(disputed, quiet)).toBe(context(quiet));
    for (const marker of [counted.id, 'SOURCE-MARKER', 'REQ-HIDDEN']) expect(recorded).not.toContain(marker);
    // The record really is in the trace this context was read from.
    const trace = readFileSync(join(projectRunHostLayout(root, f.viewer.orgId, f.project.projectId, disputed).runsPath, `${disputed}.json`), 'utf8');
    expect(trace).toContain(counted.id);
  });
});
