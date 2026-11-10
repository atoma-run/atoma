import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWitReport, witReceipt } from '../src/viz/witReport.js';
import { witReportSchema } from '../src/contracts/witReport.js';

const run = { hasError: false, id: 'run', label: 'Report', startedAt: '2026-11-10T00:00:00Z' };
const event = { id: 'tool-1', kind: 'tool', ts: 1, durationMs: 20, name: 'run_shell',
  args: { command: 'wit', args: ['check', 'report.md'] }, result: { exitCode: 0, stdout: 'ok' } };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function trace(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'wit-report-')); roots.push(root);
  const path = join(root, 'run.json'); writeFileSync(path, JSON.stringify({ ...run, events })); return path;
}
describe('Wit receipts', () => {
  it('separates reproduction checks, generation, failures and missing outcomes', () => {
    expect(witReceipt(event, run)?.status).toBe('passed');
    expect(witReceipt({ ...event, args: { command: 'wit', args: ['generate', 'report.md'] } }, run)?.status).toBe('generated');
    expect(witReceipt({ ...event, result: { exitCode: 1, stderr: 'UNAVAILABLE' } }, run)).toMatchObject({ status: 'failed', output: 'UNAVAILABLE' });
    expect(witReceipt({ ...event, error: 'Timeout' }, run)?.status).toBe('error');
    expect(witReceipt({ ...event, result: { stdout: 'PASS exitCode: 0' } }, run)?.status).toBe('unknown');
  });
  it('recognizes both direct shell shapes and probes, never shell composition or prose', () => {
    for (const name of ['run_shell', 'record_probe']) expect(witReceipt({ ...event, name, args: { cmd: 'wit check "my report.md"' } }, run)?.mode).toBe('check');
    for (const cmd of ['echo wit check report.md', 'wit check a.md; echo ok', 'wit check $(echo a.md)', 'node check.mjs']) {
      expect(witReceipt({ ...event, args: { ...event.args, cmd } }, run)).toBeNull();
    }
    expect(witReceipt({ ...event, name: 'read_file' }, run)).toBeNull();
  });
  it('preserves failed output as data and labels excerpts', () => {
    expect(witReceipt({ ...event, result: { exitCode: 1, stdout: '<script>'.repeat(500) } }, run)).toMatchObject({ status: 'failed', outputTruncated: true });
  });
  it('reads immutable traces, reports omissions and unreadable runs, and retains cursor', () => {
    const path = trace([...Array.from({ length: 2001 }, () => ({ kind: 'other' })), event]);
    const report = readWitReport({ runs: [run, { ...run, id: 'missing' }], total: 4, nextBefore: 'next' }, id => id === 'run' ? path : null);
    expect(witReportSchema.parse(report)).toMatchObject({ runsScanned: 2, unreadableRuns: 1, omittedEvents: 2, nextBefore: 'next', receipts: [{ status: 'passed' }] });
  });
  it('does not turn corrupt traces or failed authorization into success', () => {
    const path = trace([]); writeFileSync(path, '{');
    expect(readWitReport({ runs: [run], total: 1, nextBefore: null }, () => path).unreadableRuns).toBe(1);
    expect(() => readWitReport({ runs: [run], total: 1, nextBefore: null }, () => { throw new Error('audit unavailable'); })).toThrow('audit unavailable');
  });
  it('bounds receipt count and keeps newest receipts', () => {
    const path = trace(Array.from({ length: 55 }, (_, ts) => ({ ...event, ts })));
    const report = readWitReport({ runs: [run], total: 1, nextBefore: null }, () => path);
    expect(report.receipts).toHaveLength(50); expect(report.omittedEvents).toBe(5); expect(report.receipts[0]?.at).toBe(54);
  });
});
