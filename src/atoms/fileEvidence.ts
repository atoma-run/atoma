import type { RunContext } from '../core/types.js';
import { posix } from 'node:path';
import { baseExecutorOf } from '../core/attestation.js';
import type { AcceptanceChecklist } from '../contracts/acceptanceChecklist.js';
import { PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';

const NAMED_PATH = /(?<![\w./-])(\.?[\w-][\w.-]+(?:\/[\w.-]+)*\.(?:md|markdown|txt|html?|css|m?js|cjs|ts|json|csv|py|sh|ya?ml))(?![\w/-])/gi;
const CRITERIA_FILES_MAX = 16;
/** A phase judge's read-back budget; root acceptance passes `ROOT_CRITERIA_SOURCE_CHARS`. */
export const CRITERIA_SOURCE_CHARS = 24_000;
/**
 * Root acceptance reads twice as much: it is one call per pass, its refusal
 * costs a whole replan, and three of the eight first refusals measured as cut
 * evidence judged a long page or calendar past 24,000 characters
 * (docs/incidents/first-refusals-2026-10-10.md).
 */
export const ROOT_CRITERIA_SOURCE_CHARS = 48_000;
const CRITERIA_FILE_MATCHED_BLOCKS = 15;
const CRITERIA_BLOCK_LINES = 25;
const CRITERIA_LINE_CHARS = 300;
const CRITERIA_TOKEN = /[a-z][a-z0-9_-]{3,}/g;
const COMMON_WORDS = new Set(['with', 'that', 'this', 'every', 'each', 'from', 'into', 'have', 'shows', 'show', 'must',
  'documents', 'document', 'explains', 'lists', 'links', 'file', 'files', 'example', 'examples', 'readme',
  // On every title of a test file: "test/errors.test.js" would match each one before the one asked for.
  'test', 'tests', 'spec', 'specs']);

/** Test scripts, whose quoted relative paths name the fixtures their assertions load. */
const SCRIPT_PATH = /\.(?:m?js|cjs|ts|py|sh)$/i;
const QUOTED_RELATIVE_PATH = /['"`]((?:\.{1,2}\/)?[\w-][\w.-]*(?:\/[\w.-]+)*\.(?:json|csv|txt|md|ya?ml|html?|ndjson|lock))['"`]/g;
const TEST_SCRIPT = /(?:^|[/._-])(?:tests?|specs?|__tests__)(?:[/._-]|$)/i;
const REFERENCED_FILES_MAX = 4;
const REFERENCED_FILE_CHARS = 3_000;
const REFERENCED_TOTAL_CHARS = 6_000;

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * The line holding a criterion's word and the block it opens: the lines after
 * it indented deeper, blank ones included, and the closer that ends them. A
 * test's title line names the behaviour; its assertions are the lines below
 * it, and a lone title proved nothing (runs f0a51beb, 834ed524, 41e069a6,
 * 2faac5cb: "only the title is visible, its assertion is truncated").
 */
function blockEnd(lines: readonly string[], at: number): number {
  const indent = indentOf(lines[at]!);
  let end = at + 1;
  while (end < lines.length && end - at < CRITERIA_BLOCK_LINES && (lines[end]!.trim() === '' || indentOf(lines[end]!) > indent)) end++;
  if (end < lines.length && end - at < CRITERIA_BLOCK_LINES && /^[\]})]/.test(lines[end]!.trim()) && indentOf(lines[end]!) === indent) end++;
  while (end - 1 > at && lines[end - 1]!.trim() === '') end--;
  return end;
}

/**
 * What of a named file reaches the acceptor: its head, and past it the blocks
 * holding a word of the criteria that name it ("curl", "route", "exit"), so a
 * criterion about a long file is not judged on its first screen only.
 */
function namedFileExcerpt(content: string, words: ReadonlySet<string>, allowance: number, blocksCap: number): string {
  // Keep complete small files: keyword excerpts retain test titles while
  // dropping their fixtures and assertions (warehouse run 22af997d).
  if (content.length <= allowance) return JSON.stringify(content);
  const blocksBudget = Math.min(blocksCap, Math.floor(allowance / 2));
  // One block takes at most a quarter, so an early wide match (a describe(),
  // a wrapping <div>) cannot starve the ones after it.
  const blockChars = Math.floor(blocksBudget / 4);
  const tentativeHead = allowance - blocksBudget;
  const lines = content.split(/\r?\n/);
  // Real offsets: a CRLF file's lines are one character longer than they split.
  const starts = [0];
  for (let at = content.indexOf('\n'); at >= 0 && starts.length < lines.length; at = content.indexOf('\n', at + 1)) starts.push(at + 1);
  let first = 0;
  while (first + 1 < starts.length && starts[first + 1]! <= tentativeHead) first++;
  // The line the head cuts through is searched too: its title may be the one asked for.
  const blocks: string[] = [];
  let used = 0, firstBlockStart = content.length;
  for (let at = first; at < lines.length && blocks.length < CRITERIA_FILE_MATCHED_BLOCKS && used < blocksBudget; at++) {
    if (![...lines[at]!.toLowerCase().matchAll(CRITERIA_TOKEN)].some((match) => words.has(match[0]))) continue;
    const end = blockEnd(lines, at);
    const prefix = `${at + 1}: `;
    const room = Math.min(blockChars, blocksBudget - used) - prefix.length;
    if (room <= 0) break;
    const entry = prefix + lines.slice(at, end).map((line) => line.slice(0, CRITERIA_LINE_CHARS)).join('\n').slice(0, room);
    if (blocks.length === 0) firstBlockStart = starts[at]!;
    blocks.push(entry);
    used += entry.length;
    at = end - 1;
  }
  // The head keeps what the blocks left unused, up to where the first block
  // starts: never the same lines twice.
  const headLength = blocks.length === 0 ? allowance : Math.max(Math.min(allowance - used, firstBlockStart), Math.min(tentativeHead, firstBlockStart));
  const head = content.slice(0, headLength);
  return `${JSON.stringify(head)} …(cut at ${headLength} of ${content.length} chars)` +
    (blocks.length > 0 ? `\n    later blocks naming the criteria's words (line: text): ${JSON.stringify(blocks)}` : '');
}

/**
 * The files the CRITERIA name, read back by the host, so a criterion about a
 * document is judged on the document. Production run dc45c95b (2026-09-27):
 * "README documents every route with a curl example" was judged met on "README
 * exists", because the read-back only reads what the result names and it said
 * "README documentation". A name is a workspace path the text spells
 * ("docs/ERRORS.md") or a root Markdown file's stem ("README", "CHANGELOG").
 * They are read even when the ground-truth block lists them, since that shows
 * a 400-character head; a name that resolves to no file says nothing, and a
 * path leaving the workspace root is never read.
 */
export async function criteriaFilesBlock(
  ctx: RunContext, checklist: AcceptanceChecklist, refreshPaths: readonly string[], taskDescription: string,
  sourceChars: number = CRITERIA_SOURCE_CHARS,
): Promise<string> {
  if (!ctx.tools?.has('read_file') || (checklist.length === 0 && refreshPaths.length === 0)) return '';
  const tools = baseExecutorOf(ctx.tools);
  const text = checklist.map((item) => item.behaviour).join('\n');
  const wanted: string[] = [...text.matchAll(NAMED_PATH)].map((match) => match[1]!);
  if (checklist.length > 0 && tools.has('list_files')) {
    try {
      const listed = (await tools.execute('list_files', { path: '.' })) as { entries?: Array<{ name?: string; kind?: string }> } | null;
      for (const entry of listed?.entries ?? []) {
        const name = entry.name ?? '';
        const stem = name.replace(/\.(?:md|markdown|txt)$/i, '');
        if (entry.kind !== 'dir' && stem !== name && stem.length >= 4 &&
          new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) wanted.push(name);
      }
    } catch { /* a listing is a bonus */ }
  }
  // The ground-truth probe already owns the manifest's schema and recorded
  // observations. Its append-only bytes must not crowd source/test bodies out
  // of this separate read-back. An explicitly named criterion still gets it.
  wanted.push(...refreshPaths.filter(path => path !== PROBE_MANIFEST_FILENAME));
  const lines: string[] = [];
  const files: Array<{ label: string; content: string; words: ReadonlySet<string>; referencedBy?: string }> = [];
  const paths = [...new Set(wanted)].filter((path) => !path.split('/').includes('..') && !/^(?:\/|[a-z]:)/i.test(path));
  let attempted = 0;
  for (const path of paths) {
    if (attempted >= CRITERIA_FILES_MAX || ctx.signal?.aborted) break;
    attempted++;
    const stem = path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();
    const naming = checklist.filter((item) => item.behaviour.toLowerCase().includes(stem)).map((item) => item.behaviour.toLowerCase());
    if (refreshPaths.includes(path)) naming.push(taskDescription.toLowerCase(), text.toLowerCase());
    const words = new Set(naming.flatMap((text) => [...text.matchAll(CRITERIA_TOKEN)].map((match) => match[0]))
      .filter((word) => !COMMON_WORDS.has(word) && word !== stem));
    try {
      const read: unknown = await tools.execute('read_file', { path });
      const content = typeof read === 'string' ? read : read && typeof read === 'object' &&
        'content' in read && typeof read.content === 'string' ? read.content : undefined;
      if (content === undefined) throw new Error('read returned no content');
      const label = /^[\w./-]+$/.test(path) ? path : JSON.stringify(path);
      files.push({ label, content, words });
    } catch {
      // Silent, never refuting: "saves quote.txt" names a download, not a workspace file.
      if (refreshPaths.includes(path)) lines.push(`- ${JSON.stringify(path)}: current read unavailable; superseded contents remain omitted. This establishes no current content or absence.`);
    }
  }
  // The small files a read-back script loads by a quoted relative path — the
  // fixtures and expected outputs its assertions compare against. Run cb53b09d
  // was refused because its diamond test named fixture files nobody showed.
  // Inside the same I/O cap, after every file asked for, small files only.
  let referencedChars = 0, referenced = 0, referenceReads = 0;
  for (const file of [...files]) {
    if (!SCRIPT_PATH.test(file.label) || !TEST_SCRIPT.test(file.label)) continue;
    const dir = file.label.includes('/') ? file.label.slice(0, file.label.lastIndexOf('/') + 1) : '';
    for (const match of file.content.matchAll(QUOTED_RELATIVE_PATH)) {
      if (attempted + referenceReads >= CRITERIA_FILES_MAX || referenced >= REFERENCED_FILES_MAX || ctx.signal?.aborted) break;
      // `new URL('./x', import.meta.url)` resolves beside the script, a bare
      // `readFileSync('x')` from the working directory: try the likelier first.
      const relative = match[1]!;
      const candidates = [...new Set((relative.startsWith('.') ? [`${dir}${relative}`, relative] : [relative, `${dir}${relative}`])
        .map((candidate) => posix.normalize(candidate)))]
        .filter((path) => !path.startsWith('..') && !path.startsWith('/') && !/(?:^|\/)(?:node_modules|\.atoma-[^/]*)(?:\/|$)/.test(path) &&
          !/(?:^|\/)package(?:-lock)?\.json$/.test(path) && !paths.includes(path) && !files.some((known) => known.label === path));
      for (const path of candidates) {
        if (attempted + referenceReads >= CRITERIA_FILES_MAX || ctx.signal?.aborted) break;
        referenceReads++;
        try {
          const read: unknown = await tools.execute('read_file', { path });
          const content = typeof read === 'string' ? read : read && typeof read === 'object' &&
            'content' in read && typeof read.content === 'string' ? read.content : undefined;
          if (content === undefined) continue;
          if (content.length <= REFERENCED_FILE_CHARS && referencedChars + content.length <= REFERENCED_TOTAL_CHARS) {
            files.push({ label: path, content, words: file.words, referencedBy: file.label });
            referencedChars += content.length;
            referenced++;
          }
          break;
        } catch { /* a path in a string is not always a workspace file */ }
      }
    }
  }
  // Water-fill the same total allowance: small files give their unused share
  // to larger ones. Crossing the total by one character must not collapse
  // every long file back to a 1,200-character head.
  let remaining = sourceChars;
  const allowances = new Map<string, number>();
  const bySize = [...files].sort((a, b) => a.content.length - b.content.length);
  for (const [index, file] of bySize.entries()) {
    const allowance = Math.min(file.content.length, Math.floor(remaining / (bySize.length - index)));
    allowances.set(file.label, allowance);
    remaining -= allowance;
  }
  lines.push(...files.map(({ label, content, words, referencedBy }) =>
    `- ${label} (${content.length} chars${referencedBy ? `, referenced by a string literal in ${referencedBy}` : ''}): ${namedFileExcerpt(content, words, allowances.get(label)!, Math.floor(sourceChars / 4))}`));
  if (attempted < paths.length) lines.push(`${paths.length - attempted} further file reads omitted by the bound or cancellation; their current contents are unknown.`);
  return lines.length > 0
    ? [`FILES THE CRITERIA NAME${refreshPaths.length ? ' OR WHOSE READS WERE SUPERSEDED OR TRUNCATED' : ''}, read back by the host (mechanical). An excerpt cut short is SILENT about what it`,
      'does not show: never judge a criterion unmet on a part of the file you were not shown.',
      'These are current file contents, not executed checks. Historical command outcomes remain separate; a later edit is not proved by an earlier execution.', ...lines].join('\n')
    : '';
}
