import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFilesTool, readFileTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';

describe('workspace-relative file discovery and missing reads', () => {
  let root: string;
  let sandbox: ToolSandbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-read-paths-'));
    sandbox = new ToolSandbox(root);
    mkdirSync(join(root, 'test/proofs'), { recursive: true });
    writeFileSync(join(root, 'test/proofs/diamond.js'), 'diamond proof');
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  async function listing(path?: string) {
    return await listFilesTool({ sandbox }).execute(path === undefined ? {} : { path }) as {
      path: string; entries: { name: string; path: string; kind: string }[];
    };
  }

  it('replays the production doubled-prefix failure and recovers using returned paths', async () => {
    const read = readFileTool({ sandbox });
    const error = await read.execute({ path: 'test/test/proofs/diamond.js' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect((error as Error).message).toContain('test/test/proofs/diamond.js');
    expect((error as Error).message).toContain('"path":"test/proofs"');
    expect((error as Error).message).not.toContain('diamond proof');
    const parent = await listing('test');
    expect(parent.entries[0]).toMatchObject({ name: 'proofs', path: 'test/proofs', kind: 'dir' });
    const files = await listing(parent.entries[0]!.path);
    expect(files.entries[0]!.path).toBe('test/proofs/diamond.js');
    expect(await read.execute({ path: files.entries[0]!.path })).toEqual({
      path: 'test/proofs/diamond.js', content: 'diamond proof',
    });
  });

  it('returns reusable paths at the root and through normalized subdirectories', async () => {
    expect((await listing()).entries[0]).toMatchObject({ name: 'test', path: 'test' });
    expect((await listing('./test/../test/proofs/')).entries[0]!.path).toBe('test/proofs/diamond.js');
    await listing('test/proofs');
    await expect(readFileTool({ sandbox }).execute({ path: 'diamond.js' })).rejects.toThrow('ENOENT');
  });

  it('reads a real repeated directory literally instead of deduplicating it', async () => {
    mkdirSync(join(root, 'test/test/proofs'), { recursive: true });
    writeFileSync(join(root, 'test/test/proofs/diamond.js'), 'different proof');
    expect(await readFileTool({ sandbox }).execute({ path: 'test/test/proofs/diamond.js' }))
      .toMatchObject({ content: 'different proof' });
  });

  it('bounds hints, preserves unusual names, and reports omitted entries', async () => {
    const unusual = 'a"\nname.js';
    writeFileSync(join(root, unusual), 'literal');
    for (let i = 0; i < 30; i++) writeFileSync(join(root, `file-${i}.js`), '');
    const error = await readFileTool({ sandbox }).execute({ path: 'absent/deep/file.js' })
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('"truncated":true');
    expect((error as Error).message.length).toBeLessThan(4000);
    const file = (await listing()).entries.find((e) => e.name === unusual)!;
    expect(await readFileTool({ sandbox }).execute({ path: file.path })).toMatchObject({ content: 'literal' });
  });

  it('keeps symlinks opaque and refuses reads through an outside link', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'atoma-outside-'));
    try {
      writeFileSync(join(outside, 'secret.js'), 'must not read');
      symlinkSync(outside, join(root, 'outside'));
      symlinkSync(join(root, 'missing-target'), join(root, 'dangling'));
      const entries = (await listing()).entries;
      expect(entries.find((e) => e.name === 'outside')).toMatchObject({ path: 'outside', kind: 'symlink' });
      expect(entries.find((e) => e.name === 'dangling')).toMatchObject({ path: 'dangling', kind: 'symlink' });
      await expect(readFileTool({ sandbox }).execute({ path: 'outside/missing.js' })).rejects.toThrow(/escapes sandbox/);
      await expect(readFileTool({ sandbox }).execute({ path: 'dangling' })).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not turn invalid arguments, directory reads or traversal into missing-file guidance', async () => {
    const read = readFileTool({ sandbox });
    await expect(read.execute({ path: '' })).rejects.toThrow(/non-empty/);
    await expect(read.execute({ path: '../secret.js' })).rejects.toThrow(/escapes sandbox/);
    await expect(read.execute({ path: 'test' })).rejects.toThrow(/EISDIR/);
  });
});
