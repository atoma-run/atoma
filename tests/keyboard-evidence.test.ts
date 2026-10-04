import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { startStaticServerTool, validateHtmlTool, type ServedOrigins } from '../src/tools/builtin.js';
import { parseBrowserObservation, renderObservation } from '../src/contracts/attestation.js';

it('keeps natural keyboard navigation, forced focus and a failed activation distinguishable in real browser evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-keyboard-proof-'));
  const sandbox = new ToolSandbox(dir);
  const servedOrigins: ServedOrigins = new Map();
  const page = '<button id="borrow" onclick="document.querySelector(\'#count\').textContent=\'1\'">Borrow</button><output id="count">0</output>';
  const smoke = "(() => { const checks = { focused: document.activeElement.id === 'borrow', borrowed: document.querySelector('#count').textContent === '1' }; return { ok: Object.values(checks).every(Boolean), checks }; })()";
  try {
    const served = await startStaticServerTool({ sandbox, servedOrigins }).execute({}) as { ok: boolean; url: string };
    expect(served.ok).toBe(true);
    const validate = validateHtmlTool({ sandbox, servedOrigins });
    const observe = async (html: string, interactions: Record<string, string>[]) => {
      writeFileSync(join(dir, 'index.html'), html);
      const args = { url: served.url, interactions, smoke };
      const observation = parseBrowserObservation(args, await validate.execute(args))!;
      expect(observation).not.toBeNull();
      return { observation, line: renderObservation({ eventId: 'browser', tool: 'validate_html', observation }) };
    };
    const keys = [{ type: 'keypress', key: 'Tab' }, { type: 'keypress', key: 'Enter' }];
    const natural = await observe(page, keys);
    expect(natural.observation.ok).toBe(true);
    expect(natural.line).toContain('keypress Tab');
    expect(natural.line).not.toContain(' on #borrow');
    expect(natural.line).toContain('"borrowed":true');

    const forced = await observe(page.replace('<button ', '<button tabindex="-1" '),
      [{ type: 'keypress', key: 'Enter', selector: '#borrow' }]);
    expect(forced.observation.ok).toBe(true);
    expect(forced.line).toContain(' on #borrow');
    expect(forced.line).not.toContain('keypress Tab');

    const failed = await observe(page.replace('<button ', '<div role="button" tabindex="0" ').replace('</button>', '</div>'), keys);
    expect(failed.observation.ok).toBe(false);
    expect(failed.line).toContain('keypress Enter');
    expect(failed.line).toContain('"borrowed":false');
  } finally {
    await sandbox.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
