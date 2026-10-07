import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { readRepositoryArchive } from '../src/github/repositoryArchive.js';
import { GitHubAppClient } from '../src/github/client.js';
import { gitBlobSha } from '../src/projects/repositorySync.js';
import { WORKSPACE_LIMITS } from '../src/contracts/workspaceLimits.js';
import { FakeGitHub } from './github-api-fake.js';

const source = (entries: Record<string, Uint8Array>) => new Response(Buffer.from(zipSync(entries))).body!;
const file = (path: string, text: string) => ({ path, sha: gitBlobSha(Buffer.from(text)), mode: '100644' as const, size: Buffer.byteLength(text) });
const signal = () => new AbortController().signal;
const urlString = (url: RequestInfo | URL) => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

describe('verified streaming repository archives', () => {
  it('writes only selected git-verified content, ignores bulky exclusions, and leaves export substitutions for blob fallback', async () => {
    const onFile = vi.fn(async () => {});
    const completed = await readRepositoryArchive({ body: source({ 'snapshot/keep.js': Buffer.from('source'),
      'snapshot/exported.txt': Buffer.from('git substituted this'),
      'snapshot/excluded/big.bin': new Uint8Array(WORKSPACE_LIMITS.maxFileBytes + 1) }),
    files: [file('keep.js', 'source'), file('exported.txt', '$Format:%H$'), file('export-ignored.txt', 'missing')],
    signal: signal(), onFile });
    expect([...completed]).toEqual(['keep.js']);
    expect(onFile).toHaveBeenCalledExactlyOnceWith({ path: 'keep.js', mode: '100644', content: Buffer.from('source') });
  });

  it.each(['snapshot/../escape', '/absolute', 'snapshot/a\\b', 'snapshot//empty'])('rejects archive path %s', async path => {
    await expect(readRepositoryArchive({ body: source({ [path]: Buffer.from('x') }), files: [],
      signal: signal(), onFile: async () => {} })).rejects.toThrow(/unsafe path/);
  });

  it('bounds expansion even if a zip lies about its selected file size', async () => {
    await expect(readRepositoryArchive({ body: source({ 'snapshot/large.txt': new Uint8Array(WORKSPACE_LIMITS.maxFileBytes + 1) }),
      files: [file('large.txt', 'small')], signal: signal(), onFile: async () => {} })).rejects.toThrow(/byte limit/);
  });

  it('cancels a pending stream when preparation is aborted', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = readRepositoryArchive({ body: new ReadableStream({ cancel }), files: [], signal: controller.signal, onFile: async () => {} });
    controller.abort(new Error('Preparation cancelled'));
    await expect(pending).rejects.toThrow('Preparation cancelled');
    expect(cancel).toHaveBeenCalled();
  });

  it('does not expose signed URLs from a failed stream', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.error(new Error('fetch https://codeload.github.com/repo?token=secret failed'));
    } });
    await expect(readRepositoryArchive({ body, files: [], signal: signal(), onFile: async () => {} }))
      .rejects.toThrow('Repository archive could not be read');
  });

  it.each(['https://evil.example/secret', 'http://codeload.github.com/repo', 'https://user:secret@codeload.github.com/repo'])('never forwards installation tokens to archive destination %s', async location => {
    const fake = new FakeGitHub({ existing: ['alice/app'] });
    for (let i = 0; i < 129; i++) fake.commitOutside('alice', 'app', 'main', `file-${i}`, 'x');
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (urlString(url).includes('/zipball/')) return new Response(null, { status: 302, headers: { location } });
      return fake.fetch(url, init);
    });
    const client = new GitHubAppClient({ appId: '1', appSlug: 'test', apiBaseUrl: 'https://api.github.com',
      privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }, { fetch });
    await expect(client.readRepositoryFiles({ token: 'installation-secret', owner: 'alice', name: 'app',
      commitSha: fake.refSha('alice', 'app', 'main')!, signal: signal() })).rejects.toThrow('archive could not be downloaded');
    expect(fetch.mock.calls.some(([url]) => urlString(url) === location)).toBe(false);
  });
});
