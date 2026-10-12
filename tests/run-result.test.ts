import { describe, expect, it } from 'vitest';
import { latestDeliveredResult, readableBlocks, resultFileUrl, resultNarrative, resultSections, resultText, splitSummary } from '../src/viz/client-gl/run-result.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';
import type { VizProjectRun, VizRun } from '../src/viz/client/types.js';

const run: VizRun = { id: 'trace', label: 'Proof', startedAt: '2026-10-02T10:00:00Z', events: [],
  result: { output: { answer: '15 states\nA valid witness.', count: 15 }, summary: 'Earlier phases disagreed.' } };
const row: VizProjectRun = { projectRunId: 'row', traceId: run.id, projectId: 'project', goal: 'Proof', status: 'delivered',
  costUsd: 0, durationS: 1, error: null, createdAt: run.startedAt, endedAt: run.startedAt,
  publication: { status: 'published', repositoryUrl: 'https://github.com/mgtf/proof', commitSha: 'a'.repeat(40) } };

describe('final result presentation', () => {
  it('leads a summary with what was done and keeps its evidence block apart', () => {
    expect(splitSummary('Built the tracker.\n== GROUND TRUTH ==\nnode --test: 8 passed\n== GROUND TRUTH ==\nsha256 abc'))
      .toEqual({ lead: 'Built the tracker.', checks: 'node --test: 8 passed\nsha256 abc' });
    expect(splitSummary('No evidence block.')).toEqual({ lead: 'No evidence block.', checks: null });
    // Only the marker on its own line splits: a mention inside prose does not.
    expect(splitSummary('Explains the == GROUND TRUTH == convention.').checks).toBeNull();
    expect(splitSummary('Done.\n== GROUND TRUTH ==\n')).toEqual({ lead: 'Done.', checks: null });
  });
  it('reads a Markdown answer as headings and plain paragraphs, keeping code verbatim', () => {
    expect(readableBlocks([
      '## Timetable', '', '| Task | **Start** |', '|---|---:|', '| A | 0 |', '', '- **Bold** item with `code`',
      '  - nested', '1. kept as written', '', '```', '  **not emphasis** | x |', '```', '---', 'Last.',
    ].join('\n'))).toEqual([
      { kind: 'heading', text: 'Timetable' },
      { kind: 'text', text: 'Task  ·  Start\nA  ·  0' },
      { kind: 'text', text: '• Bold item with code\n  • nested\n1. kept as written' },
      { kind: 'text', text: '  **not emphasis** | x |' },
      { kind: 'text', text: 'Last.' },
    ]);
  });
  it('reads only the final output, preserves paragraphs and exposes every structured field', () => {
    expect(resultSections(run)).toEqual([{ title: 'answer', text: '15 states\nA valid witness.' }, { title: 'count', text: '15' }]);
    expect(JSON.parse(resultText(run)!)).toEqual(run.result!.output);
    expect(resultText(run)).not.toContain('Earlier phases');
    expect(resultText({ ...run, result: { summary: 'A summary is not an answer.' } })).toBeNull();
  });
  it.each([false, 0, '', ['a', { b: 1 }]])('keeps valid output %j', output => {
    expect(resultText({ ...run, result: { output } })).toBe(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
  });
  it('copies a concatenated text answer as text, nested parts included', () => {
    const output = [['First part.', ''], ['Second part.'], 'Third part.'];
    expect(resultText({ ...run, result: { output } })).toBe('First part.\n\nSecond part.\n\nThird part.');
    expect(resultNarrative({ ...run, result: { output } }).map(section => section.text)).toEqual(['First part.', 'Second part.', 'Third part.']);
  });
  it('preserves the complete answer for export, even when the GPU preview is bounded', () => {
    const output = 'a'.repeat(80000);
    expect(resultText({ ...run, result: { output } })).toHaveLength(80000);
  });
  it('presents prose without turning file claims and recorded probes into the answer', () => {
    const output = { files: ['plate.svg'], probes: [{ cmd: 'python3 check.py', exitCode: 0 }],
      answer: 'The coastal illustration is ready.', conclusion: 'Labels fit inside the canvas.' };
    const drawing = { ...run, result: { output } };
    expect(resultNarrative(drawing)).toEqual([
      { title: 'answer', text: output.answer }, { title: 'conclusion', text: output.conclusion },
    ]);
    expect(JSON.parse(resultText(drawing)!)).toEqual(output);
    expect(resultSections(drawing).map(section => section.title)).toEqual(Object.keys(output));
    expect(resultNarrative({ ...run, result: { output: 0 } })).toEqual([]);
  });
  it('links to an immutable published revision and encodes each path component', () => {
    expect(resultFileUrl(row, 'my report/a#b.svg')).toBe(`https://github.com/mgtf/proof/blob/${'a'.repeat(40)}/my%20report/a%23b.svg`);
    for (const path of ['../secret', '/secret', 'a/../secret', 'a\\b']) expect(resultFileUrl(row, path)).toBeNull();
    expect(resultFileUrl({ ...row, publication: null }, 'a.svg')).toBeNull();
    expect(resultFileUrl({ ...row, publication: { ...row.publication!, commitSha: null } }, 'a.svg')).toBeNull();
    expect(resultFileUrl({ ...row, publication: { ...row.publication!, repositoryUrl: 'https://evil.test/mgtf/proof' } }, 'a.svg')).toBeNull();
  });
  it('selects the newest delivered project result without promoting a newer failure or comparison', () => {
    const newer = { ...row, projectRunId: 'newer', createdAt: '2026-10-03T00:00:00Z' };
    expect(latestDeliveredResult([row, { ...newer, status: 'partial' }, { ...newer, rerunOf: 'row' }])).toBe(row);
    expect(latestDeliveredResult([row, newer])).toBe(newer);
  });
  it('opens a historical result inside the project and resets it when changing subjects', () => {
    const state = useGpuStore.getState();
    state.setView('projects'); state.selectProject('project'); state.selectResult('trace');
    expect(useGpuStore.getState()).toMatchObject({ view: 'projects', resultRunId: 'trace' });
    state.toggleResultDetails();
    expect(useGpuStore.getState().resultDetailsOpen).toBe(true);
    state.selectProject('other');
    expect(useGpuStore.getState().resultRunId).toBeNull();
    expect(useGpuStore.getState().resultDetailsOpen).toBe(false);
    state.selectResult('trace'); state.toggleResultDetails(); state.selectResult('other-trace');
    expect(useGpuStore.getState().resultDetailsOpen).toBe(false);
    state.selectResult('trace'); state.selectRun('other-run');
    expect(useGpuStore.getState().resultRunId).toBeNull();
  });
});
