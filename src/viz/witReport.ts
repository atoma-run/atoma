import { withTraceDocument } from '../contracts/traceFields.js';
import type { WitReceipt, WitReport } from '../contracts/witReport.js';
import type { VizRunIndexPage } from './trace.js';

const MAX_EVENTS = 2_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_OUTPUT = 2_000;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Direct invocations only. Never interpret shell programs, prose or echoed commands. */
export function witReceipt(value: unknown, run: { id: string; projectId?: string; label: string }): WitReceipt | null {
  const event = object(value);
  if (event?.['kind'] !== 'tool') return null;
  const args = object(event['args']);
  if (event['name'] !== 'run_shell' && event['name'] !== 'record_probe') return null;
  let command: string;
  let mode: 'check' | 'generate';
  // cmd takes precedence over command/args in the actual tool.
  const line = typeof args?.['cmd'] === 'string' && args['cmd'].trim() ? args['cmd']
    : typeof args?.['command'] === 'string' && (!Array.isArray(args['args']) || !args['args'].length) ? args['command'] : null;
  if (line !== null) {
    const match = /^wit\s+(check|generate)\s+[^;&|$`<>\\\r\n]+$/.exec(line.trim());
    if (!match) return null;
    mode = match[1] as 'check' | 'generate';
    command = line;
  } else if (event['name'] === 'run_shell' && args?.['command'] === 'wit' && Array.isArray(args['args']) && args['args'].every(x => typeof x === 'string')) {
    const words = args['args'];
    if (words[0] !== 'check' && words[0] !== 'generate') return null;
    mode = words[0];
    command = `wit ${words.map(x => JSON.stringify(x)).join(' ')}`;
  } else return null;
  const result = object(event['result']);
  const exitCode = typeof result?.['exitCode'] === 'number' && Number.isInteger(result['exitCode']) ? result['exitCode'] : null;
  const error = typeof event['error'] === 'string' ? event['error'] : typeof result?.['error'] === 'string' ? result['error'] : '';
  const output = [result?.['stdout'], result?.['stderr'], error].filter(x => typeof x === 'string' && x).join('\n');
  const actor = object(event['actor']);
  return {
    runId: run.id, projectId: run.projectId ?? null, runLabel: run.label,
    eventId: typeof event['id'] === 'string' ? event['id'] : '',
    at: typeof event['ts'] === 'number' && Number.isFinite(event['ts']) ? event['ts'] : 0,
    actor: typeof actor?.['name'] === 'string' ? actor['name'].slice(0, 256) : null,
    mode, command: command.slice(0, 2_000),
    status: error ? 'error' : exitCode === null ? 'unknown' : exitCode !== 0 ? 'failed' : mode === 'check' ? 'passed' : 'generated',
    exitCode, durationMs: typeof event['durationMs'] === 'number' && Number.isFinite(event['durationMs']) ? event['durationMs'] : 0,
    output: output.slice(0, MAX_OUTPUT), outputTruncated: output.length > MAX_OUTPUT,
  };
}

/** Bounded historical projection: no execution and no acceptance or trust changes. */
export function readWitReport(page: VizRunIndexPage, resolve: (id: string) => string | null): WitReport {
  const report: WitReport = { generatedAt: new Date().toISOString(), runsScanned: page.runs.length,
    totalRuns: page.total, unreadableRuns: 0, omittedEvents: 0, receipts: [], nextBefore: page.nextBefore };
  for (const run of page.runs) {
    // Authorization and cross-org audit failures must propagate, never become empty data.
    const file = resolve(run.id);
    if (!file) { report.unreadableRuns++; continue; }
    try {
      const projection = withTraceDocument(file, document => {
        if (!document.events) throw new Error('Missing events');
        let omitted = Math.max(0, document.events.length - MAX_EVENTS);
        const receipts: WitReceipt[] = [];
        for (const range of document.events.slice(-MAX_EVENTS).reverse()) {
          if (range.end - range.start > MAX_EVENT_BYTES) { omitted++; continue; }
          const receipt = witReceipt(document.read(range), run);
          if (receipt) {
            if (receipts.length < 50) receipts.push(receipt);
            else omitted++;
          }
        }
        return { omitted, receipts };
      });
      report.omittedEvents += projection.omitted;
      report.receipts.push(...projection.receipts);
    } catch { report.unreadableRuns++; }
  }
  report.receipts.sort((a, b) => b.at - a.at);
  return report;
}
