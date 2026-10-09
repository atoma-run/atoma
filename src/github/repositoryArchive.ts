import { createHash } from 'node:crypto';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import type { GitHubPublishFile } from './client.js';

export interface ArchiveFile {
  path: string; sha: string; mode: '100644' | '100755'; size?: number;
}

/** Skip excluded bytes without inflating or buffering their compressed body. */
class SkipStored {
  static compression = 0;
  ondata: UnzipPassThrough['ondata'] = () => {};
  push(_bytes: Uint8Array, final: boolean): void { this.ondata(null, new Uint8Array(), final); }
}
class SkipDeflated extends SkipStored { static override compression = 8; }
class ArchiveReadError extends Error {}
/** The transport's own budget ran out — often on bytes or entries an
 * `.atoma-import.json` exclusion leaves out, which a zipball cannot skip
 * before download. Not a repository failure: stop reading and let the caller
 * fetch whatever is still missing as immutable blobs. */
class ArchiveBudgetExhausted extends Error {}

/** An archive is a transport, never authority: only git-verified regular files
 * enter the workspace. Git export-ignore/export-subst omissions fall back to
 * immutable blobs at the caller, and so does everything still unread when the
 * archive exceeds its entry or download budget. No zip path is ever passed to a filesystem API.
 */
export async function readRepositoryArchive(input: {
  body: ReadableStream<Uint8Array>; files: readonly ArchiveFile[]; signal: AbortSignal;
  onFile: (file: GitHubPublishFile) => Promise<void>;
}): Promise<Set<string>> {
  const expected = new Map(input.files.map(f => [f.path, f]));
  const completed = new Set<string>(), seen = new Set<string>();
  const ready: GitHubPublishFile[] = [];
  let root: string | undefined, entries = 0, expanded = 0;
  const zip = new Unzip(file => {
    if (++entries > WORKSPACE_LIMITS.maxEntries + 1) throw new ArchiveBudgetExhausted();
    const parts = file.name.split('/');
    if (file.name.length > 4608 || file.name.includes('\\') || parts.some((p, i) =>
      p === '.' || p === '..' || p.includes('\0') || (!p && i !== parts.length - 1)) || !parts[0]) {
      throw new ArchiveReadError('Repository archive contains an unsafe path');
    }
    root ??= parts[0];
    if (root !== parts[0]) throw new ArchiveReadError('Repository archive has multiple roots');
    const name = parts.slice(1).join('/');
    if (seen.has(name)) throw new ArchiveReadError('Repository archive contains duplicate paths');
    seen.add(name);
    const target = expected.get(name);
    if (file.compression !== 0 && file.compression !== 8) throw new ArchiveReadError('Unsupported repository archive compression');
    zip.register(target ? (file.compression === 8 ? UnzipInflate : UnzipPassThrough)
      : (file.compression === 8 ? SkipDeflated : SkipStored));
    let size = 0;
    let failure: Error | undefined;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, bytes, final) => {
      if (error) throw failure ?? new ArchiveReadError('Repository archive is invalid');
      if (!target) return;
      size += bytes.length;
      expanded += bytes.length;
      if (size > WORKSPACE_LIMITS.maxFileBytes || expanded > WORKSPACE_LIMITS.maxTotalBytes) {
        failure = new ArchiveReadError('Repository archive exceeds the workspace byte limit');
        throw failure;
      }
      chunks.push(bytes);
      if (final) {
        const content = Buffer.concat(chunks, size);
        const hash = createHash('sha1').update(`blob ${size}\0`).update(content).digest('hex');
        if (hash === target.sha && (target.size === undefined || size === target.size)) {
          completed.add(name);
          ready.push({ path: name, mode: target.mode, content });
        }
      }
    };
    file.start();
  });
  const reader = input.body.getReader();
  let compressed = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      input.signal.throwIfAborted();
      const next = await reader.read();
      input.signal.throwIfAborted();
      if (next.done) break;
      compressed += next.value.length;
      if (compressed > WORKSPACE_LIMITS.maxTotalBytes * 2) throw new ArchiveBudgetExhausted();
      // Bound decoder output and backpressure: never retain the whole archive.
      for (let offset = 0; offset < next.value.length; offset += 16_384) {
        input.signal.throwIfAborted();
        zip.push(next.value.subarray(offset, offset + 16_384), false);
        while (ready.length) await input.onFile(ready.shift()!);
      }
    }
    zip.push(new Uint8Array(), true);
    while (ready.length) await input.onFile(ready.shift()!);
    if (!root) throw new ArchiveReadError('Repository archive is empty');
    return completed;
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof ArchiveBudgetExhausted) {
      // Files verified before the budget ran out are kept; the rest are blobs.
      while (ready.length) await input.onFile(ready.shift()!);
      return completed;
    }
    if (error instanceof ArchiveReadError) throw error;
    // Transport errors may carry a signed URL. Never persist those in a run.
    throw new Error('Repository archive could not be read');
  } finally {
    input.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
