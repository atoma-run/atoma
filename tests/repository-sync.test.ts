import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobSha, planRepositorySync, repositoryDebt } from '../src/projects/repositorySync.js';
import { materialiseRepositorySeed } from '../src/projects/repositorySeed.js';
import type { RepositoryInventory } from '../src/contracts/repositorySync.js';
const file = (text: string) => ({ mode: '100644' as const, sha: gitBlobSha(Buffer.from(text)) });
const state = (text?: string): RepositoryInventory => text === undefined ? {} : { 'app.js': file(text) };

it.each([
  ['remote edit', 'x', 'x', 'remote', false, ['app.js'], [], []],
  ['pending work', 'x', 'ours', 'x', false, [], ['app.js'], []],
  ['converged', 'x', 'ours', 'ours', false, [], [], []],
  ['conflict', 'x', 'ours', 'remote', false, ['app.js'], [], ['app.js']],
  ['remote deletion', 'x', 'ours', undefined, false, ['app.js'], [], ['app.js']],
  ['published revert', 'x', 'ours', 'x', true, ['app.js'], [], []],
  ['tombstone', 'x', undefined, 'x', true, [], [], []],
  ['changed tombstone', 'x', undefined, 'remote', true, ['app.js'], [], ['app.js']],
] as const)('%s', (_name, b, o, t, published, take, write, conflicts) => {
  const base = state(b), ours = state(o), theirs = state(t);
  expect(planRepositorySync({ base, ours, theirs, debt: repositoryDebt(base, ours, published) }))
    .toEqual({ take, write, conflicts });
});

it('publishes work built on a remote edit after a partial run', () => {
  const base = state('remote v1'), ours = state('remote v2');
  expect(planRepositorySync({ base, ours, theirs: state('remote v1'), debt: repositoryDebt(base, ours, false) }).write).toEqual(['app.js']);
});
it('refuses case aliases across directory ancestors', () => {
  expect(() => planRepositorySync({ base: {}, ours: { 'Lib/a': file('a') }, theirs: { 'lib/b': file('b') }, debt: new Set() })).toThrow(/conflicting/);
});
it('remote file and directory replacements win', () => {
  const ours = { lib: file('ours'), 'foo/a': file('a') }, theirs = { 'lib/b': file('b'), foo: file('remote') };
  expect(planRepositorySync({ base: {}, ours, theirs, debt: new Set(Object.keys(ours)) })).toEqual({
    take: ['lib', 'foo/a', 'lib/b', 'foo'], write: [], conflicts: ['lib', 'foo/a'],
  });
});
it('does not replace a remote symlink with a regular file', () => {
  expect(planRepositorySync({ base: {}, ours: state('ours'), theirs: {}, debt: new Set(['app.js']),
    remoteEntries: [{ path: 'app.js', type: 'blob', mode: '120000', sha: file('target').sha }] }))
    .toEqual({ take: ['app.js'], write: [], conflicts: ['app.js'] });
});
describe('materialised seed', () => {
  it('replaces shared files by unlink and preserves the previous run, including excluded records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repository-seed-'));
    try {
      const source = join(root, 'source'), destination = join(root, 'seed');
      await mkdir(source);
      await writeFile(join(source, 'app.js'), 'ours');
      await writeFile(join(source, 'keep.txt'), 'keep');
      await writeFile(join(source, '.atoma-probes.json'), 'trusted');
      await materialiseRepositorySeed({ source, destination, take: ['app.js'], theirs: state('remote'),
        blob: async () => Buffer.from('remote'), signal: new AbortController().signal });
      expect(await readFile(join(source, 'app.js'), 'utf8')).toBe('ours');
      expect(await readFile(join(destination, 'app.js'), 'utf8')).toBe('remote');
      expect((await stat(join(source, 'keep.txt'))).ino).toBe((await stat(join(destination, 'keep.txt'))).ino);
      expect(await readFile(join(destination, '.atoma-probes.json'), 'utf8')).toBe('trusted');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it('treats prototype names as ordinary repository paths', () => {
  const ours = { constructor: file('new') };
  expect(planRepositorySync({ base: {}, ours, theirs: {}, debt: repositoryDebt({}, ours, false) }).write).toEqual(['constructor']);
});
it('publishes executable-mode changes with identical bytes', () => {
  const base = state('same'), ours = { 'app.js': { ...file('same'), mode: '100755' as const } };
  expect(planRepositorySync({ base, ours, theirs: base, debt: repositoryDebt(base, ours, false) }).write).toEqual(['app.js']);
});
