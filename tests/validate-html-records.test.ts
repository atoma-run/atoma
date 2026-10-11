import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { startStaticServerTool, validateHtmlTool, type ServedOrigins } from '../src/tools/builtin.js';
import { PROBE_MANIFEST_FILENAME, appendWebProbe, manifestWriterLines, validateProbeManifest } from '../src/contracts/probeManifest.js';
import { webEntryIdentity } from '../src/contracts/webCheck.js';
import { HOST_REPLAY_ARG } from '../src/contracts/inheritedChecks.js';

/**
 * validate_html is the probe manifest's third recorder (2026-10-11). Until
 * then the web canonical asked the molecule to write_file the manifest by
 * hand; it wrote prose labels where a smoke belongs ("completion best
 * update"), then spent batches of edit_file calls repairing them — 28 of the
 * 36 edit_file failures in the 2026-10-10 timing corpus, 17 in run bad74240,
 * whose refusal named record_probe, a tool that molecule did not hold.
 */

const PAGE = `<!doctype html><title>counter</title>
<button id="inc">+</button><output id="n">0</output>
<script>
  document.getElementById('inc').addEventListener('click', () => {
    const n = document.getElementById('n'); n.textContent = String(Number(n.textContent) + 1);
  });
</script>`;

const READ = "(() => ({ ok: document.getElementById('n').textContent === '1', n: document.getElementById('n').textContent }))()";

const sandboxes: ToolSandbox[] = [];
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup().catch(() => undefined);
});

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-vh-record-'));
  writeFileSync(join(dir, 'index.html'), PAGE);
  const origins: ServedOrigins = new Map();
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  const served = (await startStaticServerTool({ sandbox, servedOrigins: origins }).execute({})) as { ok: boolean; url: string };
  expect(served.ok, JSON.stringify(served)).toBe(true);
  return { dir, url: served.url, validate: validateHtmlTool({ sandbox, servedOrigins: origins }) };
}

const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, PROBE_MANIFEST_FILENAME), 'utf8')) as { entries: Record<string, unknown>[] };

describe('validate_html records its own passing checks', () => {
  // The document binding needs the server's listening port read back, which this machine's Windows cannot (tests/document-binding.test.ts).
  it.skipIf(process.platform === 'win32')('a passing check becomes a valid web entry with the replay identity of the request; a repeat replaces it', async () => {
    const { dir, url, validate } = await serve();
    const request = { url, interactions: [{ type: 'click', selector: '#inc' }], smoke: READ, viewport: { width: 375, height: 700 }, waitMs: 100 };
    const first = (await validate.execute(request)) as { ok: boolean; recorded?: true; manifest?: string; errors: string[] };
    expect(first.ok, JSON.stringify(first.errors)).toBe(true);
    expect(first.recorded).toBe(true);
    expect(first.manifest).toBe(PROBE_MANIFEST_FILENAME);
    const manifest = manifestOf(dir);
    expect(validateProbeManifest(JSON.stringify(manifest))).toEqual([]);
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0]!;
    expect(entry).toMatchObject({ probe: 'web', file: 'index.html', smoke: READ, consoleErrors: 0, failedRequests: 0, waitMs: 100 });
    expect(JSON.parse(entry['expected'] as string)).toEqual({ ok: true, n: '1' });
    expect(webEntryIdentity(entry)).toBe(webEntryIdentity({ file: 'index.html', interactions: request.interactions, smoke: READ, viewport: request.viewport, waitMs: 100 }));
    // The same check again replaces its entry: the manifest holds one record per check.
    await validate.execute(request);
    expect(manifestOf(dir).entries).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('a keyboard-only check (no selector) records a valid entry too', async () => {
    const { dir, url, validate } = await serve();
    const interactions = [{ type: 'keypress', key: 'Tab' }, { type: 'keypress', key: 'Enter' }];
    const result = (await validate.execute({ url, interactions, smoke: READ })) as { ok: boolean; errors: string[] };
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    const manifest = manifestOf(dir);
    expect(validateProbeManifest(JSON.stringify(manifest))).toEqual([]);
    expect(manifest.entries[0]!['interactions']).toMatchObject(interactions);
  });

  it('a failing check, a smoke-less load, a literal verdict and a host replay record nothing', async () => {
    const { dir, url, validate } = await serve();
    // A smoke that reads nothing of the page is no check, whatever it returns.
    const literal = (await validate.execute({ url, smoke: '(() => ({ ok: true }))()' })) as { ok: boolean; recorded?: true };
    expect(literal.ok).toBe(true);
    expect(literal.recorded).toBeUndefined();
    const failing = (await validate.execute({ url, smoke: READ })) as { ok: boolean; recorded?: true };
    expect(failing.ok).toBe(false);
    expect(failing.recorded).toBeUndefined();
    await validate.execute({ url });
    expect(existsSync(join(dir, PROBE_MANIFEST_FILENAME))).toBe(false);
    const replay = (await validate.execute({ url, interactions: [{ type: 'click', selector: '#inc' }], smoke: READ, [HOST_REPLAY_ARG]: true })) as { ok: boolean };
    expect(replay.ok).toBe(true);
    expect(existsSync(join(dir, PROBE_MANIFEST_FILENAME))).toBe(false);
  });
});

describe('appendWebProbe and what the web molecule is told', () => {
  const entry = { probe: 'web' as const, file: 'index.html', interactions: [{ type: 'click', selector: '#a' }], smoke: 'true', expected: 'true' };
  it('replaces by replay identity, appends otherwise, and resets a corrupt manifest', () => {
    const one = appendWebProbe(null, entry);
    const same = appendWebProbe(one, { ...entry, expected: 'false' });
    expect((JSON.parse(same) as { entries: unknown[] }).entries).toEqual([{ ...entry, expected: 'false' }]);
    const two = JSON.parse(appendWebProbe(same, { ...entry, smoke: 'false' })) as { entries: unknown[] };
    expect(two.entries).toHaveLength(2);
    const kept = JSON.parse(appendWebProbe('{"version":1,"entries":[{"cmd":"node a.js","exitCode":0}]}', entry)) as { entries: unknown[] };
    expect(kept.entries).toHaveLength(2);
    expect((JSON.parse(appendWebProbe('{not json', entry)) as { entries: unknown[] }).entries).toEqual([entry]);
  });

  it('the web canonical no longer asks for a hand-written manifest', () => {
    const lines = manifestWriterLines('web').join('\n');
    expect(lines).not.toContain('ALSO write_file');
    expect(lines).toContain('validate_html RECORDS every PASSING check');
    expect(lines).toContain('NEVER write_file or edit_file that manifest');
    expect(lines).toContain('"probe": "web"');
  });
});
