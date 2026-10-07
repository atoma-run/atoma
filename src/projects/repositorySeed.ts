import path from 'node:path';
import { readdir, lstat, mkdir, link, copyFile, readlink, symlink, unlink, rmdir, writeFile } from 'node:fs/promises';
import { buildWorkspaceArtifactManifest, normalizeArtifactPath } from './artifacts.js';
import { gitBlobSha, repositoryFile } from './repositorySync.js';
import type { RepositoryInventory } from '../contracts/repositorySync.js';

/** Copy the lineage without ever writing through a shared inode. */
export async function materialiseRepositorySeed(input: {
  source: string; destination: string; take: readonly string[]; theirs: RepositoryInventory;
  blob: (sha: string) => Promise<Buffer>; signal: AbortSignal;
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
  let total = 0;
  if (input.take.filter(p => repositoryFile(input.theirs, p)).length > 256) throw new Error('Repository exceeds file limit');
  for (const p of input.take) {
    const state = repositoryFile(input.theirs, p);
    if (!state) continue;
    input.signal.throwIfAborted();
    const content = await input.blob(state.sha);
    input.signal.throwIfAborted();
    total += content.length;
    if (total > 50 * 1024 * 1024 || gitBlobSha(content) !== state.sha) throw new Error('Repository blob integrity or size failure');
    const target = path.join(input.destination, p);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: state.mode === '100755' ? 0o755 : 0o644 });
  }
  buildWorkspaceArtifactManifest({ workspaceRoot: input.destination });
}
