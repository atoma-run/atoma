import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/**
 * THE CODE A NODE SERVER RAN, as one digest: its entry file, every module it
 * reaches through RELATIVE static imports, `import()` and `require()` with a
 * literal specifier (quoted, or a template literal with no substitution), and
 * the workspace-root package.json. `start_node_server` takes it before spawn,
 * `fetch_url` carries it on `servedBy`, root acceptance recomputes it: a probe
 * an EARLIER run recorded still covers an HTTP criterion while it is unchanged.
 *
 * Why: a continuation run had to re-probe, live, every HTTP criterion its
 * predecessors had already recorded, because coverage counted only the
 * current attempt's requests. Four runs of one project (2026-10-03/04, the
 * last 6c582953) spent most of their ninety minutes re-proving an unchanged
 * backend and were refused for "no current verification" (owner decision
 * 2026-10-04, option 1).
 *
 * FAILS CLOSED (undefined, no evidence) on what it cannot follow: an
 * unresolvable relative specifier, a `#subpath` import, an `import()` or
 * `require()` of a template literal with a substitution (`./${name}.js`, and
 * `${__dirname}/x.js` or `${import.meta.dirname}/x.js` alike), or more than
 * MAX_FILES modules. Still outside it, stated: a specifier built by any other
 * computation (`'./' + name`, a variable, `path.join(...)`), a data file the
 * server reads at runtime, a dependency's bytes, the host environment.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])((?:\.{1,2}\/|#)[^'"`\n]+)\1/g;
/** An `import()`/`require()` whose template literal computes its path. */
const COMPUTED_TEMPLATE = /(?:\bimport|\brequire)\s*\(\s*`[^`]*\$\{/;
const CANDIDATE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.json', '/index.js', '/index.mjs', '/index.cjs', '/index.json'];
const MAX_FILES = 64;

export function relativeSpecifiers(source: string): string[] {
  return [...new Set([...source.matchAll(SPECIFIER)].map((match) => match[2]!))];
}

/**
 * `read` returns a workspace-relative file's text, or undefined when it does
 * not exist. Undefined when the entry cannot be read or the graph cannot be
 * followed exactly.
 */
export async function serverCodeDigest(
  entry: string,
  read: (path: string) => Promise<string | undefined> | string | undefined
): Promise<string | undefined> {
  const start = posix.normalize(entry.replace(/\\/g, '/')).replace(/^\.\//, '');
  const seen = new Map<string, string>();
  const queue = [start];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    if (seen.size >= MAX_FILES) return undefined;
    const text = await read(path);
    if (text === undefined) return undefined;
    seen.set(path, createHash('sha256').update(text).digest('hex'));
    if (COMPUTED_TEMPLATE.test(text)) return undefined;
    for (const specifier of relativeSpecifiers(text)) {
      if (specifier.startsWith('#') || specifier.includes('${')) return undefined;
      const base = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (base === '..' || base.startsWith('../')) return undefined;
      let resolved: string | undefined;
      for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = base + suffix;
        if (seen.has(candidate) || (await read(candidate)) !== undefined) {
          resolved = candidate;
          break;
        }
      }
      if (resolved === undefined) return undefined;
      queue.push(resolved);
    }
  }
  const manifest = await read('package.json');
  if (manifest !== undefined) seen.set('package.json', createHash('sha256').update(manifest).digest('hex'));
  const pairs = [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

/**
 * Whether the delivery still RUNS this entry: package.json names it as
 * `main` or in its `start` script. A file left behind after the server moved
 * elsewhere keeps its digest, and its old probes must not count.
 */
export function deliveryRunsEntry(packageJson: string | undefined, entry: string): boolean {
  if (packageJson === undefined) return false;
  const wanted = posix.normalize(entry.replace(/\\/g, '/')).replace(/^\.\//, '');
  try {
    const parsed = JSON.parse(packageJson) as { main?: unknown; scripts?: { start?: unknown } };
    const main = typeof parsed.main === 'string' ? posix.normalize(parsed.main).replace(/^\.\//, '') : undefined;
    if (main === wanted) return true;
    const start = typeof parsed.scripts?.start === 'string' ? parsed.scripts.start : '';
    return start.split(/\s+/).some((token) => posix.normalize(token).replace(/^\.\//, '') === wanted);
  } catch {
    return false;
  }
}
