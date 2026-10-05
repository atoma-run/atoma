import type { RunContext } from '../core/types.js';
import { baseExecutorOf } from '../core/attestation.js';
import type { AcceptanceChecklist } from '../contracts/acceptanceChecklist.js';
import { PROBE_MANIFEST_FILENAME } from '../contracts/probeManifest.js';

const NAMED_PATH = /(?<![\w./-])(\.?[\w-][\w.-]+(?:\/[\w.-]+)*\.(?:md|markdown|txt|html?|css|m?js|cjs|ts|json|csv|py|sh|ya?ml))(?![\w/-])/gi;
const CRITERIA_FILES_MAX = 4;
const CRITERIA_FILE_COMPLETE_MAX = 6000;
const CRITERIA_FILE_MATCHED_LINES = 15;
const CRITERIA_TOKEN = /[a-z][a-z0-9_-]{3,}/g;
const COMMON_WORDS = new Set(['with', 'that', 'this', 'every', 'each', 'from', 'into', 'have', 'shows', 'show', 'must',
  'documents', 'document', 'explains', 'lists', 'links', 'file', 'files', 'example', 'examples', 'readme']);

/**
 * What of a named file reaches the acceptor: its head, and past it the lines
 * holding a word of the criteria that name it ("curl", "route", "exit"), so a
 * criterion about a long README is not judged on its first screen only.
 */
function namedFileExcerpt(content: string, words: ReadonlySet<string>, allowance: number): string {
  // Keep complete small files: keyword excerpts retain test titles while
  // dropping their fixtures and assertions (warehouse run 22af997d).
  if (content.length <= allowance) return JSON.stringify(content);
  const headLength = allowance - Math.min(CRITERIA_FILE_MATCHED_LINES * 200, Math.floor(allowance / 2));
  const head = content.slice(0, headLength);
  const later = content.slice(headLength).split(/\r?\n/)
    .filter((line) => [...line.toLowerCase().matchAll(CRITERIA_TOKEN)].some((match) => words.has(match[0])))
    .slice(0, CRITERIA_FILE_MATCHED_LINES).map((line) => line.slice(0, 200));
  return `${JSON.stringify(head)} …(cut at ${headLength} of ${content.length} chars)` +
    (later.length > 0 ? `\n    later lines naming the criteria's words: ${JSON.stringify(later)}` : '');
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
  ctx: RunContext, checklist: AcceptanceChecklist, refreshPaths: readonly string[], taskDescription: string
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
  const files: Array<{ label: string; content: string; words: ReadonlySet<string> }> = [];
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
  // Water-fill the same total allowance: small files give their unused share
  // to larger ones. Crossing the total by one character must not collapse
  // every long file back to a 1,200-character head.
  let remaining = CRITERIA_FILES_MAX * CRITERIA_FILE_COMPLETE_MAX;
  const allowances = new Map<string, number>();
  const bySize = [...files].sort((a, b) => a.content.length - b.content.length);
  for (const [index, file] of bySize.entries()) {
    const allowance = Math.min(file.content.length, Math.floor(remaining / (bySize.length - index)));
    allowances.set(file.label, allowance);
    remaining -= allowance;
  }
  lines.push(...files.map(({ label, content, words }) =>
    `- ${label} (${content.length} chars): ${namedFileExcerpt(content, words, allowances.get(label)!)}`));
  if (attempted < paths.length) lines.push(`${paths.length - attempted} further file reads omitted by the bound or cancellation; their current contents are unknown.`);
  return lines.length > 0
    ? [`FILES THE CRITERIA NAME${refreshPaths.length ? ' OR WHOSE READS WERE SUPERSEDED' : ''}, read back by the host (mechanical). An excerpt cut short is SILENT about what it`,
      'does not show: never judge a criterion unmet on a part of the file you were not shown.',
      'These are current file contents, not executed checks. Historical command outcomes remain separate; a later edit is not proved by an earlier execution.', ...lines].join('\n')
    : '';
}
