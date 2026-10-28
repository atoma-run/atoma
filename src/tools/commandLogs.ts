import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { archiveToolEvidence } from '../core/evidenceArchive.js';
import type { CapturedCommandLogs } from '../contracts/evidenceReading.js';

export const COMMAND_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const COMMAND_LOG_MAX_FILES = 32;
const MAX_ENCODED_BYTES = 4 * 1024 * 1024;
const MAX_LISTED_FILES = 256;
const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Only the worker enables this on its private /tmp, never a host's shared temp directory. */
export function commandLogSnapshot(directory: string): Map<string, string> {
  const state = new Map<string, string>();
  try {
    for (const name of readdirSync(directory)) if (name.endsWith('.log')) {
      try { state.set(name, identity(lstatSync(join(directory, name)))); } catch { /* capture reports unavailable files */ }
    }
  } catch { /* capture reports an unavailable directory */ }
  return state;
}

/** Snapshot changed top-level .log files before the worker/container can disappear. */
export function captureCommandLogs(directory: string, before: ReadonlyMap<string, string>): CapturedCommandLogs {
  const result: CapturedCommandLogs = { directory, files: [], omitted: [] };
  let remaining = COMMAND_LOG_MAX_BYTES;
  let encodedRemaining = MAX_ENCODED_BYTES;
  let names: string[];
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error('Unsafe log directory');
    names = readdirSync(directory).filter(name => name.endsWith('.log')).sort();
  }
  catch { result.omitted.push({ path: directory, reason: 'Log directory unavailable' }); return result; }
  const present = new Set(names);
  for (const name of [...before.keys()].slice(0, MAX_LISTED_FILES)) if (!present.has(name)) result.omitted.push({ path: join(directory, name), reason: 'Log removed during command; current contents unavailable' });
  if (names.length > MAX_LISTED_FILES) {
    result.omitted.push({ path: directory, reason: `${names.length - MAX_LISTED_FILES} log paths beyond capture inventory bound; files not retained` });
    names = names.slice(0, MAX_LISTED_FILES);
  }
  for (const name of names) {
    const path = join(directory, name);
    let fd: number | undefined;
    try {
      const stated = lstatSync(path);
      if (before.get(name) === identity(stated)) continue;
      if (!stated.isFile() || stated.nlink !== 1) throw new Error('Not a single-link regular file');
      if (result.files.length >= COMMAND_LOG_MAX_FILES || stated.size > remaining) throw new Error('Log capture resource bound exceeded; file not retained');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== identity(stated)) throw new Error('Log changed before capture');
      // Bound reads even if an escaped writer grows a file after stat.
      const bytes = Buffer.alloc(opened.size);
      const count = readFileSyncBounded(fd, bytes);
      if (count !== opened.size || identity(fstatSync(fd)) !== identity(opened)) throw new Error('Log changed during capture');
      if (!isUtf8(bytes)) throw new Error('Log is not UTF-8 text; file not retained');
      const evidence = archiveToolEvidence({ path }, { content: bytes.toString('utf8') });
      if (evidence.data.length > encodedRemaining) throw new Error('Encoded log capture resource bound exceeded; file not retained');
      result.files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), evidence });
      remaining -= bytes.length;
      encodedRemaining -= evidence.data.length;
    } catch (error) {
      const reason = error instanceof Error && !('code' in error) ? error.message : 'Log unavailable or unsafe to read';
      result.omitted.push({ path, reason });
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return result;
}

// readFileSync(fd) is unbounded when another process appends to a regular file.
function readFileSyncBounded(fd: number, bytes: Buffer): number {
  let offset = 0;
  while (offset < bytes.length) {
    const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!n) break;
    offset += n;
  }
  return offset;
}
