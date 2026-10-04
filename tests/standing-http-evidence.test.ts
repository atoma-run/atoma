import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { relativeSpecifiers, serverCodeDigest } from '../src/contracts/serverDigest.js';
import {
  decodeStandingHttpEvidence,
  encodeStandingHttpEvidence,
  MAX_STANDING_HTTP_EVIDENCE_CHARS,
  standingHttpObservationsOf,
} from '../src/contracts/standingHttpEvidence.js';
import { standingHttpEvidenceFor } from '../src/projects/standingEvidence.js';
import type { ProjectRun } from '../src/contracts/projects.js';
import type { ProjectStore } from '../src/projects/store.js';

/**
 * Owner decision 2026-10-04 (option 1): four continuation runs of one project
 * re-proved an unchanged backend live and were refused for "no current
 * verification". A probe the HOST recorded in the seed lineage now counts while
 * the server code it was made against is unchanged — never one a model wrote
 * into .atoma-probes.json.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const DIGEST = 'a'.repeat(64);
const fetchEvent = (id: string, url: string, status: number, servedBy?: object, method = 'POST') => ({
  id, kind: 'tool', name: 'fetch_url', args: { url, method }, result: { ok: status < 400, status, ...(servedBy ? { servedBy } : {}) },
});

describe('the server code digest', () => {
  it('follows relative imports, requires and dynamic imports, and changes with any of them', async () => {
    expect(relativeSpecifiers("import a from './a.js'; const b = require('../b'); await import('./c.mjs'); import 'node:fs'; import x from 'pkg';"))
      .toEqual(['./a.js', '../b', './c.mjs']);
    const files: Record<string, string> = {
      'server.js': "const { route } = require('./lib/routes');\nroute();\n",
      'lib/routes.js': "export const route = () => 1; import './util.js';\n",
      'lib/util.js': 'export {};\n',
    };
    const read = (path: string) => files[path];
    const before = await serverCodeDigest('server.js', read);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(await serverCodeDigest('./server.js', read)).toBe(before);
    files['lib/util.js'] = 'export const changed = true;\n';
    expect(await serverCodeDigest('server.js', read)).not.toBe(before);
    expect(await serverCodeDigest('missing.js', read)).toBeUndefined();
  });

  it('fails closed on what it cannot follow, and reads json modules and package.json', async () => {
    const files: Record<string, string> = { 'server.js': "const config = require('./config');\n", 'config.json': '{"a":1}' };
    const read = (path: string) => files[path];
    const before = await serverCodeDigest('server.js', read);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    files['config.json'] = '{"a":2}';
    expect(await serverCodeDigest('server.js', read)).not.toBe(before);
    files['package.json'] = '{"type":"module"}';
    const withManifest = await serverCodeDigest('server.js', read);
    files['package.json'] = '{"type":"commonjs"}';
    expect(await serverCodeDigest('server.js', read)).not.toBe(withManifest);
    expect(await serverCodeDigest('a.js', (p: string) => ({ 'a.js': "import x from './gone.js';" } as Record<string, string>)[p])).toBeUndefined();
    expect(await serverCodeDigest('b.js', (p: string) => ({ 'b.js': "import x from '#internal';" } as Record<string, string>)[p])).toBeUndefined();
    expect(await serverCodeDigest('c.js', (p: string) => ({ 'c.js': 'const m = require(`./${name}.js`);' } as Record<string, string>)[p])).toBeUndefined();
  });
});

describe('host-recorded HTTP observations', () => {
  it('reads only fetch_url events a server this run started answered, with its code digest', () => {
    const trace = { events: [
      fetchEvent('e1', 'http://localhost:4100/api/loans', 201, { kind: 'node', entry: 'server.js', codeDigest: DIGEST }),
      fetchEvent('e2', 'http://localhost:4100/api/loans', 404, { kind: 'node', entry: 'server.js' }),
      fetchEvent('e3', 'https://example.com/x', 200),
      { id: 'e4', kind: 'tool', name: 'write_file', args: { path: '.atoma-probes.json' }, result: {} },
      fetchEvent('e5', 'http://localhost:4100/api/books?x=1', 200, { kind: 'node', entry: 'server.js', codeDigest: DIGEST }, 'get'),
    ] };
    expect(standingHttpObservationsOf('run-1', trace)).toEqual([
      { runId: 'run-1', eventId: 'e5', method: 'GET', path: '/api/books?x=1', status: 200, entry: 'server.js', codeDigest: DIGEST },
      { runId: 'run-1', eventId: 'e1', method: 'POST', path: '/api/loans', status: 201, entry: 'server.js', codeDigest: DIGEST },
    ]);
    expect(standingHttpObservationsOf('run-1', 'not a trace')).toEqual([]);
  });

  it('encodes a bounded, deduplicated list and decodes a malformed one to nothing', () => {
    const one = { runId: 'r', eventId: 'e', method: 'GET', path: '/a', status: 200, entry: 'server.js', codeDigest: DIGEST };
    const encoded = encodeStandingHttpEvidence([one, { ...one, eventId: 'e2' }])!;
    expect(decodeStandingHttpEvidence(encoded)).toEqual([one]);
    const many = Array.from({ length: 300 }, (_, i) => ({ ...one, eventId: `e${i}`, path: `/${'p'.repeat(400)}${i}` }));
    expect(encodeStandingHttpEvidence(many)!.length).toBeLessThanOrEqual(MAX_STANDING_HTTP_EVIDENCE_CHARS);
    expect(decodeStandingHttpEvidence('{"not":"a list"}')).toEqual([]);
    expect(decodeStandingHttpEvidence(JSON.stringify([{ ...one, codeDigest: 'forged' }]))).toEqual([]);
  });

  it('walks the seed lineage traces on disk, newest run first, and stops at a failed run', () => {
    const runsPath = mkdtempSync(join(tmpdir(), 'atoma-standing-'));
    roots.push(runsPath);
    const run = (id: string, status: ProjectRun['status'], seed?: string) => ({
      projectRunId: id, traceId: id, orgId: 'org', projectId: 'p', status, rerunOf: null, bytesExpiredAt: null,
      hostPaths: { runsPath }, seed: seed ? { kind: 'run', runId: seed } : { kind: 'none' },
    }) as unknown as ProjectRun;
    const runs: Record<string, ProjectRun> = { b: run('b', 'partial', 'a'), a: run('a', 'delivered', 'z'), z: run('z', 'failed') };
    const write = (id: string, events: object[]) => writeFileSync(join(runsPath, `${id}.json`), JSON.stringify({ id, events }));
    write('a', [fetchEvent('a1', 'http://localhost:1/api/books', 200, { kind: 'node', entry: 'server.js', codeDigest: DIGEST }, 'GET')]);
    write('b', [fetchEvent('b1', 'http://localhost:2/api/loans', 409, { kind: 'node', entry: 'server.js', codeDigest: DIGEST })]);
    write('z', [fetchEvent('z1', 'http://localhost:3/api/old', 200, { kind: 'node', entry: 'server.js', codeDigest: DIGEST }, 'GET')]);
    const store = { getProjectRun: (_org: string, id: string) => runs[id] ?? null } as unknown as ProjectStore;
    const evidence = decodeStandingHttpEvidence(standingHttpEvidenceFor(store, runs['b']!));
    expect(evidence.map((entry) => `${entry.runId}/${entry.eventId}`)).toEqual(['b/b1', 'a/a1']);
  });
});
