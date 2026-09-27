import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { editFileTool, readFileTool, writeFileTool } from '../src/tools/builtin.js';

/**
 * Production run f33379a4 (2026-09-27): asked to keep "the existing
 * configurator unchanged", a molecule's FIRST action wrote a home page over
 * the 13394-byte index.html that held it. write_file now refuses to overwrite
 * work from before the run that nothing in the run has read.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tools() {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-guard-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'index.html'), '<title>Configurator</title>');
  writeFileSync(join(dir, 'empty.txt'), '');
  mkdirSync(join(dir, '.atoma-scratch'));
  writeFileSync(join(dir, '.atoma-scratch', 'probe.csv'), 'a,b');
  const sandbox = new ToolSandbox(dir);
  return { dir, write: writeFileTool({ sandbox }), read: readFileTool({ sandbox }), edit: editFileTool({ sandbox }) };
}

describe('write_file over work from before the run', () => {
  it('refuses to overwrite an existing file nothing in the run has read, and writes nothing', async () => {
    const { dir, write } = tools();
    await expect(write.execute({ path: 'index.html', content: '<h1>Home</h1>' }))
      .rejects.toThrow(/already exists \(27 bytes\) and nothing in this run has read it.*read_file it first/);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<title>Configurator</title>');
  });

  it('writes it once the run has read it, or edited it', async () => {
    const { dir, write, read } = tools();
    await read.execute({ path: './index.html' });
    await expect(write.execute({ path: 'index.html', content: '<h1>Home</h1>' })).resolves.toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<h1>Home</h1>');
    const other = tools();
    await other.edit.execute({ path: 'index.html', old_string: 'Configurator', new_string: 'Quote' });
    await expect(other.write.execute({ path: 'index.html', content: 'x' })).resolves.toMatchObject({ ok: true });
  });

  it('never stands between a run and its own files, empty files or scratch inputs', async () => {
    const { write } = tools();
    await write.execute({ path: 'app.js', content: 'one' });
    await expect(write.execute({ path: 'app.js', content: 'two' })).resolves.toMatchObject({ ok: true });
    await expect(write.execute({ path: 'empty.txt', content: 'now full' })).resolves.toMatchObject({ ok: true });
    await expect(write.execute({ path: '.atoma-scratch/probe.csv', content: 'c,d' })).resolves.toMatchObject({ ok: true });
  });
});
