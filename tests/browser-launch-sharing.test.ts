import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { validateHtmlTool } from '../src/tools/builtin.js';

it('parallel validations share one real Chromium launch and retain independent failing assertions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-sharing-'));
  const sandbox = new ToolSandbox(root);
  try {
    const tool = validateHtmlTool({ sandbox });
    const results = await Promise.all([
      tool.execute({ url: 'about:blank', waitMs: 10, smoke: '({ok: document.title === ""})' }),
      tool.execute({ url: 'about:blank', waitMs: 10, smoke: '({ok: document.title === "not the title"})' }),
    ]);
    expect(sandbox.trackedChildPids()).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false });
    await sandbox.cleanup();
    expect(sandbox.trackedChildPids()).toEqual([]);
  } finally {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
