import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('packaged workspace service', () => {
  it('runs its standalone import closure without node_modules, credentials or the product store', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-workspace-package-')));
    try {
      const entry = join(root, 'service.mjs');
      await build({ entryPoints: [resolve('src/run/workspaceService.ts')], outfile: entry,
        bundle: true, platform: 'node', format: 'esm', target: 'node24' });
      const workspace = join(root, 'workspace'); mkdirSync(workspace);
      writeFileSync(join(workspace, 'README.md'), 'Packaged service');
      const output = execFileSync(process.execPath, [entry], { cwd: root,
        env: { ATOMA_WORKSPACE_ROOT: workspace }, encoding: 'utf8', timeout: 15_000,
        input: JSON.stringify({ version: 1, id: 1, command: { method: 'routing' } }) + '\n' });
      const reply = JSON.parse(output) as { ok: boolean; reply: { value: { files: string[] } } };
      expect(reply.ok).toBe(true);
      expect(reply.reply.value.files).toEqual(['README.md']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
