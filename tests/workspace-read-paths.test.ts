import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFilesTool, readFileTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { pathHeldNoFile } from '../src/contracts/toolOutput.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { AttemptDigest } from '../src/atoms/attemptDigest.js';
import type { ToolExecutor } from '../src/core/types.js';
import { toolInvocationSucceeded } from '../src/atoms/validationLedger.js';
import { buildResultGateEnv } from '../src/atoms/resultGates.js';
import { makeCtx } from './helpers.js';

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
    const absent = await read.execute({ path: 'test/test/proofs/diamond.js' });
    expect(absent).toMatchObject({
      path: 'test/test/proofs/diamond.js', exists: false,
      nearest: { path: 'test', entries: [{ name: 'proofs', path: 'test/proofs', kind: 'dir' }] },
    });
    expect(absent).not.toHaveProperty('content');
    expect(JSON.stringify(absent)).not.toContain('diamond proof');
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
    expect(await readFileTool({ sandbox }).execute({ path: 'diamond.js' }))
      .toMatchObject({ path: 'diamond.js', exists: false, nearest: { path: '.' } });
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
    const absent = await readFileTool({ sandbox }).execute({ path: 'absent/deep/file.js' });
    expect(absent).toMatchObject({ exists: false, nearest: { path: '.', truncated: true } });
    expect(JSON.stringify(absent).length).toBeLessThan(4000);
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
      expect(await readFileTool({ sandbox }).execute({ path: 'dangling' })).toMatchObject({ path: 'dangling', exists: false });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not turn invalid arguments or traversal into missing-file guidance', async () => {
    const read = readFileTool({ sandbox });
    await expect(read.execute({ path: '' })).rejects.toThrow(/non-empty/);
    await expect(read.execute({ path: '../secret.js' })).rejects.toThrow(/escapes sandbox/);
    await expect(read.execute({ path: 'test/proofs/diamond.js/x' })).rejects.toThrow(/ENOTDIR/);
    await expect(listFilesTool({ sandbox }).execute({ path: 'test/proofs/diamond.js' })).rejects.toThrow(/ENOTDIR/);
  });

  it('answers a directory read with its entries (runs 9bcf5514, bf5ea48f read `tests` in an opening burst)', async () => {
    const answer = await readFileTool({ sandbox }).execute({ path: 'test' });
    expect(answer).toMatchObject({ path: 'test', kind: 'dir', entries: [{ name: 'proofs', path: 'test/proofs', kind: 'dir' }], truncated: false });
    expect(answer).not.toHaveProperty('content');
    expect(pathHeldNoFile(answer)).toBe(true);
  });

  it('answers an output the task names before it is written, then reads it once written (run 351b224a)', async () => {
    mkdirSync(join(root, 'evidence'));
    writeFileSync(join(root, 'evidence/access.json'), '{}');
    const read = readFileTool({ sandbox });
    const before = await read.execute({ path: 'evidence/xe-responses.jsonl' });
    expect(before).toMatchObject({
      path: 'evidence/xe-responses.jsonl', exists: false,
      nearest: { path: 'evidence', entries: [{ path: 'evidence/access.json' }], truncated: false },
    });
    expect((before as { note: string }).note).toMatch(/does not exist until you write it/);
    expect(pathHeldNoFile(before)).toBe(true);
    expect(await listing('evidence/raw')).toMatchObject({ path: 'evidence/raw', exists: false, entries: [], nearest: { path: 'evidence' } });
    writeFileSync(join(root, 'evidence/xe-responses.jsonl'), '{"url":"x"}\n');
    const after = await read.execute({ path: 'evidence/xe-responses.jsonl' });
    expect(after).toEqual({ path: 'evidence/xe-responses.jsonl', content: '{"url":"x"}\n' });
    expect(pathHeldNoFile(after)).toBe(false);
  });

  it('keeps a no-file answer out of attested evidence and of the files a retry is told it read', async () => {
    const tool = readFileTool({ sandbox });
    const base: ToolExecutor = { has: (name) => name === 'read_file', execute: (_name, args) => tool.execute(args) };
    const log = createAttestationLog();
    const attested = attestingExecutor(base, log, 'b')!;
    await attested.execute('read_file', { path: 'missing.txt' });
    await attested.execute('read_file', { path: 'test' });
    expect(log.size).toBe(0);
    await attested.execute('read_file', { path: 'test/proofs/diamond.js' });
    expect(log.forBranch('b').map((r) => r.tool)).toEqual(['read_file']);
    const digest = new AttemptDigest();
    for (const path of ['missing.txt', 'test', 'test/proofs/diamond.js']) {
      digest.observe({ name: 'read_file', args: { path }, result: await tool.execute({ path }), durationMs: 1, startedAt: 1 });
    }
    expect(digest.render('r')).toContain('- files read: test/proofs/diamond.js\n');
  });

  it('reads an absent path or a directory as unreadable at the result gates, never as empty content', async () => {
    const tools = { read_file: readFileTool({ sandbox }) };
    const exec: ToolExecutor = { has: (name) => name in tools, execute: (_name, args) => tools.read_file.execute(args) };
    const env = buildResultGateEnv({ task: { description: 'x' }, result: { output: null, summary: 's', trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } },
      ctx: { ...makeCtx(), tools: exec }, childName: 'leaf', childToolNames: ['read_file'] });
    expect(await env.readWorkspaceFile('README.md')).toEqual({ status: 'unreadable' });
    expect(await env.readWorkspaceFile('test')).toEqual({ status: 'unreadable' });
    expect(await env.readWorkspaceFile('test/proofs/diamond.js')).toEqual({ status: 'ok', content: 'diamond proof' });
  });

  it('counts a no-file answer as no tool action, as the throw it replaced did (observed-tool-action gate)', async () => {
    const info = (name: string, result: unknown) => ({ name, args: {}, result, durationMs: 1, startedAt: 1 });
    expect(toolInvocationSucceeded(info('read_file', await readFileTool({ sandbox }).execute({ path: 'missing.txt' })))).toBe(false);
    expect(toolInvocationSucceeded(info('read_file', await readFileTool({ sandbox }).execute({ path: 'test' })))).toBe(false);
    expect(toolInvocationSucceeded(info('list_files', await listing('out')))).toBe(false);
    expect(toolInvocationSucceeded(info('read_file', await readFileTool({ sandbox }).execute({ path: 'test/proofs/diamond.js' })))).toBe(true);
    expect(toolInvocationSucceeded(info('list_files', await listing('test')))).toBe(true);
  });
});
