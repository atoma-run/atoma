import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  MAX_TRACE_BYTES, projectTraceDocument, readTraceTopLevelFields,
  traceDocumentChunks, withTraceDocument,
} from '../src/contracts/traceFields.js';
import { runTraceFile } from '../src/mcp/readers.js';
import { summarizeTraceFileWithCost } from '../src/viz/runIndex.js';

const roots: string[] = [];
function file(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-trace-document-'));
  roots.push(root);
  return join(root, 'trace.json');
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function streamed(path: string, after?: number): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of traceDocumentChunks(path, after)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

it('preserves Unicode, escaped structure, duplicate members and delta resync', async () => {
  const path = file();
  const event = { id: 'e1', body: 'α😀\\"[]{}'.repeat(10_000) };
  writeFileSync(path, `{"events":[0],"id":"old","events":[${JSON.stringify(event)},null,3],"id":"new"}`);
  const full = JSON.parse(await streamed(path)) as unknown;
  expect(full).toEqual({ id: 'new', events: [event, null, 3] });
  expect(JSON.parse(await streamed(path, 1))).toEqual({ id: 'new', events: [null, 3], eventsFrom: 1, eventsTotal: 3 });
  expect(JSON.parse(await streamed(path, 4))).toEqual({ id: 'new', events: [event, null, 3], eventsFrom: 0, eventsTotal: 3 });
  expect(projectTraceDocument(path, (_name, read) => read(), read => read())).toEqual({ run: full, totalEvents: 3 });
});

it('keeps one descriptor across an atomic recorder persist', () => {
  const path = file();
  writeFileSync(path, '{"id":"old","events":[{"id":"old-event"}]}');
  withTraceDocument(path, document => {
    writeFileSync(path + '.tmp', '{"id":"new","events":[]}');
    renameSync(path + '.tmp', path);
    expect(document.read(document.fields.get('id')!)).toBe('old');
    expect(document.read(document.events![0]!)).toEqual({ id: 'old-event' });
  });
});

it('refuses symlinks, torn event arrays and trailing bytes', async () => {
  const path = file();
  for (const text of ['{"events":[{', '{"events":[1,]}', '{"events":[]} garbage']) {
    writeFileSync(path, text);
    expect(() => withTraceDocument(path, () => null)).toThrow();
    await expect(streamed(path, 0)).rejects.toThrow();
  }
  writeFileSync(path, '{"events":[]}');
  symlinkSync(path, path + '.link');
  await expect(streamed(path + '.link')).rejects.toThrow();
});

it('reads terminal state, list costs and MCP pages past 32 MiB without erasing evidence', () => {
  const path = file();
  const payload = 'x'.repeat(1024 * 1024);
  const events = Array.from({ length: 33 }, (_, i) => ({
    id: `e${i}`, kind: 'tool', ts: i, name: 'fetch_url', result: { body: payload },
  }));
  const trace = {
    id: 'large', label: 'Large trace', startedAt: '2026-10-13T00:00:00Z', endedAt: 'now',
    events: [...events, { id: 'llm', kind: 'llm', ts: 35, actor: { tier: 1 }, model: 'model', costUsd: 0.5 },
      { id: 'jev', kind: 'jev', ts: 36, requestCount: 2, answer: {}, costUsd: 0.01 }],
    result: { output: 'done', refusal: 'incomplete' }, totals: { calls: 1, costUsd: 0.5 },
  };
  const bytes = JSON.stringify(trace);
  expect(Buffer.byteLength(bytes)).toBeGreaterThan(MAX_TRACE_BYTES);
  writeFileSync(path, bytes);
  expect(readTraceTopLevelFields(path, { values: ['id', 'endedAt'], shapes: ['result', 'error'] }))
    .toEqual({ values: { id: 'large', endedAt: 'now' }, shapes: { id: 'string', endedAt: 'string', result: 'object' } });
  const summary = summarizeTraceFileWithCost(path);
  expect(summary?.entry).toMatchObject({ id: 'large', landed: true, calls: 1, jevCalls: 2 });
  expect(summary?.costBreakdown.l1.costUsd).toBe(0.5);
  expect(runTraceFile(path, { offset: 32, limit: 2 })).toMatchObject({
    totalEvents: 35, eventsFrom: 32, nextOffset: 34, events: [{ id: 'e32' }, { id: 'llm' }],
  });
  expect(runTraceFile(path, { offset: 34 })).toMatchObject({ nextOffset: null, events: [{ id: 'jev' }] });
  expect(runTraceFile(path, { section: 'metadata' })).toMatchObject({ text: expect.stringContaining('incomplete') });
  expect(runTraceFile(path, { section: 'event', eventId: 'e32', textLimit: 100 })).toMatchObject({
    text: expect.stringContaining('e32'), nextTextOffset: 100,
  });
});

it('bounds materialized selections independently of the complete file', () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ events: [{ body: 'x'.repeat(MAX_TRACE_BYTES + 1) }], id: 'large' }));
  expect(() => projectTraceDocument(path, (_name, read) => read(), read => read())).toThrow(/capture budget/);
  // Unselected payloads do not consume the capture budget.
  expect(projectTraceDocument(path, (_name, read) => read(), () => undefined))
    .toEqual({ run: { id: 'large', events: [] }, totalEvents: 1 });
});
