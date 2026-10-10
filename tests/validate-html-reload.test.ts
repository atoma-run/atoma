import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { startStaticServerTool, validateHtmlTool, type ServedOrigins } from '../src/tools/builtin.js';
import { validateProbeManifest } from '../src/contracts/probeManifest.js';
import { establishesDomInteraction, parseBrowserObservation, renderBrowserInputs } from '../src/contracts/attestation.js';
import { parseInteractions, reloadKeyRefusal, webEntryIdentity } from '../src/contracts/webCheck.js';
import { HOST_REPLAY_ARG } from '../src/contracts/inheritedChecks.js';
import type { AttestationRecord } from '../src/contracts/attestation.js';

/**
 * A RELOAD AND A KEYBOARD-ONLY TYPING, through a real browser (2026-10-10).
 *
 * validate_html could not reload a page, and a key event a headless page
 * receives is a keystroke, never a browser shortcut: production run 779d854c
 * delivered "favourites survive a page reload" on a keypress F5 whose smoke
 * read the page before any reload. And `type` clicked its field, so a typing
 * test reached with Tab alone could never be shown (runs bad74240, d7179253,
 * $2 and 92 minutes, both refused).
 */

const PAGE = `<!doctype html><title>reload</title>
<form id="f"><input id="name" autocomplete="off"><button id="save" type="submit">Save</button></form>
<output id="saved"></output>
<script>
  document.getElementById('saved').textContent = localStorage.getItem('name') ?? 'none';
  document.getElementById('f').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = document.getElementById('name').value;
    localStorage.setItem('name', value);
    window.__savedInThisDocument = true;
    document.getElementById('saved').textContent = value;
  });
</script>`;

const READ = "(() => ({ ok: true, saved: document.getElementById('saved').textContent, sameDocument: window.__savedInThisDocument === true, focus: document.activeElement && document.activeElement.id }))()";

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-reload-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), PAGE);
  const sandbox = new ToolSandbox(dir);
  sandboxes.push(sandbox);
  const origins: ServedOrigins = new Map();
  const served = (await startStaticServerTool({ sandbox, servedOrigins: origins }).execute({})) as { ok: boolean; url: string };
  expect(served.ok, JSON.stringify(served)).toBe(true);
  return { url: served.url, validate: validateHtmlTool({ sandbox, servedOrigins: origins }) };
}

type Validation = { ok: boolean; errors: string[]; warnings: string[]; interactionLog: string[]; smokeResult?: unknown };
const record = (args: Record<string, unknown>, result: unknown): AttestationRecord =>
  ({ eventId: 'e', attempt: 1, tool: 'validate_html', observation: parseBrowserObservation(args, result) }) as unknown as AttestationRecord;

describe('validate_html: keyboard-only typing and a real reload', () => {
  it('types where Tab left focus, then a reload shows what survived in a new document', async () => {
    const { url, validate } = await serve();
    const interactions = [
      { type: 'keypress', key: 'Tab' },
      { type: 'type', text: 'Ada' },
      { type: 'keypress', key: 'Enter' },
      { type: 'reload' },
    ];
    const args = { url, interactions, smoke: READ };
    const result = (await validate.execute(args)) as Validation;
    expect(result.errors).toEqual([]);
    expect(result.interactionLog).toEqual(['keypress Tab (120ms)', 'type "Ada" at focus on input#name', 'keypress Enter (120ms)', 'reload']);
    // Stored by the keyboard journey, read back by a document that never saved it.
    expect(result.smokeResult).toMatchObject({ saved: 'Ada', sameDocument: false });
    expect(establishesDomInteraction(record(args, result))).toBe(true);
  }, 60_000);

  it('without the reload, the smoke reads the document that saved: the distinction the check proves', async () => {
    const { url, validate } = await serve();
    const result = (await validate.execute({ url, smoke: READ, interactions: [
      { type: 'keypress', key: 'Tab' }, { type: 'type', text: 'Bo' }, { type: 'keypress', key: 'Enter' },
    ] })) as Validation;
    expect(result.smokeResult).toMatchObject({ saved: 'Bo', sameDocument: true });
  }, 60_000);

  it('refuses F5 and Control+R as reloads, executes neither, and names the interaction that reloads', async () => {
    const { url, validate } = await serve();
    // Production run 779d854c: a keypress F5 was read as a reload.
    const f5 = (await validate.execute({ url, smoke: READ, interactions: [{ type: 'keypress', key: 'F5' }] })) as Validation;
    expect(f5.ok).toBe(false);
    expect(f5.errors.join(' ')).toMatch(/F5 does not reload the page.*"type": "reload"/);
    expect(f5.interactionLog).toEqual([]);
    const chord = (await validate.execute({ url, smoke: READ, interactions: [
      { type: 'keydown', key: 'Control' }, { type: 'keypress', key: 'r' }, { type: 'keyup', key: 'Control' },
    ] })) as Validation;
    expect(chord.ok).toBe(false);
    expect(chord.errors.join(' ')).toMatch(/Control\+r does not reload/);
    expect(chord.interactionLog).toEqual(['keydown Control', 'keyup Control']);
    // A Control held across a reload still makes r a Control+R.
    const across = (await validate.execute({ url, smoke: READ, interactions: [
      { type: 'keydown', key: 'Control' }, { type: 'reload' }, { type: 'keypress', key: 'r' }, { type: 'keyup', key: 'Control' },
    ] })) as Validation;
    expect(across.errors.join(' ')).toMatch(/Control\+r does not reload/);
    // A plain r, once Control is released, is a keystroke like any other.
    const plain = (await validate.execute({ url, smoke: READ, interactions: [
      { type: 'keydown', key: 'Control' }, { type: 'keyup', key: 'Control' }, { type: 'keypress', key: 'r', selector: '#name' },
    ] })) as Validation;
    expect(plain.errors).toEqual([]);
  }, 60_000);

  it('a selectorless type with nothing focused is refused, never typed into the void', async () => {
    const { url, validate } = await serve();
    const result = (await validate.execute({ url, smoke: READ, interactions: [{ type: 'type', text: 'x' }] })) as Validation;
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/nothing has focus: reach the field with keypress Tab first/);
    expect(result.interactionLog).toEqual([]);
  }, 60_000);

  it('the host replay of an inherited check reloads in its own context', async () => {
    const { url, validate } = await serve();
    const result = (await validate.execute({ url, smoke: READ, [HOST_REPLAY_ARG]: true, interactions: [
      { type: 'keypress', key: 'Tab' }, { type: 'type', text: 'Cy' }, { type: 'keypress', key: 'Enter' }, { type: 'reload' },
    ] })) as Validation & { smokeOk?: boolean };
    expect(result.errors).toEqual([]);
    expect(result.smokeOk).toBe(true);
    expect(result.smokeResult).toMatchObject({ saved: 'Cy', sameDocument: false });
  }, 60_000);
});

describe('reload and focused typing in the shared contracts', () => {
  it('a reload alone is no DOM interaction, and the input inventory counts it apart', () => {
    const reloadOnly = record({ interactions: [{ type: 'reload' }] }, { ok: true, interactionLog: ['reload'], requestedInteractions: 1 });
    expect(establishesDomInteraction(reloadOnly)).toBe(false);
    const both = record({}, { ok: true, interactionLog: ['click at (1, 2) on #save', 'reload'] });
    expect(establishesDomInteraction(both)).toBe(true);
    expect(renderBrowserInputs([reloadOnly, both])).toContain('click=1');
    expect(renderBrowserInputs([reloadOnly, both])).toContain('reload=2');
    expect(renderBrowserInputs([reloadOnly, both])).toContain('other=0');
  });

  it('parses, validates and identifies a reload and a selectorless type', () => {
    const steps = [{ type: 'keypress', key: 'Tab' }, { type: 'type', text: 'Ada' }, { type: 'reload' }];
    expect(parseInteractions(steps)).toEqual([{ type: 'keypress', key: 'Tab' }, { type: 'type', text: 'Ada' }, { type: 'reload' }]);
    const entry = { probe: 'web', file: 'index.html', interactions: steps, smoke: READ, expected: 'true' };
    expect(validateProbeManifest(JSON.stringify({ version: 1, entries: [entry] }))).toEqual([]);
    expect(validateProbeManifest(JSON.stringify({ version: 1, entries: [{ ...entry, interactions: [{ type: 'type', selector: 7, text: 'x' }] }] })).join(' '))
      .toMatch(/type requires string text/);
    // With and without the reload are two checks: the manifest keeps both.
    expect(webEntryIdentity(entry)).not.toBe(webEntryIdentity({ ...entry, interactions: steps.slice(0, 2) }));
  });

  it('names exactly the keys that a headless page would not reload on', () => {
    expect(reloadKeyRefusal('F5', new Set())).toMatch(/^F5 does not reload/);
    expect(reloadKeyRefusal('R', new Set(['Meta']))).toMatch(/^Meta\+R does not reload/);
    expect(reloadKeyRefusal('r', new Set())).toBeNull();
    expect(reloadKeyRefusal('Enter', new Set(['Control']))).toBeNull();
  });
});
