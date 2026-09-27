import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { parseInteractions, startStaticServerTool, validateHtmlTool, type ServedOrigins } from '../src/tools/builtin.js';
import { validateProbeManifest } from '../src/contracts/probeManifest.js';
import { establishesDomInteraction, parseBrowserObservation } from '../src/contracts/attestation.js';

/**
 * A headless page opens no native <select> popup: a click on an <option> has
 * no bounding box and arrow keys on a closed select change nothing, and no
 * interaction could set a range slider. Production runs 556c9e54 and
 * 068cfe14 (2026-09-27) proved a filter select only by assigning `.value`
 * from the smoke, which executes no interaction. `select` chooses as a person
 * does — input and change events included — through a real browser here.
 */

const PAGE = `<!doctype html><title>select</title>
<select id="region"><option value="all">All regions</option><option value="east">East</option><option value="west" disabled>West</option></select>
<input type="range" id="pages" min="1" max="30" step="1" value="10">
<input type="text" id="name">
<select id="hidden" style="display:none"><option value="a">A</option></select>
<select id="invisible" style="visibility:hidden"><option value="a">A</option></select>
<p id="log"></p>
<script>
  const log = [];
  const note = (event) => { log.push(event.target.id + ':' + event.type + ':' + event.target.value); document.getElementById('log').textContent = log.join(','); };
  for (const id of ['region', 'pages']) { const el = document.getElementById(id); el.addEventListener('input', note); el.addEventListener('change', note); }
</script>`;

const sandboxes: ToolSandbox[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.cleanup().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-select-'));
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
const READ_LOG = "(() => ({ ok: true, log: document.getElementById('log').textContent, region: document.getElementById('region').value, pages: document.getElementById('pages').value }))()";

describe('validate_html select interaction', () => {
  it('chooses a <select> option by value or label and sets a range, firing input and change', async () => {
    const { url, validate } = await serve();
    const interactions = [
      { type: 'select', selector: '#region', value: 'East' },
      { type: 'select', selector: '#pages', value: 12 },
    ];
    const result = (await validate.execute({ url, interactions, smoke: READ_LOG })) as Validation;
    expect(result.errors).toEqual([]);
    expect(result.interactionLog).toEqual(['select "east" in #region', 'select "12" in #pages']);
    expect(result.smokeResult).toMatchObject({ region: 'east', pages: '12',
      log: 'region:input:east,region:change:east,pages:input:12,pages:change:12' });
    // The host counts it as an interaction the page received, not a smoke's own work.
    const observation = parseBrowserObservation({ url, interactions }, result);
    expect(observation && establishesDomInteraction({ eventId: 'e', attempt: 1, observation } as never)).toBe(true);
  }, 60_000);

  it('says where a slider settled when its step or bounds moved the value', async () => {
    const { url, validate } = await serve();
    const result = (await validate.execute({ url, interactions: [{ type: 'select', selector: '#pages', value: '99' }], smoke: READ_LOG })) as Validation;
    expect(result.errors).toEqual([]);
    expect(result.smokeResult).toMatchObject({ pages: '30' });
    expect(result.warnings.join(' ')).toMatch(/settled on "30", not "99"/);
  }, 60_000);

  it('refuses what nobody could choose: a missing option, a disabled one, a hidden control, a text field', async () => {
    const { url, validate } = await serve();
    const attempt = async (interaction: Record<string, unknown>) =>
      ((await validate.execute({ url, interactions: [interaction] })) as Validation).errors.join(' ');
    expect(await attempt({ type: 'select', selector: '#region', value: 'north' })).toMatch(/no <option> has the value or label "north"; its values are \["all","east","west"\]/);
    expect(await attempt({ type: 'select', selector: '#region', value: 'west' })).toMatch(/the option "west" is disabled/);
    expect(await attempt({ type: 'select', selector: '#hidden', value: 'a' })).toMatch(/not rendered/);
    expect(await attempt({ type: 'select', selector: '#invisible', value: 'a' })).toMatch(/not rendered/);
    expect(await attempt({ type: 'select', selector: '#name', value: 'x' })).toMatch(/<input type="text">.*Use "type" for a text field/);
    expect(await attempt({ type: 'select', selector: '#region' })).toMatch(/requires "value"/);
  }, 60_000);

  it('sends keys to the element a keyboard interaction names', async () => {
    const { url, validate } = await serve();
    const result = (await validate.execute({ url, smoke: READ_LOG, interactions: [
      { type: 'click', selector: '#name' },
      { type: 'keypress', selector: '#pages', key: 'ArrowRight' },
    ] })) as Validation;
    expect(result.errors).toEqual([]);
    expect(result.interactionLog[1]).toBe('keypress ArrowRight (120ms) on #pages');
    expect(result.smokeResult).toMatchObject({ pages: '11' });
    // The selector was ignored for keys before: one that matches nothing warns, never fails the call.
    const missed = (await validate.execute({ url, smoke: READ_LOG, interactions: [
      { type: 'keypress', selector: '#pages', key: 'ArrowRight' },
      { type: 'keypress', selector: '#nope', key: 'ArrowRight' },
    ] })) as Validation;
    expect(missed.errors).toEqual([]);
    expect(missed.warnings.join(' ')).toMatch(/keyboard selector #nope matched no element/);
    expect(missed.smokeResult).toMatchObject({ pages: '12' });
  }, 60_000);

  it('parses the select interaction and admits it in a probe manifest', () => {
    expect(parseInteractions([{ type: 'select', selector: '#pages', value: 12 }]))
      .toEqual([{ type: 'select', selector: '#pages', value: '12' }]);
    const manifest = (interactions: unknown[]) => ({ version: 1, entries: [{ probe: 'web', file: 'index.html', interactions,
      smoke: "document.getElementById('region').value === 'east'", expected: 'true', consoleErrors: 0 }] });
    const problems = (interactions: unknown[]) => validateProbeManifest(JSON.stringify(manifest(interactions))).join(' ');
    expect(problems([{ type: 'select', selector: '#region', value: 'east' }])).not.toMatch(/interaction/);
    expect(problems([{ type: 'select', selector: '#region' }])).toMatch(/select requires string selector and value/);
  });
});
