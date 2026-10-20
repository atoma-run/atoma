import path from 'node:path';
import type { ToolExecutor } from '../core/types.js';
import { FILE_OBSERVATION_ONLY_ARG } from '../contracts/toolOutput.js';
import { relativeSpecifiers, resolutionCandidates } from './parentSuiteCheck.js';
import type { SuiteFacts } from './parentSuiteFacts.js';

const MAX_FILES = 6;
const MAX_DIRECTORIES = 120;
const CODE = /\.[cm]?[jt]sx?$/;

/**
 * Current source behind suite imports, including relative dependency edges.
 * An entrypoint can be only a CommonJS forwarder into compiled output: reading
 * it alone says nothing about the response fields or export columns it serves.
 * Breadth-first, direct imports first, under the existing six-file read cap.
 * Never execute a module, infer missing build output, or leave the suite copy.
 */
export async function suiteSourceFiles(facts: readonly SuiteFacts[], tools: ToolExecutor, signal?: AbortSignal):
  Promise<{ paths: string[]; tools: ToolExecutor; omitted: boolean }> {
  const reads = new Map<string, Promise<unknown>>();
  const cached: ToolExecutor = {
    has: name => tools.has(name),
    execute: (name, args) => {
      if (name !== 'read_file' || args[FILE_OBSERVATION_ONLY_ARG] !== true || typeof args['path'] !== 'string') {
        return tools.execute(name, args);
      }
      const file = args['path'];
      let read = reads.get(file);
      if (!read) {
        read = tools.execute(name, args);
        reads.set(file, read);
      }
      return read;
    },
  };
  const queue = facts.flatMap(fact => fact.imports.flatMap(item =>
    item.status === 'exists' && item.target && CODE.test(item.target)
      ? [{ file: item.target, cwd: fact.cwd.replace(/\/+$/, '') || '.' }] : []));
  const paths: string[] = [];
  const walked = new Set<string>();
  const listings = new Map<string, Promise<ReadonlySet<string>>>();
  let omitted = false;
  const filesAt = (directory: string): Promise<ReadonlySet<string>> => {
    let listing = listings.get(directory);
    if (!listing) {
      if (listings.size >= MAX_DIRECTORIES) throw new Error('source listing bound');
      listing = tools.execute('list_files', { path: directory }).then(result => {
        const entries = (result as { entries?: Array<{ name?: string; kind?: string }> } | null)?.entries ?? [];
        return new Set(entries.filter(entry => entry.kind === 'file' || entry.kind === 'symlink').map(entry => entry.name ?? ''));
      });
      listings.set(directory, listing);
    }
    return listing;
  };
  for (let index = 0; index < queue.length; index++) {
    if (signal?.aborted) { omitted = true; break; }
    const { file, cwd } = queue[index]!;
    const key = JSON.stringify([file, cwd]);
    if (walked.has(key)) continue;
    walked.add(key);
    if (!paths.includes(file)) {
      if (paths.length >= MAX_FILES) { omitted = true; continue; }
      paths.push(file);
    }
    let content: unknown;
    try {
      const result = await cached.execute('read_file', { path: file, [FILE_OBSERVATION_ONLY_ARG]: true });
      content = typeof result === 'string' ? result : (result as { content?: unknown } | null)?.content;
    } catch { omitted = true; continue; }
    if (typeof content !== 'string') { omitted = true; continue; }
    for (const specifier of relativeSpecifiers(content, file)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.replace(/[?#].*$/, '')));
      if (target === '..' || target.startsWith('../') || (cwd !== '.' && !target.startsWith(`${cwd}/`)) ||
          target.split('/').some(part => part === 'node_modules' || part === '.git' || part.startsWith('.atoma'))) continue;
      try {
        let found = false;
        for (const candidate of resolutionCandidates(target)) {
          const entries = await filesAt(path.posix.dirname(candidate));
          if (!entries.has(path.posix.basename(candidate))) continue;
          if (CODE.test(candidate)) queue.push({ file: candidate, cwd });
          found = true;
          break;
        }
        if (!found) omitted = true;
      } catch { omitted = true; }
    }
  }
  return { paths, tools: cached, omitted };
}
