import path from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import type { Plan, ToolExecutor } from '../core/types.js';
import { FILE_OBSERVATION_ONLY_ARG } from '../contracts/toolOutput.js';
import { normalizeDeclaredOutput } from './l3RootPlan.js';
import {
  VITEST_TEST_FILE, moduleSpecifiers, requireNames, resolutionCandidates, scriptKindOf, twinsOf, type ModuleSpecifiers,
} from './parentSuiteCheck.js';

/**
 * One more host fact for the delegation review (2026-10-17): the modules a
 * plan writes that no suite imports, names or calls into, the last bullet of
 * `parentSuiteFacts.ts`'s HOST FACTS ON THE SUITES. Reach, never a verdict.
 *
 * Plan c3379f8c of run 760fef4c restored a startup CAPTCHA check in
 * browser/control-server.js. Its suite took only createFakeSession from a
 * harness that requires the server, so no suite could fail on the restored
 * behaviour, and the root review approved it. Measured on eleven Attica runs
 * (97 reviews past the precheck), this line fires in 3, all for that module
 * and all real gaps; six later runs (21 reviews) give none. A pre-registered
 * replay gate landed it: with the line, 3 of 3 refusals named the gap,
 * without it 1 of 3; a negative control whose task names no behaviour of the
 * module gave none (records/reviews/suite-module-reach-2026-10-17.md).
 *
 * The rules, each in the silent direction: a false claim is worse than none.
 * - Candidates are the code modules the plan writes (no declaration, test,
 *   test-support or generated file), grouped with their `.js`/`.ts` twins and
 *   shown under the TypeScript name when the plan writes one, and kept only
 *   when a form exists and another project file imports it. The first version
 *   named 14 `.js` files a plan replaced by their TypeScript twins.
 * - Each suite's reach is walked from its imports over the files as they
 *   stand, each specifier resolved from its own file inside the suite's cwd;
 *   a module the plan creates is read through its existing twin.
 * - Covered, so silent: a suite imports a form, or names one in a literal (a
 *   hash check); a reached file names one; a reached file other than test
 *   support imports one; a reached built file stands for its source; a
 *   computed load whose literal names a directory is followed through it.
 * - Claimed: nothing reaches the module, or only test helpers the suite
 *   imports directly, whose part the suite takes never references it (a
 *   one-file syntax check; what it cannot read is unknown, so silent).
 * - Withheld whole when any walk is open: the suite loads a computed path; a
 *   module of unknown imports; a bare specifier that is no builtin and no
 *   registry dependency of a package.json between its file and the cwd; paths
 *   or baseUrl in a root tsconfig; a directory import; an unreadable file; a
 *   bound; a listing fault. A computed load without a literal directory is
 *   disclosed in the line, not followed.
 *
 * Reads go through `list_files` and observation-only `read_file`, which
 * withholds `write_file`'s overwrite permission: the first version's reads
 * switched off the blind-overwrite refusal for every file they touched.
 */

const MAX_LISTINGS = 200;
const MAX_READS = 400;
const MAX_READ_CHARS = 4_000_000;
/** The gate's cap; modules past it are left out whole, never cut. */
const MAX_MODULES = 6;
/** A longer line drops its last modules whole. */
const MAX_LINE_CHARS = 2_000;

const CODE = /\.[cm]?[jt]sx?$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const GENERATED = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const generated = (file: string): boolean => file.split('/').some(segment => GENERATED.has(segment));
/** Test support: a test file, or a file under a test or fixture directory. It chooses what the line says, never a verdict. */
const testSupport = (file: string): boolean => VITEST_TEST_FILE.test(file) || /(?:^|\/)(?:tests?|__tests__|__mocks__|specs?|fixtures?|e2e)\//.test(file);
const stem = (file: string): string => file.replace(/\.[cm]?[jt]sx?$/, '');
/** What a suite takes from a helper when it imports it for its side effects alone. */
const SIDE_EFFECTS = '(side effects)';

/** A plan path or name as a fact shows it: control characters blanked, capped. */
export const shown = (value: string): string => {
  const clean = [...value].map(char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)).join('');
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
};

/** Why there is no line: for the log, never for a model. */
class Withheld extends Error {}

type Kind = 'file' | 'dir';
type Listing = { entries?: Array<{ name?: unknown; kind?: unknown }> } | null;

/** The workspace as one review reads it: each listing and file once, under the bounds and the run's signal. */
class Workspace {
  private readonly listings = new Map<string, ReadonlyMap<string, Kind>>();
  private readonly sources = new Map<string, string | undefined>();
  private reads = 0;
  private chars = 0;

  constructor(private readonly tools: ToolExecutor, private readonly signal: AbortSignal | undefined) {}

  async entries(directory: string): Promise<ReadonlyMap<string, Kind>> {
    const known = this.listings.get(directory);
    if (known) return known;
    if (this.listings.size >= MAX_LISTINGS) throw new Withheld(`more than ${MAX_LISTINGS} listings`);
    if (this.signal?.aborted) throw new Withheld('aborted');
    let listing: Listing = null;
    try {
      listing = await this.tools.execute('list_files', { path: directory }) as Listing;
    } catch (error) {
      // A file where a directory was asked holds nothing; any other fault could hide a file.
      if (!String(error).includes('ENOTDIR')) throw new Withheld(`listing ${directory} failed`);
    }
    const entries = new Map<string, Kind>();
    for (const entry of listing?.entries ?? []) {
      if (typeof entry.name !== 'string') continue;
      if (entry.kind === 'file' || entry.kind === 'symlink') entries.set(entry.name, 'file');
      else if (entry.kind === 'dir') entries.set(entry.name, 'dir');
    }
    this.listings.set(directory, entries);
    return entries;
  }

  async kind(file: string): Promise<Kind | undefined> {
    return (await this.entries(path.posix.dirname(file))).get(path.posix.basename(file));
  }

  /** A file's text, read without authorizing a child's overwrite; undefined when it cannot be read. */
  async read(file: string): Promise<string | undefined> {
    if (this.sources.has(file)) return this.sources.get(file);
    if (this.reads >= MAX_READS || this.chars >= MAX_READ_CHARS) throw new Withheld('read bound');
    if (this.signal?.aborted) throw new Withheld('aborted');
    this.reads++;
    let text: string | undefined;
    try {
      const read = await this.tools.execute('read_file', { path: file, [FILE_OBSERVATION_ONLY_ARG]: true }) as { content?: unknown } | null;
      text = typeof read?.content === 'string' ? read.content : undefined;
    } catch {
      text = undefined;
    }
    this.chars += text?.length ?? 0;
    this.sources.set(file, text);
    return text;
  }
}

interface Group {
  /** The written files and their twins: one module. */
  readonly forms: string[];
  readonly written: Array<{ readonly file: string; readonly subtask: number }>;
  readonly shown: string;
}

interface Suite { readonly label: string; readonly cwd: string; readonly source: string }

interface Walk {
  readonly suite: Suite;
  /** Each module the suite imports, with the specifiers it writes for it. */
  readonly direct: Map<string, Set<string>>;
  readonly literals: readonly string[];
  /** Every file the walk reached, with the reached files importing it. */
  readonly importers: Map<string, Set<string>>;
  /** The literals of reached files that load nothing: paths they name for any other use. */
  readonly mentions: Array<{ readonly file: string; readonly text: string }>;
  /** Directories a computed load names, followed through every module under them. */
  readonly followed: Set<string>;
}

/** Inside the copy the runner makes of `root`. */
const inside = (root: string, file: string): boolean =>
  !(file === '..' || file.startsWith('../')) && (root === '.' || file === root || file.startsWith(`${root}/`));

const packageName = (specifier: string): string =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;

/** The plan's candidate modules, one group per module, in plan order. */
function candidates(plan: Plan): Group[] {
  const groups = new Map<string, { forms: Set<string>; written: Array<{ file: string; subtask: number }> }>();
  plan.subtasks.forEach((subtask, index) => {
    for (const raw of subtask.outputs ?? []) {
      const file = normalizeDeclaredOutput(raw);
      if (!file || !CODE.test(file) || DECLARATION.test(file) || testSupport(file) || generated(file)) continue;
      const key = file.replace(/\.[jt]sx?$/, '.~js').replace(/\.m[jt]s$/, '.~mjs').replace(/\.c[jt]s$/, '.~cjs');
      const group = groups.get(key) ?? { forms: new Set<string>(), written: [] };
      if (!group.written.some(each => each.file === file)) group.written.push({ file, subtask: index });
      for (const form of [file, ...twinsOf(file)]) group.forms.add(form);
      groups.set(key, group);
    }
  });
  return [...groups.values()].map(({ forms, written }) => ({
    forms: [...forms], written,
    // The name after the plan: the TypeScript form when it writes one.
    shown: [...written].sort((a, b) => Number(/\.[cm]?tsx?$/.test(b.file)) - Number(/\.[cm]?tsx?$/.test(a.file)))[0]!.file,
  }));
}

/**
 * The modules of the plan that no suite imports, names or calls into, as the
 * last bullet of the HOST FACTS block; '' when there is nothing to say.
 * `withheld` says why a line could not be computed, for the log.
 */
export async function suiteModuleReach(plan: Plan, tools: ToolExecutor, signal?: AbortSignal):
  Promise<{ line: string; modules: number; withheld?: string }> {
  const groups = candidates(plan);
  const suites: Suite[] = [
    ...plan.subtasks.flatMap((subtask, index) => subtask.acceptanceTests ? [{ label: `subtask ${index} suite`, ...subtask.acceptanceTests }] : []),
    ...(plan.acceptanceTests ? [{ label: 'plan integration suite', ...plan.acceptanceTests }] : []),
  ].map(({ label, cwd, source }) => ({ label, cwd: path.posix.normalize(cwd || '.').replace(/\/+$/, '') || '.', source }));
  if (groups.length === 0 || suites.length === 0) return { line: '', modules: 0 };
  try {
    return await reach(plan, groups, suites, new Workspace(tools, signal));
  } catch (error) {
    if (error instanceof Withheld) return { line: '', modules: 0, withheld: error.message };
    throw error;
  }
}

async function reach(plan: Plan, groups: Group[], suites: Suite[], workspace: Workspace): Promise<{ line: string; modules: number }> {
  const outputs = plan.subtasks.flatMap(subtask => (subtask.outputs ?? []).map(normalizeDeclaredOutput))
    .filter((output): output is string => output !== null).map(output => output.replace(/\/+$/, ''));

  /**
   * The file a relative specifier loads, as the runner tries its candidates:
   * the first that exists or that the plan writes by name. A candidate that
   * only a directory output covers may come first once written: open.
   */
  const resolve = async (root: string, from: string, specifier: string): Promise<string | undefined> => {
    const target = path.posix.normalize(path.posix.join(from, specifier.replace(/[?#].*$/, '')));
    if (!inside(root, target)) return undefined;
    let maybe = false;
    for (const candidate of resolutionCandidates(target)) {
      const definite = await workspace.kind(candidate) === 'file' || (outputs.includes(candidate) && path.posix.extname(candidate) !== '');
      if (definite && maybe) throw new Withheld(`${candidate}: a file the plan writes may load first`);
      if (definite) return candidate;
      maybe ||= outputs.some(output => candidate === output || candidate.startsWith(`${output}/`));
    }
    if (maybe) throw new Withheld(`${target}: only a file the plan writes may load`);
    if (await workspace.kind(target) === 'dir') throw new Withheld(`${target}: a directory import`);
    return undefined;
  };

  /** Registry dependencies of each package.json; empty when absent or unreadable, which leaves every bare import undeclared. */
  const dependencies = new Map<string, ReadonlySet<string>>();
  const declaredIn = async (manifest: string): Promise<ReadonlySet<string>> => {
    const known = dependencies.get(manifest);
    if (known) return known;
    const names = new Set<string>();
    const text = await workspace.kind(manifest) === 'file' ? await workspace.read(manifest) : undefined;
    try {
      const json = JSON.parse(text ?? '{}') as Record<string, unknown>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const declared = json[key];
        if (!declared || typeof declared !== 'object') continue;
        // A local or workspace package is project source the walk would have to follow.
        for (const [name, spec] of Object.entries(declared)) if (!/^(?:file|link|workspace|portal):/.test(String(spec))) names.add(name);
      }
    } catch {
      names.clear();
    }
    dependencies.set(manifest, names);
    return names;
  };
  const bare = async (root: string, from: string, specifiers: readonly string[], who: string): Promise<void> => {
    for (const raw of specifiers) {
      const specifier = raw.replace(/\?.*$/, '');
      if (specifier.startsWith('/')) throw new Withheld(`${who}: an absolute import`);
      if (isBuiltin(specifier) || specifier === 'vitest' || specifier.startsWith('vitest/')) continue;
      let declared = false;
      for (let at = from; !declared; at = path.posix.dirname(at)) {
        declared = (await declaredIn(at === '.' ? 'package.json' : `${at}/package.json`)).has(packageName(specifier));
        if (at === root || at === '.') break;
      }
      if (!declared) throw new Withheld(`${who}: '${specifier}' is neither a builtin nor a declared package`);
    }
  };

  /** Root tsconfig paths or baseUrl alias what a bare import loads, here and in every module. */
  const configs = new Set<string>();
  const aliases = async (config: string, depth: number): Promise<void> => {
    if (configs.has(config)) return;
    configs.add(config);
    const text = await workspace.read(config);
    const parsed = text === undefined ? undefined : ts.parseConfigFileTextToJson(config, text);
    const json = parsed?.config as { compilerOptions?: Record<string, unknown>; extends?: unknown; references?: unknown } | undefined;
    if (!parsed || parsed.error || !json || typeof json !== 'object') throw new Withheld(`${config}: unreadable`);
    if (json.compilerOptions?.['paths'] !== undefined || json.compilerOptions?.['baseUrl'] !== undefined) throw new Withheld(`${config}: paths or baseUrl`);
    if (json.references !== undefined) throw new Withheld(`${config}: project references`);
    // A relative base is project text; a package's base names no project path.
    for (const base of [json.extends].flat()) {
      if (typeof base !== 'string' || !/^\.\.?\//.test(base)) continue;
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(config), base.endsWith('.json') ? base : `${base}.json`));
      if (depth >= 4) throw new Withheld(`${config}: extends too deep`);
      if (!file.startsWith('../') && await workspace.kind(file) === 'file') await aliases(file, depth + 1);
    }
  };

  /** Every code file under a directory, generated and hidden trees left out. */
  const codeUnder = async (directory: string): Promise<string[]> => {
    const files: string[] = [];
    const queue = [directory];
    while (queue.length) {
      const at = queue.shift()!;
      for (const [name, kind] of await workspace.entries(at)) {
        const file = at === '.' ? name : `${at}/${name}`;
        if (kind === 'dir') { if (!GENERATED.has(name) && !name.startsWith('.')) queue.push(file); } else if (CODE.test(name) && !DECLARATION.test(name)) files.push(file);
      }
    }
    return files;
  };

  const parsed = new Map<string, ModuleSpecifiers>();
  const specifiersOf = (source: string, file: string): ModuleSpecifiers => {
    const known = parsed.get(file) ?? moduleSpecifiers(source, file);
    parsed.set(file, known);
    return known;
  };
  const disclosed: string[] = [];
  const walks: Walk[] = [];
  for (const suite of suites) {
    const own = moduleSpecifiers(suite.source);
    if (!own.parsed) throw new Withheld(`${suite.label}: does not parse`);
    if (own.computed.length || own.glob) throw new Withheld(`${suite.label}: a computed load`);
    const rootConfigs = [...(await workspace.entries(suite.cwd))].filter(([name, kind]) => kind === 'file' && /^tsconfig.*\.json$/.test(name));
    for (const [name] of rootConfigs) await aliases(suite.cwd === '.' ? name : `${suite.cwd}/${name}`, 0);
    await bare(suite.cwd, suite.cwd, own.bare, suite.label);
    const walk: Walk = { suite, direct: new Map(), literals: own.literals, importers: new Map(), mentions: [], followed: new Set() };
    const queue: string[] = [];
    const reached = (target: string, importer?: string): void => {
      const known = walk.importers.get(target);
      if (!known) queue.push(target);
      const importers = known ?? new Set<string>();
      if (importer && importer !== target) importers.add(importer);
      walk.importers.set(target, importers);
    };
    for (const specifier of [...own.relative, ...own.resolved]) {
      const target = await resolve(suite.cwd, suite.cwd, specifier);
      if (!target) continue;
      walk.direct.set(target, (walk.direct.get(target) ?? new Set<string>()).add(specifier));
      reached(target);
    }
    while (queue.length) {
      const file = queue.shift()!;
      if (!CODE.test(file)) continue;
      // A module the plan creates is read through its existing twin: what it migrates.
      let read = file;
      if (await workspace.kind(file) !== 'file') {
        const twin = await firstExisting(twinsOf(file), workspace);
        if (!twin) throw new Withheld(`${file}: written by the plan, its imports unknown`);
        read = twin;
      }
      const source = await workspace.read(read);
      if (source === undefined) throw new Withheld(`${read}: unreadable`);
      const found = specifiersOf(source, read);
      if (!found.parsed) throw new Withheld(`${read}: does not parse`);
      if (found.glob) throw new Withheld(`${read}: import.meta.glob`);
      const from = path.posix.dirname(file);
      await bare(suite.cwd, from, found.bare, file);
      for (const pieces of found.computed) {
        const directories = new Set<string>();
        for (const piece of pieces) {
          const at = path.posix.normalize(path.posix.join(from, piece.replace(/\/[^/]*$/, '') || '.')).replace(/\/+$/, '');
          if (at !== '.' && inside(suite.cwd, at) && await workspace.kind(at) === 'dir') directories.add(at);
        }
        if (directories.size === 0 && !disclosed.includes(file)) disclosed.push(file);
        for (const directory of directories) {
          walk.followed.add(directory);
          for (const target of await codeUnder(directory)) reached(target, file);
        }
      }
      for (const specifier of [...found.relative, ...found.resolved]) {
        const target = await resolve(suite.cwd, from, specifier);
        if (target) reached(target, file);
      }
      for (const text of found.mentions) walk.mentions.push({ file, text });
    }
    walks.push(walk);
  }

  // Covered: imported, named, named by a reached file, imported by a reached application module or built file, or followed.
  const names = (text: string, from: string, forms: readonly string[]): boolean => {
    const at = path.posix.normalize(path.posix.join(from, text.replace(/^\.\//, '')));
    return forms.includes(at) || forms.some(form => stem(form) === at || path.posix.basename(form) === path.posix.basename(text));
  };
  const uncovered = groups.filter(group => !walks.some(walk => {
    const forms = group.forms;
    if (forms.some(form => walk.direct.has(form))) return true;
    if (walk.literals.some(text => names(text, walk.suite.cwd, forms))) return true;
    if (walk.mentions.some(({ file, text }) => !forms.includes(file) &&
      (names(text, path.posix.dirname(file), forms) || names(text, walk.suite.cwd, forms)))) return true;
    if ([...walk.followed].some(directory => forms.some(form => form.startsWith(`${directory}/`)))) return true;
    const reachedFiles = [...walk.importers.keys()];
    if (reachedFiles.some(file => generated(file) && forms.some(form => stem(file).endsWith(`/${stem(form)}`) ||
      (stem(form).includes('/') && stem(file).endsWith(`/${stem(form).split('/').slice(1).join('/')}`))))) return true;
    return forms.some(form => [...walk.importers.get(form) ?? []].some(importer => !forms.includes(importer) && !testSupport(importer)));
  }));

  const existing: Group[] = [];
  for (const group of uncovered) if (await firstExisting(group.forms, workspace)) existing.push(group);
  const imported = existing.length ? await importedElsewhere(existing, workspace, outputs) : new Set<Group>();

  const modules: string[] = [];
  for (const group of existing) {
    if (!imported.has(group)) continue;
    const written = `${shown(group.shown)} (subtask ${[...new Set(group.written.map(each => each.subtask))].join(', ')})`;
    const loading = walks.flatMap(walk => {
      const helpers = new Set(group.forms.flatMap(form => [...walk.importers.get(form) ?? []]).filter(file => !group.forms.includes(file)));
      return helpers.size ? [{ walk, helpers: [...helpers] }] : [];
    });
    if (loading.length === 0) {
      modules.push(`${written}, which no suite loads`);
      continue;
    }
    // The tested wording names one suite's part; two suites would need another sentence.
    if (loading.length > 1) continue;
    const { walk, helpers } = loading[0]!;
    const taken = new Set<string>();
    let verdict: 'not' | 'uses' | 'unknown' = 'not';
    for (const helper of helpers) {
      const specifiers = walk.direct.get(helper);
      const source = specifiers && await workspace.kind(helper) === 'file' ? await workspace.read(helper) : undefined;
      if (!specifiers || source === undefined) { verdict = 'unknown'; break; }
      const part = takenBindings(walk.suite.source, specifiers);
      for (const name of part) taken.add(name);
      const loadsModule = (specifier: string): boolean => resolutionCandidates(path.posix.normalize(
        path.posix.join(path.posix.dirname(helper), specifier.replace(/[?#].*$/, '')))).some(candidate => group.forms.includes(candidate));
      verdict = helperReach(source, helper, part, loadsModule);
      if (verdict !== 'not') break;
    }
    const listed = [...taken].filter(name => name !== SIDE_EFFECTS);
    if (verdict !== 'not' || listed.length === 0) continue;
    modules.push(`${written}, loaded only as a dependency of ${helpers.map(shown).join(', ')}, whose ${listed.map(shown).join(', ')}, ` +
      `the part ${walk.suite.label} uses, never references it`);
  }
  if (modules.length === 0) return { line: '', modules: 0 };
  const head = '- Modules this plan writes that no suite imports, names or calls into (static imports of the files as they stand' +
    `${disclosed.length ? `; computed loads in ${disclosed.map(shown).join(', ')} not followed` : ''}): `;
  const tail = '. Reach, not a verdict: it matters only where the task or its criteria name a behaviour of that module.';
  const kept = modules.slice(0, MAX_MODULES);
  while (kept.length && head.length + kept.join('; ').length + tail.length > MAX_LINE_CHARS) kept.pop();
  if (kept.length === 0) throw new Withheld('line too long');
  return { line: `${head}${kept.join('; ')}${tail}`, modules: kept.length };
}

async function firstExisting(files: readonly string[], workspace: Workspace): Promise<string | undefined> {
  for (const file of files) if (await workspace.kind(file) === 'file') return file;
  return undefined;
}

/**
 * The candidates another project file imports, the generated trees left out:
 * one bounded scan of the project's code, stopped once each has an importer.
 */
async function importedElsewhere(groups: readonly Group[], workspace: Workspace, outputs: readonly string[]): Promise<Set<Group>> {
  const imported = new Set<Group>();
  const directories = ['.'];
  while (directories.length && imported.size < groups.length) {
    const directory = directories.shift()!;
    for (const [name, kind] of await workspace.entries(directory)) {
      const file = directory === '.' ? name : `${directory}/${name}`;
      if (kind === 'dir') {
        if (!GENERATED.has(name) && !name.startsWith('.')) directories.push(file);
        continue;
      }
      if (!CODE.test(name) || DECLARATION.test(name)) continue;
      const source = await workspace.read(file);
      if (source === undefined) continue;
      const found = moduleSpecifiers(source, file);
      for (const specifier of [...found.relative, ...found.resolved]) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.replace(/[?#].*$/, '')));
        if (target === '..' || target.startsWith('../')) continue;
        let loaded: string | undefined;
        for (const candidate of resolutionCandidates(target)) {
          if (await workspace.kind(candidate) === 'file' || outputs.some(output => candidate === output || candidate.startsWith(`${output}/`))) { loaded = candidate; break; }
        }
        for (const group of groups) if (loaded && group.forms.includes(loaded) && !group.forms.includes(file)) imported.add(group);
      }
    }
  }
  return imported;
}

/** The names a suite takes from one of its imports: `*` when it takes the module whole, `SIDE_EFFECTS` for a bare import. */
function takenBindings(suiteSource: string, specifiers: ReadonlySet<string>): Set<string> {
  const file = ts.createSourceFile('atoma.acceptance.test.ts', suiteSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const requires = requireNames(file);
  const taken = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && specifiers.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (!clause) taken.add(SIDE_EFFECTS);
      else if (!clause.isTypeOnly) {
        if (clause.name) taken.add('*');
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) taken.add('*');
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (!element.isTypeOnly) taken.add((element.propertyName ?? element.name).text);
        }
      }
    } else if ((ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression) && specifiers.has(node.moduleReference.expression.text)) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && specifiers.has(node.moduleSpecifier.text))) {
      taken.add('*');
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!) &&
        specifiers.has(node.arguments[0].text) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && requires.has(node.expression.text)))) {
      // `const { a, b: c } = require(…)` or `= await import(…)`: those names; any other use takes the module whole.
      let holder: ts.Node = node.parent;
      while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent;
      if (ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)) {
        for (const element of holder.name.elements) {
          const key = element.propertyName ?? element.name;
          taken.add(element.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteral(key)) ? '*' : key.text);
        }
      } else taken.add('*');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return taken;
}

const deferred = (node: ts.Node): boolean => ts.isFunctionExpression(node) || ts.isArrowFunction(node);

/** Every name a binding pattern declares. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : boundNames(element.name));
}

/**
 * Whether the part of a helper a suite takes reaches the module: `uses`,
 * `not`, or `unknown` when this one-file check cannot tell (a namespace or
 * default import, a re-export, an export shape it does not read, a helper
 * that never binds the module). A reference is a binding of the module, a
 * load of it, a computed load or an `eval`, followed through the helper's
 * own top-level declarations; code that runs when the helper loads counts
 * whatever the suite takes.
 */
function helperReach(source: string, file: string, taken: ReadonlySet<string>, loadsModule: (specifier: string) => boolean): 'uses' | 'not' | 'unknown' {
  if (taken.size === 0 || taken.has('*')) return 'unknown';
  const helper = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  if ((helper as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) return 'unknown';
  const requires = requireNames(helper);
  const locals = new Set<string>();
  const declarations = new Map<string, ts.Node>();
  const exported = new Map<string, ts.Node>();
  const atLoad: ts.Node[] = [];
  /** A literal load: its specifier; a computed one: null; anything else: undefined. */
  const loadOf = (node: ts.Node): string | null | undefined => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined;
    const callee = node.expression;
    if (callee.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(callee) && requires.has(callee.text))) return undefined;
    return ts.isStringLiteralLike(node.arguments[0]!) ? node.arguments[0].text : null;
  };
  const exports = (node: ts.Node): boolean => !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(each => each.kind === ts.SyntaxKind.ExportKeyword));
  for (const statement of helper.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier) || !loadsModule(statement.moduleSpecifier.text)) continue;
      if (clause.name) locals.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) locals.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) locals.add(element.name.text);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression) && loadsModule(reference.expression.text)) locals.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        let initializer: ts.Expression | undefined = declaration.initializer;
        while (initializer && (ts.isAwaitExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
        const loaded = initializer ? loadOf(initializer) : undefined;
        if (typeof loaded === 'string' && loadsModule(loaded)) {
          for (const name of boundNames(declaration.name)) locals.add(name);
          continue;
        }
        for (const name of boundNames(declaration.name)) {
          declarations.set(name, declaration);
          if (exports(statement)) exported.set(name, declaration);
        }
        if (declaration.initializer && !deferred(initializer ?? declaration.initializer)) atLoad.push(declaration.initializer);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declarations.set(statement.name.text, statement);
      if (exports(statement)) exported.set(statement.name.text, statement);
      if (ts.isClassDeclaration(statement)) {
        for (const clause of statement.heritageClauses ?? []) for (const type of clause.types) atLoad.push(type.expression);
        // Static members and decorators run when the class is defined.
        if (ts.getDecorators(statement)?.length || statement.members.some(member => ts.isClassStaticBlockDeclaration(member) ||
          (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some(each => each.kind === ts.SyntaxKind.StaticKeyword)))) atLoad.push(statement);
      }
    } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = statement.expression.left.getText(helper);
      const value = statement.expression.right;
      if (target === 'module.exports' && ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (ts.isShorthandPropertyAssignment(property)) exported.set(property.name.text, property);
          else if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
            exported.set(property.name.text, property);
            if (ts.isPropertyAssignment(property) && !deferred(property.initializer)) atLoad.push(property.initializer);
          } else return 'unknown';
        }
      } else if (/^(?:module\.)?exports\.[\w$]+$/.test(target)) {
        exported.set(target.split('.').pop()!, value);
        if (!deferred(value)) atLoad.push(value);
      } else if (target === 'module.exports' || /^(?:module\.)?exports\b/.test(target)) return 'unknown';
      else atLoad.push(statement);
    } else if (ts.isExportDeclaration(statement)) {
      return 'unknown';
    } else atLoad.push(statement);
  }
  if (locals.size === 0) return 'unknown';

  const loadsOrUnknown = (node: ts.Node): boolean => {
    const loaded = loadOf(node);
    if (loaded === null || (typeof loaded === 'string' && loadsModule(loaded))) return true;
    // `eval` and `Function` run text this check cannot read.
    const callee = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : undefined;
    return !!callee && ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function');
  };
  const seen = new Set<ts.Node>();
  /** Whether a node mentions the module anywhere, through the helper's declarations. */
  const references = (node: ts.Node): boolean => {
    let found = false;
    const visit = (each: ts.Node): void => {
      if (found) return;
      if (loadsOrUnknown(each) || (ts.isIdentifier(each) && locals.has(each.text))) { found = true; return; }
      if (ts.isIdentifier(each)) {
        const declaration = declarations.get(each.text);
        if (declaration && !seen.has(declaration)) {
          seen.add(declaration);
          if (references(declaration)) { found = true; return; }
        }
      }
      ts.forEachChild(each, visit);
    };
    visit(node);
    return found;
  };
  /** Whether evaluating a node at load reaches the module: function bodies wait for a call, unless called or handed to one. */
  const runs = (node: ts.Node): boolean => {
    let found = false;
    const visit = (each: ts.Node): void => {
      if (found) return;
      if (each !== node && ts.isFunctionLike(each) && !(ts.isCallExpression(each.parent) || ts.isNewExpression(each.parent) ||
        ts.isParenthesizedExpression(each.parent))) return;
      if (loadsOrUnknown(each) || (ts.isIdentifier(each) && locals.has(each.text))) { found = true; return; }
      if (ts.isCallExpression(each) || ts.isNewExpression(each) || ts.isTaggedTemplateExpression(each)) {
        let callee: ts.Expression = ts.isTaggedTemplateExpression(each) ? each.tag : each.expression;
        while (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) || ts.isCallExpression(callee) ||
          ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
        const declaration = ts.isIdentifier(callee) ? declarations.get(callee.text) : undefined;
        if (declaration && references(declaration)) { found = true; return; }
      }
      ts.forEachChild(each, visit);
    };
    visit(node);
    return found;
  };
  if (atLoad.some(runs)) return 'uses';
  for (const name of taken) {
    if (name === SIDE_EFFECTS) continue;
    const node = exported.get(name);
    if (!node) return 'unknown';
    if (references(node)) return 'uses';
  }
  return 'not';
}
