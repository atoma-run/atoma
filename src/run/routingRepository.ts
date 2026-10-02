import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutingRepository } from '../contracts/tissueRouting.js';

const MAX_ENTRIES = 160;
const MAX_DEPTH = 2;
const MAX_EXCERPTS = 6;
const EXCERPT_BYTES = 1400;
const OMIT_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', '__pycache__']);
const CONTEXT_FILES = /^(?:readme(?:\.(?:md|rst|txt))?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements\.txt|composer\.json)$/i;

/**
 * Read the untouched, imported workspace before tools start. No Git command,
 * package script, hidden file, link or special file is executed or followed.
 * Omitted/unreadable content is explicit: an excerpt cannot prove absence.
 */
export function readRoutingRepository(workspaceRoot: string): RoutingRepository {
  const result: RoutingRepository = { files: [], excerpts: [], incomplete: false };
  const pending = [{ relative: '', depth: 0 }];
  let root: string;
  try { root = realpathSync(workspaceRoot); } catch { return { ...result, incomplete: true }; }
  let visited = 0;
  while (pending.length && visited < MAX_ENTRIES) {
    const next = pending.shift()!;
    const directory = join(root, next.relative);
    try {
      if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) {
        result.incomplete = true;
        continue;
      }
      const dir = opendirSync(directory);
      try {
        let entry;
        while ((entry = dir.readSync()) !== null) {
          if (++visited > MAX_ENTRIES) { result.incomplete = true; break; }
          if (entry.name.startsWith('.') || OMIT_DIRECTORIES.has(entry.name)) continue;
          const relative = next.relative ? `${next.relative}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) { result.incomplete = true; continue; }
          if (entry.isDirectory()) {
            result.files.push(`${relative}/`);
            if (next.depth < MAX_DEPTH) pending.push({ relative, depth: next.depth + 1 });
            else result.incomplete = true;
          } else if (entry.isFile()) {
            result.files.push(relative);
            if (!CONTEXT_FILES.test(entry.name)) continue;
            if (result.excerpts.length >= MAX_EXCERPTS) { result.incomplete = true; continue; }
            const path = join(root, relative);
            let fd: number | undefined;
            try {
              if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) { result.incomplete = true; continue; }
              fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
              const stat = fstatSync(fd);
              if (!stat.isFile()) { result.incomplete = true; continue; }
              const buffer = Buffer.alloc(EXCERPT_BYTES);
              const bytes = readSync(fd, buffer, 0, buffer.length, 0);
              const text = buffer.subarray(0, bytes).toString('utf8');
              if (text.includes('\0')) { result.incomplete = true; continue; }
              const truncated = stat.size > bytes;
              result.excerpts.push({ path: relative, text, truncated });
              result.incomplete ||= truncated;
            } catch { result.incomplete = true; }
            finally { if (fd !== undefined) closeSync(fd); }
          }
        }
      } finally { dir.closeSync(); }
    } catch { result.incomplete = true; }
  }
  result.incomplete ||= pending.length > 0;
  result.files.sort();
  return result;
}
