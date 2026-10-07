import path from 'node:path';
import { readdir, lstat, mkdir, link, copyFile, readlink, symlink, unlink, rmdir, writeFile } from 'node:fs/promises';
import { buildWorkspaceArtifactManifest, normalizeArtifactPath } from './artifacts.js';
import { gitBlobSha, repositoryFile } from './repositorySync.js';
import type { RepositoryInventory } from '../contracts/repositorySync.js';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';

/** Copy the lineage without ever writing through a shared inode. */
export async function materialiseRepositorySeed(input: {
  source: string; destination: string; take: readonly string[]; theirs: RepositoryInventory;
  blob: (sha: string, signal: AbortSignal) => Promise<Buffer>; signal: AbortSignal;
}): Promise<void> {
  const copy = async (source: string, destination: string): Promise<void> => {
    input.signal.throwIfAborted();
    const stat = await lstat(source);
    if (stat.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: stat.mode });
      for (const name of await readdir(source)) await copy(path.join(source, name), path.join(destination, name));
    } else if (stat.isSymbolicLink()) await symlink(await readlink(source), destination);
    else if (stat.isFile()) {
      try { await link(source, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await copyFile(source, destination);
      }
    } else throw new Error('Unsupported seed entry');
  };
  await copy(input.source, input.destination);
  // All removals precede additions, so a directory can become a file and vice versa.
  for (const p of [...input.take].sort((a, b) => b.length - a.length)) {
    input.signal.throwIfAborted();
    const target = path.join(input.destination, normalizeArtifactPath(p));
    try {
      const stat = await lstat(target);
      if (stat.isDirectory()) await rmdir(target); // Never remove excluded descendants.
      else await unlink(target);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    let parent = path.dirname(target);
    while (parent !== input.destination) {
      try { await rmdir(parent); } catch { break; }
      parent = path.dirname(parent);
    }
  }
  let total = 0, cursor = 0;
  const files = input.take.filter(p => repositoryFile(input.theirs, p));
  if (files.length > WORKSPACE_LIMITS.maxFiles) throw new Error('Repository exceeds file limit');
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const readers = Array.from({ length: Math.min(8, files.length) }, async () => {
    try {
      while (cursor < files.length) {
        signal.throwIfAborted();
        const p = files[cursor++]!;
        const state = repositoryFile(input.theirs, p)!;
        const content = await input.blob(state.sha, signal);
        signal.throwIfAborted();
        total += content.length;
        if (content.length > WORKSPACE_LIMITS.maxFileBytes || total > WORKSPACE_LIMITS.maxTotalBytes || gitBlobSha(content) !== state.sha) throw new Error('Repository blob integrity or size failure');
        const target = path.join(input.destination, p);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { flag: 'wx', mode: state.mode === '100755' ? 0o755 : 0o644 });
      }
    } catch (error) { controller.abort(error); throw error; }
  });
  await Promise.allSettled(readers);
  if (signal.aborted) throw signal.reason;
  buildWorkspaceArtifactManifest({ workspaceRoot: input.destination });
}
