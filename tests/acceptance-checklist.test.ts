import { describe, expect, it } from 'vitest';
import {
  MAX_CHECKLIST_ITEMS,
  checklistPlanningLines,
  coverAcceptanceChecklist,
  httpCheckMatches,
  namedLayoutWidths,
  parseAcceptanceChecklist,
  renderChecklistCoverage,
} from '../src/contracts/acceptanceChecklist.js';
import { draftAcceptanceChecklist, CHECKLIST_ACTOR } from '../src/atoms/acceptanceChecklist.js';
import { makeCtx, jsonText } from './helpers.js';

describe('parseAcceptanceChecklist', () => {
  it('renumbers ids, normalises the method, and drops only the malformed items', () => {
    const list = parseAcceptanceChecklist({ items: [
      { id: 'x', behaviour: 'lists notes', check: { kind: 'http', method: 'get', path: '/api/notes' } },
      { behaviour: 'invented host', check: { kind: 'http', method: 'GET', path: 'http://evil.test/x' } },
      { behaviour: '', check: { kind: 'review' } },
      { behaviour: 'bad verb', check: { kind: 'http', method: 'FETCH', path: '/x' } },
      { behaviour: 'a page shows them', check: { kind: 'review' } },
      'prose',
    ] });
    expect(list).toEqual([
      { id: 'c1', behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } },
      { id: 'c2', behaviour: 'a page shows them', check: { kind: 'review' } },
    ]);
  });

  it('caps the list and treats anything unusable as empty', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ behaviour: `b${i}`, check: { kind: 'review' } }));
    expect(parseAcceptanceChecklist({ items: many })).toHaveLength(MAX_CHECKLIST_ITEMS);
    for (const raw of [null, 'x', { items: 'x' }, {}]) expect(parseAcceptanceChecklist(raw)).toEqual([]);
  });
});

describe('httpCheckMatches', () => {
  const check = (path: string, status?: number, method = 'GET') =>
    ({ kind: 'http' as const, method: method as 'GET', path, ...(status !== undefined ? { status } : {}) });

  it('matches method, path segments and any 2xx when no status is named', () => {
    expect(httpCheckMatches(check('/api/notes'), { method: 'get', path: '/api/notes', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes/', status: 201 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes?limit=2', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes'), { method: 'POST', path: '/api/notes', status: 201 })).toBe(false);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes', status: 404 })).toBe(false);
    expect(httpCheckMatches(check('/api/notes'), { method: 'GET', path: '/api/notes/1', status: 200 })).toBe(false);
  });

  it('matches a named status exactly, :name segments, encoded segments, and a named query exactly', () => {
    expect(httpCheckMatches(check('/api/notes/:id', 404), { method: 'GET', path: '/api/notes/zzz', status: 404 })).toBe(true);
    expect(httpCheckMatches(check('/api/notes/:id', 404), { method: 'GET', path: '/api/notes/zzz', status: 200 })).toBe(false);
    expect(httpCheckMatches(check('/api/notes/:id'), { method: 'GET', path: '/api/notes', status: 200 })).toBe(false);
    expect(httpCheckMatches(check('/files/a b'), { method: 'GET', path: '/files/a%20b', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/search?q=x'), { method: 'GET', path: '/search?q=x', status: 200 })).toBe(true);
    expect(httpCheckMatches(check('/search?q=x'), { method: 'GET', path: '/search?q=y', status: 200 })).toBe(false);
    expect(httpCheckMatches(check('/'), { method: 'GET', path: '/', status: 200 })).toBe(true);
  });
});

describe('coverage and rendering', () => {
  const list = parseAcceptanceChecklist({ items: [
    { behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } },
    { behaviour: 'unknown id is 404', check: { kind: 'http', method: 'GET', path: '/api/notes/:id', status: 404 } },
    { behaviour: 'a page shows the list', check: { kind: 'review' } },
  ] });

  it('covers from observations only, and never covers a review item', () => {
    const coverage = coverAcceptanceChecklist(list, [
      { eventId: 'e1', http: { method: 'GET', path: '/api/notes', status: 200 } },
      { eventId: 'e2', http: { method: 'GET', path: '/api/notes/7', status: 200 } },
    ]);
    expect(coverage.map((c) => [c.id, c.status, c.observationRefs])).toEqual([
      ['c1', 'covered', ['e1']], ['c2', 'uncovered', []], ['c3', 'review', []],
    ]);
    const block = renderChecklistCoverage(list, coverage);
    expect(block).toContain('- [OBSERVED] c1 lists notes (GET /api/notes → 2xx)');
    expect(block).toContain('- [NOT OBSERVED] c2 unknown id is 404 (GET /api/notes/:id → 404)');
    expect(block).toContain('- [REVIEW] c3 a page shows the list (judged by review)');
    expect(block).toMatch(/decides nothing by itself/);
    expect(renderChecklistCoverage([], [])).toBe('');
  });

  it('gives the planner one line per item', () => {
    expect(checklistPlanningLines(list)).toEqual([
      'c1: lists notes (GET /api/notes → 2xx)',
      'c2: unknown id is 404 (GET /api/notes/:id → 404)',
      'c3: a page shows the list (judged by review)',
    ]);
  });
});

describe('widths a criterion names', () => {
  // Runs a939374e and 7389feee (2026-09-27): "no horizontal scroll at 375 px"
  // was approved with every page laid out at 800x600.
  it.each([
    ['The layout has no horizontal scroll at 375 px wide and uses the extra width at 1280 px', [375, 1280]],
    ['usable at 375 and 1280 pixels wide', [375, 1280]],
    ['Works on a 320, 768 or 1024px screen', [320, 768, 1024]],
    ['a 375-pixel phone layout', [375]],
    ['No horizontal scroll at 375 px, and 375px again on mobile', [375]],
    ['It must be usable on a 375 px wide phone and on a 1280 px desktop', [375, 1280]],
    ['Readable at widths of 375 and 1280 px', [375, 1280]],
    ['The sidebar is 240px', []],
    ['The chart is 600 px wide on desktop', []],
    // Width then height: the width is the first number (adversarial review 2026-09-27).
    ['Usable on a 375 x 667 px phone', [375]],
    ['Crisp on a 1920×1080 px desktop', [1920]],
    ['on a 1366 x 768 px screen', [1366]],
    // Element sizes and thresholds are not screen widths.
    ['The main column has a max width of 720 px', []],
    ['Content is centred with max-width 1280px', []],
    ['The sidebar is fixed at 280 px wide', []],
    ['Uploaded images are downscaled to 1024 px', []],
    ['Thumbnails render at 256 px', []],
    ['The chart renders at 600 px tall', []],
    ['For the 3000 px wide banner image', []],
    ['Export PNG at 1080 px', []],
    ['Posts load on scroll at 400 px from the bottom', []],
    ['Below 768 px the nav collapses into a menu button', []],
    ['The viewport width of 1280 px shows two columns', [1280]],
    ['The estimate sits beside the steps at 1280 px on desktop', [1280]],
    ['A 100 px wide layout', []],
    ['A 5000 px wide screen', []],
    ['The desktop total shows 1500 EUR', []],
  ] as const)('%s → %j', (text, widths) => {
    expect(namedLayoutWidths(text)).toEqual(widths);
  });

  const list = parseAcceptanceChecklist({ items: [
    { behaviour: 'No horizontal scroll at 375 px wide, and the estimate sits beside the steps at 1280 px', check: { kind: 'review' } },
    { behaviour: 'the total is shown', check: { kind: 'review' } },
  ] });

  it('covers each width from the layouts this attempt observed', () => {
    const coverage = coverAcceptanceChecklist(list, [], [
      { eventId: 'b1', width: 800, ok: true },
      { eventId: 'b2', width: 1280, ok: false },
      { eventId: 'b3', width: 1280, ok: true },
    ]);
    expect(coverage[0]!.layouts).toEqual([
      { width: 375, status: 'not-laid-out', observationRefs: [] },
      { width: 1280, status: 'passed', observationRefs: ['b2', 'b3'] },
    ]);
    expect(coverage[1]!.layouts).toBeUndefined();
    const failed = coverAcceptanceChecklist(list, [], [{ eventId: 'b4', width: 375, ok: false }]);
    expect(failed[0]!.layouts?.[0]).toEqual({ width: 375, status: 'failed', observationRefs: ['b4'] });
    // A DRAFTED list of review items renders once one names a width: that item adds an observation.
    const block = renderChecklistCoverage(list, coverage);
    expect(block).toContain('(judged by review; 375 px: NOT LAID OUT, 1280 px: laid out, passed)');
    expect(block).toMatch(/or a stylesheet read, shows nothing about that width/);
  });

  it('tells the planner to lay the page out at each width', () => {
    expect(checklistPlanningLines(list)[0]).toBe(
      'c1: No horizontal scroll at 375 px wide, and the estimate sits beside the steps at 1280 px ' +
      '(judged by review; lay the page out at 375 px and 1280 px wide with validate_html viewport)');
    expect(checklistPlanningLines(list)[1]).toBe('c2: the total is shown (judged by review)');
  });
});

describe('draftAcceptanceChecklist', () => {
  it('makes one call on the cheapest tier under its own actor and parses the answer', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ items: [{ behaviour: 'lists notes', check: { kind: 'http', method: 'GET', path: '/api/notes' } }] }));
    const list = await draftAcceptanceChecklist(ctx, 'GET /api/notes lists notes');
    expect(list).toHaveLength(1);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]).toMatchObject({ role: 'draft-checklist', actor: CHECKLIST_ACTOR });
  });

  it('never throws: a transport error or unusable answer is an empty checklist', async () => {
    const failing = makeCtx();
    failing.llm.enqueue(() => { throw new Error('provider down'); });
    expect(await draftAcceptanceChecklist(failing, 'goal')).toEqual([]);
    const prose = makeCtx();
    prose.llm.enqueueText('I would check the notes page.');
    expect(await draftAcceptanceChecklist(prose, 'goal')).toEqual([]);
  });
});

describe('host attribution of an HTTP observation', () => {
  it.skipIf(process.platform === 'win32')('is structured only for a server this tool set started, and never for a redirect', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { createServer } = await import('node:http');
    const { localToolBackend } = await import('../src/run/toolBackend.js');
    const { attestingExecutor, createAttestationLog } = await import('../src/core/attestation.js');
    const { silentLogger } = await import('./helpers.js');
    const workspace = mkdtempSync(join(tmpdir(), 'atoma-checklist-attrib-'));
    const stranger = createServer((_q, r) => { r.end('not ours'); });
    await new Promise<void>((resolve) => stranger.listen(0, '127.0.0.1', resolve));
    const strangerPort = (stranger.address() as { port: number }).port;
    const backend = localToolBackend({ workspaceRoot: workspace, logger: silentLogger() });
    const log = createAttestationLog();
    const tools = attestingExecutor(backend.executor, log, undefined, undefined, 1)!;
    try {
      writeFileSync(join(workspace, 'server.cjs'), "const http=require('node:http');const s=http.createServer((q,r)=>{if(q.url==='/old'){r.statusCode=302;r.setHeader('location','/api/notes');return r.end()}r.end('[]')});s.listen(0,'127.0.0.1',()=>console.log('LISTENING_ON_PORT='+s.address().port));");
      const started = await tools.execute('start_node_server', { entry: 'server.cjs' }) as { url: string };
      await tools.execute('fetch_url', { url: `${started.url}api/notes?x=1` });
      await tools.execute('fetch_url', { url: `${started.url}old` });
      await tools.execute('fetch_url', { url: `http://127.0.0.1:${strangerPort}/api/notes` });
      const fetches = log.forAttempt(1).filter((record) => record.tool === 'fetch_url');
      expect(fetches).toHaveLength(3);
      expect(fetches.map((record) => record.observation.kind === 'execution' ? record.observation.http : 'x')).toEqual([
        { method: 'GET', path: '/api/notes?x=1', status: 200 },
        undefined,
        undefined,
      ]);
    } finally {
      await backend.drain?.();
      await backend.cleanup();
      await new Promise<void>((resolve) => stranger.close(() => resolve()));
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20000);
});
