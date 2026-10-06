import { describe, expect, it } from 'vitest';
import type { VizEvent, VizRun } from '../src/viz/client/types.js';
import { buildRunActivity } from '../src/viz/client-gl/run-activity.js';
import { runCost, runUsageValue } from '../src/viz/client/run-utils.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { buildActivityDiff, wrapDiffLine } from '../src/viz/client-gl/run-diff.js';

const event = (id: string, values: Partial<VizEvent>): VizEvent => ({ id, ts: Date.now(), kind: 'tool', ...values });
const run = (events: VizEvent[], values: Partial<VizRun> = {}): VizRun => ({ id: 'run', label: 'Build an app',
  startedAt: new Date().toISOString(), events, ...values });

describe('recorded run progress', () => {
  it('keeps unreported live usage pending and known costs provisional', () => {
    const live = run([event('start', { kind: 'llm-start', llmEventId: 'call', role: 'execute' })],
      { totals: { calls: 0, costUsd: 0 } });
    const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
    expect(runUsageValue(live, runCost(0), t)).toBe(t('summary.usagePending'));
    live.totals = { calls: 1, costUsd: 0.15 };
    expect(runUsageValue(live, runCost(0.15), t)).toBe(t('summary.usagePartial', { value: '$0.15' }));
    expect(runCost(0.001)).toBe('<$0.01');
  });
  it('counts only confirmed file writes and preserves failed and unknown attempts', () => {
    const events = [
      event('read', { name: 'read_file', args: { path: 'read.txt' }, result: { ok: true } }),
      event('write', { name: 'write_file', args: { path: 'app.js', content: 'one' }, result: { ok: true } }),
      event('failure', { name: 'edit_file', args: { path: 'app.js', old_string: 'one', new_string: 'two' }, error: 'no match' }),
      event('edit', { name: 'edit_file', args: { path: 'app.js', old_string: 'one', new_string: 'two' }, result: '{"ok":true,"replacements":1}' }),
      event('historical', { name: 'write_file', args: { path: 'unknown.txt' } }),
      event('shell', { name: 'run_shell', args: { command: 'touch shell.txt' }, result: { ok: true } }),
      event('prose', { kind: 'llm', response: 'Created invented.txt', role: 'execute' }),
    ];
    const before = JSON.stringify(events);
    const result = buildRunActivity(run(events));
    expect(result.touched).toBe(1);
    expect(result.files.map(file => file.path)).toEqual(['unknown.txt', 'app.js']);
    expect(result.files[1]).toMatchObject({ confirmed: 2, failed: 1 });
    expect(result.files[1]!.changes.map(change => change.status)).toEqual(['confirmed', 'failed', 'confirmed']);
    expect(result.files[0]!.changes[0]!.status).toBe('unknown');
    expect(JSON.stringify(events)).toBe(before);
  });

  it('joins nested branch work to its phase, without treating closure as approval', () => {
    const result = buildRunActivity(run([
      event('p1', { kind: 'branch', op: 'start', branchId: 'phase', label: 'Build the counter' }),
      event('p2', { kind: 'branch', op: 'start', branchId: 'child', parentBranchId: 'phase', label: 'Write the page' }),
      event('tool', { name: 'write_file', branchId: 'child', args: { path: 'index.html' }, result: { ok: true } }),
      event('review', { kind: 'llm', branchId: 'phase', role: 'validate-result', response: '{"approved":false}' }),
      event('end', { kind: 'branch', op: 'end', branchId: 'phase' }),
    ]));
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]).toMatchObject({ label: 'Build the counter', ended: true, stages: ['execute', 'validate-result'] });
    expect([...result.phases[0]!.files]).toEqual(['index.html']);
    expect(result.phases[0]).not.toHaveProperty('approved');
    expect(result.steps).toMatchObject([
      { id: 'plan', recorded: false, detail: 'unseen' },
      { id: 'execute', detail: 'files', count: 1 },
      { id: 'validate-result', detail: 'reviews', count: 1 },
    ]);
    // The rejected review still counts as a review, never as a successful check.
    expect(result.steps[2]).not.toHaveProperty('approved');
  });

  it('shows simultaneous active roles and clears them once the run has stopped', () => {
    const events = [
      event('start1', { kind: 'llm-start', llmEventId: 'call1', role: 'execute', branchId: 'one' }),
      event('start2', { kind: 'llm-start', llmEventId: 'call2', role: 'validate-result', branchId: 'two' }),
    ];
    expect(buildRunActivity(run(events)).activeStages).toEqual(['execute', 'validate-result']);
    expect(buildRunActivity(run(events)).steps.filter(step => step.active).map(step => step.detail)).toEqual(['active', 'active']);
    expect(buildRunActivity(run(events, { endedAt: new Date().toISOString() })).activeStages).toEqual([]);
  });

  it('marks merged and recovered edits', () => {
    const result = buildRunActivity(run([
      event('merge', { name: 'write_file', args: { path: 'manifest.json' }, result: { ok: true, merged: { kept: 2 } } }),
      event('recover', { name: 'edit_file', args: { path: 'app.js' }, result: { ok: true, recoveredFromDoubleEscape: true } }),
    ]));
    expect(result.files.every(file => file.changes[0]!.transformed)).toBe(true);

  });
});

describe('split excerpt diff', () => {
  it('aligns unchanged anchors after unequal replacement blocks and retains source line numbers', () => {
    const diff = buildActivityDiff(event('edit', { name: 'edit_file', args: {
      old_string: 'start\nold\nend\ntail', new_string: 'start\nnew\ninserted\nend\ntail',
    } }));
    expect(diff.rows.map(row => [row.before?.text ?? null, row.after?.text ?? null])).toEqual([
      ['start', 'start'], ['old', 'new'], [null, 'inserted'], ['end', 'end'], ['tail', 'tail'],
    ]);
    expect(diff.rows[3]).toEqual({ before: { text: 'end', line: 3, kind: 'context' },
      after: { text: 'end', line: 4, kind: 'context' } });
    expect(diff.rows[1]!.before!.kind).toBe('delete');
    expect(diff.rows[1]!.after!.kind).toBe('insert');
  });

  it('distinguishes an unknown overwritten file from an explicitly empty before span', () => {
    const write = buildActivityDiff(event('write', { name: 'write_file', args: { content: 'new' } }));
    expect(write.beforeAvailable).toBe(false);
    expect(write.rows[0]).toEqual({ before: null, after: { text: 'new', line: 1, kind: 'context' } });
    const edit = buildActivityDiff(event('edit', { name: 'edit_file', args: { old_string: '', new_string: 'new' } }));
    expect(edit.beforeAvailable).toBe(true);
    expect(edit.rows[0]!.after!.kind).toBe('insert');
    expect(buildActivityDiff(event('missing', { name: 'edit_file', args: {} })).rows).toEqual([]);
  });

  it('keeps all 100,000 changed lines without allocating a file-size-squared alignment matrix', () => {
    const before = 'old\n'.repeat(100_000) + 'old final line';
    const after = 'new\n'.repeat(100_000) + 'new final line';
    const diff = buildActivityDiff(event('huge', { name: 'edit_file', args: { old_string: before, new_string: after } }));
    expect(diff.rows).toHaveLength(100_001);
    expect(diff.rows.map(row => row.before?.text).join('\n')).toBe(before);
    expect(diff.rows.map(row => row.after?.text).join('\n')).toBe(after);
    expect(diff.rows.at(-1)?.after?.line).toBe(100_001);
  });

  it('preserves repeated context and late edits beyond the old line and character caps', () => {
    const shared = Array.from({ length: 600 }, (_, i) => `line ${i}: ${'context '.repeat(8)}`);
    const before = [...shared, 'old', 'repeat', 'repeat', 'tail'].join('\n');
    const after = [...shared, 'new', 'extra', 'repeat', 'repeat', 'tail'].join('\n');
    const diff = buildActivityDiff(event('long', { name: 'edit_file', args: { old_string: before, new_string: after } }));
    expect(diff.rows.filter(row => row.before).map(row => row.before!.text).join('\n')).toBe(before);
    expect(diff.rows.filter(row => row.after).map(row => row.after!.text).join('\n')).toBe(after);
    expect(diff.rows.at(-1)).toMatchObject({ before: { text: 'tail', line: 604, kind: 'context' },
      after: { text: 'tail', line: 605, kind: 'context' } });
    expect(diff.rows.filter(row => row.before?.kind === 'delete')).toHaveLength(1);
    expect(diff.rows.filter(row => row.after?.kind === 'insert')).toHaveLength(2);
  });

  it('wraps a complete long line with bounded measurement inputs and preserves tabs and Unicode', () => {
    let maxMeasured = 0;
    const text = '\tconst message = "✅ complete";' + 'x'.repeat(100_000);
    const lines = wrapDiffLine(text, 80, value => {
      maxMeasured = Math.max(maxMeasured, value.length);
      return Array.from(value).length;
    });
    expect(lines.join('')).toBe('    ' + text.slice(1));
    expect(lines.every(line => Array.from(line).length <= 80)).toBe(true);
    expect(maxMeasured).toBeLessThan(200);
  });
});
