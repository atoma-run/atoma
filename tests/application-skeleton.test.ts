import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';

const roots: string[] = [];
function fixture(): { root: string; tool: ReturnType<typeof runShellTool> } {
  const root = mkdtempSync(join(tmpdir(), 'atoma-skeleton-test-'));
  roots.push(root);
  return { root, tool: runShellTool({ sandbox: new ToolSandbox(root) }) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('application skeleton through the existing shell tool', () => {
  it.each(['web', 'node', 'fullstack'])('creates a reproducible %s application without installing or executing it', async kind => {
    const { root, tool } = fixture();
    const result = await tool.execute({ cmd: `atoma-scaffold ${kind}` });
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(readdirSync(root)).toContain('package-lock.json');
    expect(readdirSync(root)).not.toContain('node_modules');
    expect(readFileSync(join(root, 'src/server.ts'), 'utf8')).toContain('LISTENING_ON_PORT=');
  });

  it('refuses existing work and permits a separate reference directory', async () => {
    const { root, tool } = fixture();
    writeFileSync(join(root, 'package.json'), 'existing bytes');
    expect(await tool.execute({ command: 'atoma-scaffold', args: ['web'] })).toMatchObject({ exitCode: 1 });
    expect(readdirSync(root)).toEqual(['package.json']);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('existing bytes');
    expect(await tool.execute({ command: 'atoma-scaffold', args: ['web', '.atoma-skeleton'] })).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('existing bytes');
  });

  // Review 2026-10-17: a seed holding only the host's `.atoma-runs` copies
  // was refused as not empty, which invited `rm -rf .atoma-runs`.
  it('scaffolds beside the host\'s .atoma-* entries, which it leaves as they are', async () => {
    const { root, tool } = fixture();
    const copy = join(root, '.atoma-runs', 'node_modules', '50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'package.json'), 'the read run\'s bytes');
    writeFileSync(join(root, '.atoma-probes.json'), '{"version":1,"entries":[]}');
    expect(await tool.execute({ cmd: 'atoma-scaffold web' })).toMatchObject({ exitCode: 0, stderr: '' });
    expect(readdirSync(root)).toEqual(expect.arrayContaining(['.atoma-runs', '.atoma-probes.json', 'package.json', 'package-lock.json']));
    expect(readFileSync(join(copy, 'package.json'), 'utf8')).toBe('the read run\'s bytes');
    // Application work beside them still refuses.
    const other = fixture();
    mkdirSync(join(other.root, '.atoma-runs'));
    writeFileSync(join(other.root, 'index.html'), 'existing work');
    expect(await other.tool.execute({ cmd: 'atoma-scaffold web' })).toMatchObject({ exitCode: 1 });
    expect(readdirSync(other.root).sort()).toEqual(['.atoma-runs', 'index.html']);
  });

  it('refuses traversal, external links, unknown kinds and extra arguments', async () => {
    const { root, tool } = fixture();
    const outside = fixture().root;
    symlinkSync(outside, join(root, 'external'), 'dir');
    for (const args of [['web', '../escape'], ['web', 'external'], ['unknown'], ['node', 'new', 'extra']]) {
      expect(await tool.execute({ command: 'atoma-scaffold', args })).toMatchObject({ exitCode: 1 });
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(root)).toEqual(['external']);
  });

  it('respects a restricted shell allowlist', async () => {
    const { root } = fixture();
    const tool = runShellTool({ sandbox: new ToolSandbox(root), shellAllowlist: ['node'] });
    await expect(tool.execute({ command: 'atoma-scaffold', args: ['web'] })).rejects.toThrow('not in allowlist');
    expect(readdirSync(root)).toEqual([]);
  });
});
