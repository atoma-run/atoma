import path from 'node:path';
import ts from 'typescript';
import { WATCHED_PROTOTYPES, WATCHED_STATICS } from '../contracts/assertionIntegrity.js';
import { VITEST_BUILTIN_MATCHERS } from '../contracts/parentTests.js';
import { mentionsReadRunCopies, READ_RUNS_DIRECTORY } from '../contracts/readRuns.js';

/**
 * APIs the parent-owned runner's integrity guard refuses or ignores at run
 * time (`src/tools/parentTestSetup.ts`). Run there, a parent suite's own use
 * would read as the CHILD tampering, or turn its suite red, and the child
 * would be rejected for the parent's choice. Refused at plan time instead,
 * at zero tokens, so the parent pays (review 2026-10-16, G2).
 *
 * File snapshots are refused because their expected bytes would live in the
 * child's copy; inline snapshots keep them in the suite and stay available.
 */
const UNAVAILABLE = new Set([
  'addEqualityTesters', 'addSnapshotSerializer', 'toMatchSnapshot', 'toMatchFileSnapshot', 'toThrowErrorMatchingSnapshot',
  // A hand-made asymmetric matcher is indistinguishable from a forged one.
  'asymmetricMatch',
]);
const BUILTIN = new Set(VITEST_BUILTIN_MATCHERS);

/** A key written as a literal: `'is'`, `` `is` ``. An identifier argument is a variable, not a name. */
const literalOf = (expression: ts.Expression): string | undefined =>
  ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) ? expression.text : undefined;

/** A declared property's name: `toBe`, `'toBe'`, `['toBe']`. */
const nameOf = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isPrivateIdentifier(name) ? name.text
    : ts.isComputedPropertyName(name) ? literalOf(name.expression) : literalOf(name);

/** `Object`, `Array.prototype` and the like: the watched owner a spy target names, if any. */
function watchedOwner(target: ts.Expression): { owner: string; keys: readonly string[] } | undefined {
  if (ts.isIdentifier(target)) {
    const keys = WATCHED_STATICS[target.text];
    return keys ? { owner: target.text, keys } : undefined;
  }
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'prototype' && ts.isIdentifier(target.expression)) {
    const keys = WATCHED_PROTOTYPES[target.expression.text];
    return keys ? { owner: `${target.expression.text}.prototype`, keys } : undefined;
  }
  return undefined;
}

/**
 * The unavailable APIs a suite source names, sorted and unique; empty when
 * there are none. Tolerant: a source that does not parse is never refused
 * here, because the run reports it. Strings and comments are never read.
 */
export function parentSuiteUnsupported(source: string): string[] {
  const file = ts.createSourceFile('atoma.acceptance.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) return [];
  const found = new Set<string>();
  const extended = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && UNAVAILABLE.has(node.name.text)) found.add(node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const name = literalOf(node.argumentExpression);
      if (name && UNAVAILABLE.has(name)) found.add(name);
    }
    if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) ||
        ts.isShorthandPropertyAssignment(node) || ts.isGetAccessorDeclaration(node)) && node.name) {
      const name = nameOf(node.name);
      if (name === 'asymmetricMatch') found.add(name);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      // `expect.extend({...})`, on the global or a test context's `expect`.
      if (method === 'extend' && (ts.isIdentifier(receiver) ? receiver.text === 'expect'
        : ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'expect')) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            const name = property.name ? nameOf(property.name) : undefined;
            if (!name) continue;
            if (BUILTIN.has(name)) found.add(`expect.extend redefining the built-in ${name}`);
            else if (extended.has(name)) found.add(`expect.extend defining ${name} twice`);
            extended.add(name);
          }
        }
      }
      // `vi.spyOn(Object, 'is')`: a watched built-in the guard reads as tampering.
      if (method === 'spyOn' && ts.isIdentifier(receiver) && receiver.text === 'vi' && node.arguments.length >= 1) {
        const watched = watchedOwner(node.arguments[0]!);
        const key = node.arguments[1] ? literalOf(node.arguments[1]) : undefined;
        if (watched && (key === undefined || watched.keys.includes(key))) {
          found.add(`vi.spyOn(${watched.owner}, ${key === undefined ? '…' : JSON.stringify(key)})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found].sort();
}

/** The refusal text for one suite, or undefined when it names nothing unavailable. */
export function parentSuiteRefusal(label: string, source: string): string | undefined {
  const names = parentSuiteUnsupported(source);
  if (names.length === 0) return undefined;
  return `Acceptance suite ${label}: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} unavailable in the parent-owned runner. ` +
    'Use Vitest\'s built-in matchers; expect.extend may only add new names, once; custom equality testers, snapshot serializers, ' +
    'hand-made asymmetricMatch objects and file snapshots are unavailable (inline snapshots work); never spy on the built-ins ' +
    'equality reads (Object.is, Object.keys, Array.prototype methods and the like). Revise the suite.';
}

/**
 * A regular expression a suite cannot mean (run 2e6bdcfc, 2026-10-16): a
 * cell's plan reply carried `/!\\\\s+-name…/` in its JSON, so the suite the
 * runner executed held `/!\\s+-name…/`, where each `\\s` matches a BACKSLASH
 * followed by "s". It failed eight times byte for byte, spent a ladder and a
 * root acceptance, and no reviewer named it. `escaped-backslash` is an escaped
 * backslash followed by a class letter (s, d, w, b, either case), read escape
 * by escape: in 32,501 third-party regexes, 13 did so, all deliberately
 * (LaTeX, regex-source parsers); none in Atoma's own. Once one is found, the
 * finding names EVERY escaped backslash of that pattern (a `\\.` is as wrong),
 * so a planner that fixes only the class letters is not left with a pattern
 * that still cannot match (review 2026-10-17). `invalid` is a regex LITERAL
 * Node refuses: the module never loads. An invalid `RegExp` string is never a
 * finding, since it throws only when its line runs and a suite may test that.
 */
export interface SuiteRegexFinding {
  readonly kind: 'escaped-backslash' | 'invalid';
  /** A regex literal, a string handed to `RegExp`, or a `String.raw` template: the JSON escaping differs. */
  readonly form: 'literal' | 'string' | 'raw';
  readonly line: number;
  /** The expression as the suite source holds it, bounded. */
  readonly pattern: string;
  /** The whole expression, never cut: what the memo remembers as told. */
  readonly key: string;
  /** `escaped-backslash`: every escaped backslash of the pattern (`\\s`, `\\.`…); `invalid`: Node's message. */
  readonly detail: readonly string[];
}

const CLASS_ESCAPES = new Set([...'sSdDwWbB']);

/** Every escaped backslash of a regex body with the character after it, escapes read left to right. */
function escapedBackslashes(body: string): string[] {
  const pairs: string[] = [];
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== '\\') continue;
    if (body[index + 1] === '\\' && body[index + 2] !== undefined && body[index + 2] !== '\\') pairs.push(body.slice(index, index + 3));
    index += 1;
  }
  return [...new Set(pairs)];
}

const shownPattern = (text: string): string => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/**
 * Regex literals and the first argument of `RegExp(…)`/`new RegExp(…)` when it
 * is a string, a template without substitutions, or `String.raw`: the
 * patterns that cannot match what their author meant. Strings, comments and
 * computed patterns are never read; a source that does not parse is left to
 * the run, as above.
 */
export function parentSuiteRegexFindings(source: string): SuiteRegexFinding[] {
  const file = ts.createSourceFile('atoma.acceptance.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) return [];
  const findings: SuiteRegexFinding[] = [];
  const at = (node: ts.Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const escaped = (node: ts.Node, body: string, form: SuiteRegexFinding['form']): void => {
    const pairs = escapedBackslashes(body);
    if (pairs.some(pair => CLASS_ESCAPES.has(pair[2]!))) {
      const text = node.getText(file);
      findings.push({ kind: 'escaped-backslash', form, line: at(node), pattern: shownPattern(text), key: text, detail: pairs });
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = (node as ts.RegularExpressionLiteral).text;
      const end = text.lastIndexOf('/');
      try {
        new RegExp(text.slice(1, end), text.slice(end + 1));
        escaped(node, text.slice(1, end), 'literal');
      } catch (error) {
        findings.push({ kind: 'invalid', form: 'literal', line: at(node), pattern: shownPattern(text), key: text,
          detail: [String((error as Error).message).slice(0, 160)] });
      }
    } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'RegExp' && node.arguments?.length) {
      const first = node.arguments[0]!;
      if (ts.isStringLiteralLike(first)) escaped(node, first.text, 'string');
      else if (ts.isTaggedTemplateExpression(first) && first.tag.getText(file) === 'String.raw' &&
          ts.isNoSubstitutionTemplateLiteral(first.template)) escaped(node, first.template.rawText ?? first.template.text, 'raw');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** Why one finding cannot mean what it says, in the planner's terms. */
function regexFindingText(label: string, finding: SuiteRegexFinding): string {
  const where = `Acceptance suite ${label}, line ${finding.line}`;
  return finding.kind === 'invalid'
    ? `${where}: the regular expression ${finding.pattern} is invalid (${finding.detail[0]}), so the suite module cannot load.`
    : `${where}: in ${finding.pattern}, ${finding.detail.join(', ')} ${finding.detail.length === 1 ? 'matches' : 'each match'} ` +
      'a literal backslash followed by the next character, not whitespace, a digit, a word character, a boundary or an escaped character.';
}

/** The JSON layer that produces the doubled backslashes, per form, said once per refusal. */
const REGEX_ESCAPING: Readonly<Record<SuiteRegexFinding['form'], string>> = {
  literal: String.raw`The suite source is decoded from JSON once, and a regex literal holds one backslash per escape: for /\s/ write \\s in the JSON string, never \\\\s. Halve every doubled backslash in that pattern.`,
  string: String.raw`The suite source is decoded from JSON once, and a RegExp string holds two backslashes per escape: for new RegExp('\\s') write \\\\s in the JSON string, never \\\\\\\\s. Halve every doubled pair in that pattern.`,
  raw: 'The suite source is decoded from JSON once, and a String.raw template holds one backslash per escape: for String.raw`\\s` ' +
    'write \\\\s in the JSON string, never \\\\\\\\s. Halve every doubled backslash in that pattern.',
};
const DELIBERATE = 'If the text under test really contains a backslash there, keep it and say so in the suite\'s requirement.';

/**
 * The plan-time regex check, at zero tokens, for every suite of a plan.
 * An invalid literal refuses every time: that suite can never load. An
 * `escaped-backslash` pattern refuses ONCE per planner and pattern (memo),
 * the repository's reject-once-then-honour rule for heuristic plan checks
 * (`l3RootPlan.ts`): a deliberate backslash costs that planner one replan,
 * and a kept pattern reaches the review as a host fact, which is then true.
 * Every finding of one call is named before any is remembered, so a pattern
 * in two suites is named twice, never told once and excused once.
 */
export function suiteRegexPrecheck(
  suites: ReadonlyArray<{ readonly label: string; readonly source: string | undefined }>,
  memo: Set<string>,
  planner: string,
): { refusal?: string; facts: string[] } {
  const refusals: string[] = [];
  const facts: string[] = [];
  const told = new Set<string>();
  const forms = new Set<SuiteRegexFinding['form']>();
  for (const { label, source } of suites) {
    if (!source) continue;
    // Invalid literals first: one can never load, so it is named in every round, whatever the cap.
    const found = parentSuiteRegexFindings(source);
    for (const finding of [...found.filter(each => each.kind === 'invalid'), ...found.filter(each => each.kind !== 'invalid')].slice(0, 4)) {
      const key = `suite-regex|${planner}|${finding.key}`;
      if (finding.kind === 'invalid' || !memo.has(key)) {
        refusals.push(regexFindingText(label, finding));
        if (finding.kind === 'escaped-backslash') { told.add(key); forms.add(finding.form); }
      } else {
        facts.push(`HOST FACT: ${regexFindingText(label, finding)} The planner was told once and kept it: approve only if the ` +
          'text under test contains those backslashes and the suite\'s requirement says so.');
      }
    }
  }
  if (refusals.length === 0) return { facts };
  for (const key of told) memo.add(key);
  const advice = [...forms].map(form => REGEX_ESCAPING[form]);
  return { refusal: [...refusals, ...advice, ...(forms.size ? [DELIBERATE] : []), 'Revise the suite.'].join(' '), facts };
}

/**
 * Vitest's default `include` (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`, pinned by a
 * test against `configDefaults.include`): the runner's own definition of a
 * test file.
 */
export const VITEST_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The relative specifiers a source loads: import and export-from, literal `import()`, literal `require()`. */
export function relativeSpecifiers(source: string, fileName = 'atoma.acceptance.test.ts'): string[] {
  const kind = /\.(?:[cm]?jsx?)$/.test(fileName) ? ts.ScriptKind.JS : /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    // `import type` and `export type … from` are erased: nothing loads them.
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) { /* erased */ }
    else if (ts.isExportDeclaration(node) && node.isTypeOnly) { /* erased */ }
    else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found].filter(specifier => specifier.startsWith('./') || specifier.startsWith('../'));
}

/** Vite's own extension order for an extensionless import, then the CommonJS and TypeScript module forms. */
const EXTENSIONLESS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.cjs', '.cts'];
const SCRIPT_EXTENSIONS = new Set([...EXTENSIONLESS]);
/** A `.js` specifier also loads its TypeScript twin, as Vite resolves it. */
const TWINS: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/**
 * The files a relative import can load, in the order the runner tries them: a
 * superset, so a fact never says "no such file" of a file the runner would load.
 */
export function resolutionCandidates(target: string): string[] {
  const extension = path.posix.extname(target);
  const out = [target];
  for (const twin of TWINS[extension] ?? []) out.push(`${target.slice(0, -extension.length)}${twin}`);
  if (!SCRIPT_EXTENSIONS.has(extension)) {
    for (const each of EXTENSIONLESS) out.push(`${target}${each}`);
    for (const each of EXTENSIONLESS) out.push(`${target}/index${each}`);
  }
  return out;
}

/** A suite's relative import, resolved against its cwd; undefined when it leaves the copied directory. */
export function suiteImportTarget(cwd: string, specifier: string): string | undefined {
  const root = path.posix.normalize(cwd || '.');
  const joined = path.posix.normalize(path.posix.join(root, specifier));
  if (joined === '..' || joined.startsWith('../') || (root !== '.' && joined !== root && !joined.startsWith(`${root}/`))) return undefined;
  return joined;
}

/**
 * Test files a suite imports: their assertions would run as the parent's,
 * and the child writes them. In the 2026-10-16/17 corpus 5 of 198 suites, in 2
 * plans, did so; both plans were defective, and the review approved one once.
 */
export function suiteTestFileImports(cwd: string, source: string): string[] {
  return relativeSpecifiers(source).filter(specifier => {
    const target = suiteImportTarget(cwd, specifier);
    return target !== undefined && resolutionCandidates(target).some(candidate => VITEST_TEST_FILE.test(candidate));
  });
}

/**
 * A parent suite cannot read the read-run copies (`.atoma-runs`): the
 * runner's snapshot of the workspace leaves them out (src/tools/parentTests.ts),
 * so a suite reading one gets ENOENT in every round and its child is
 * rejected for a suite it cannot change (review 2026-10-17, against run
 * 2e6bdcfc's criterion "byte-identical to their versions in run 50019ee0").
 * Every mention is refused, an exclusion or a comment included: narrowed to
 * paths with an id, `join('.atoma-runs', id)` would pass. Removing the
 * mention is enough, so the message says that and never that the suite
 * "can never pass" (second review). Refused every time.
 */
export function readRunCopiesRefusal(label: string, source: string): string | undefined {
  if (!mentionsReadRunCopies(source)) return undefined;
  return `Acceptance suite ${label} names ${READ_RUNS_DIRECTORY}, which a parent-owned suite cannot read: the runner's copy ` +
    'of the workspace leaves it out. Remove the mention; prove a restore or a comparison with another run\'s saved files ' +
    'with sha256sum or diff in a shell subtask (the host also compares the files the criteria name with the read runs\' ' +
    'saved files at acceptance). Revise the suite.';
}

/**
 * Every zero-token suite finding of a plan, as ONE refusal, before any review:
 * the regexes it cannot mean (`suiteRegexPrecheck`), the APIs the runner's
 * guard refuses, test files imported as subjects, and a suite naming the
 * read-run copies. One message, so the planner hears every host finding in
 * one round (2026-10-17). A test-file import refuses once per planner and
 * specifier: a real module may carry a test-like name (`openapi.spec.ts`), and
 * a kept import reaches the review as a host fact instead (review 2026-10-17).
 */
export function planSuitePrecheck(
  suites: ReadonlyArray<{ readonly label: string; readonly source: string | undefined; readonly cwd?: string }>,
  memo: Set<string>,
  planner: string,
): { refusal?: string; facts: string[] } {
  const regexes = suiteRegexPrecheck(suites, memo, planner);
  const findings: string[] = regexes.refusal ? [regexes.refusal] : [];
  const facts = [...regexes.facts];
  const told = new Set<string>();
  for (const { label, source, cwd } of suites) {
    if (!source) continue;
    const api = parentSuiteRefusal(label, source);
    if (api) findings.push(api);
    const copies = readRunCopiesRefusal(label, source);
    if (copies) findings.push(copies);
    const tests = suiteTestFileImports(cwd ?? '.', source);
    const fresh = tests.filter(specifier => !memo.has(`suite-test-import|${planner}|${specifier}`));
    if (fresh.length) {
      findings.push(`Acceptance suite ${label} imports ${fresh.join(', ')}, ${fresh.length === 1 ? 'a test file' : 'test files'}: ` +
        'its assertions would be the child\'s. Write the assertions in the suite itself and import only the modules it tests.');
      for (const specifier of fresh) told.add(`suite-test-import|${planner}|${specifier}`);
    }
    const kept = tests.filter(specifier => !fresh.includes(specifier));
    if (kept.length) {
      facts.push(`HOST FACT: Acceptance suite ${label} imports ${kept.join(', ')}, named like a test file. The planner was told once ` +
        'and kept it: approve only if it is an application module, not a suite whose assertions the child writes.');
    }
  }
  if (findings.length === 0) return { facts };
  for (const key of told) memo.add(key);
  return { refusal: findings.join(' '), facts };
}
