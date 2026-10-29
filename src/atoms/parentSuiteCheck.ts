import path from 'node:path';
import ts from 'typescript';
import { WATCHED_PROTOTYPES, WATCHED_STATICS } from '../contracts/assertionIntegrity.js';
import { PARENT_TEST_AUTHORED_SOURCE_MAX_CHARS, PARENT_TEST_SOURCE_TARGET_CHARS, VITEST_BUILTIN_MATCHERS } from '../contracts/parentTests.js';
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

// These entrypoints belong to the coordinator/build process, never the
// restricted test thread. Match actual runtime module specifiers, not text
// mentioning configuration, type imports, or application modules in general.
function configurationEntrypoint(specifier: string): boolean {
  return specifier === 'vite' || specifier === 'vitest/config' ||
    /(?:^|\/)vite(?:st)?\.config\.(?:[cm]?[jt]s)$/.test(specifier);
}

function runtimeModuleSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly || clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(each => each.isTypeOnly)) return undefined;
    return node.moduleSpecifier;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 && node.exportClause.elements.every(each => each.isTypeOnly)) return undefined;
    return node.moduleSpecifier;
  }
  return undefined;
}

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
 * there are none. A source that does not parse yields nothing here, since
 * `parentSuiteParseRefusal` reports it. Strings and comments are never read.
 */
export function parentSuiteUnsupported(source: string): string[] {
  const file = ts.createSourceFile('atoma.acceptance.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (suiteParseErrors(file).length) return [];
  const found = new Set<string>();
  const extended = new Set<string>();
  const visit = (node: ts.Node): void => {
    const module = runtimeModuleSpecifier(node);
    if (module && ts.isStringLiteralLike(module) && configurationEntrypoint(module.text)) {
      found.add(`configuration import ${JSON.stringify(module.text)}`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier) && configurationEntrypoint(specifier.text)) {
        found.add(`configuration import ${JSON.stringify(specifier.text)}`);
      }
    }
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
    'equality reads (Object.is, Object.keys, Array.prototype methods and the like). ' +
    'Read project Vite/Vitest configuration as data with node:fs, never import/evaluate its build-tool entrypoint in the restricted test thread. Revise the suite.';
}

/** One syntax error of a suite source: where TypeScript's parser stopped and why. */
export interface SuiteParseDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** The error sits on a backslash outside any string, regex or template: a second escaping layer's mark. */
  readonly atBackslash: boolean;
}

/**
 * Strict-mode lexical errors TypeScript's parser reports and the runner's
 * (oxc, through Vite) accepts: a legacy octal literal (`0777`, 1121), an octal
 * escape (`'\01'`, 1487), `'\8'` (1488), a decimal with a leading zero (`08`,
 * 1489). Refusing them would refuse a suite whose tests run. 1487 and 1488
 * stay errors inside an untagged template, where the runner refuses them too.
 */
const RUNNER_ACCEPTS = new Set([1121, 1487, 1488, 1489]);
const TEMPLATE_ESCAPES = new Set([1487, 1488]);
const TEMPLATE_KINDS = new Set([ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
const LITERAL_KINDS = new Set([...TEMPLATE_KINDS, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.RegularExpressionLiteral]);

const isAsync = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(each => each.kind === ts.SyntaxKind.AsyncKeyword) ?? false);

/**
 * One walk of the tree TypeScript built: the string, regex and template tokens
 * (where a backslash is the source's own), and the module errors TypeScript
 * leaves to its checker while the runner refuses them at parse: `await` or
 * `for await` whose nearest function is not async (a test callback written
 * without `async`; a class field initializer counts as one), `return` outside
 * any function. Top-level `await` is a module's own. A computed name or a
 * decorator belongs to the enclosing function, as the language evaluates it.
 */
function suiteModuleScan(file: ts.SourceFile): { literals: Array<{ start: number; end: number; template: boolean }>; misplaced: Array<{ start: number; message: string }> } {
  const literals: Array<{ start: number; end: number; template: boolean }> = [];
  const misplaced: Array<{ start: number; message: string }> = [];
  const visit = (node: ts.Node, context: 'module' | 'async' | 'sync'): void => {
    if (LITERAL_KINDS.has(node.kind)) literals.push({ start: node.getStart(file), end: node.end, template: TEMPLATE_KINDS.has(node.kind) });
    if (ts.isAwaitExpression(node) && context === 'sync') {
      misplaced.push({ start: node.getStart(file), message: "'await' expressions are only allowed within async functions and at the top levels of modules" });
    }
    if (ts.isForOfStatement(node) && node.awaitModifier && context === 'sync') {
      misplaced.push({ start: node.getStart(file), message: "'for await' loops are only allowed within async functions and at the top levels of modules" });
    }
    if (ts.isReturnStatement(node) && context === 'module') {
      misplaced.push({ start: node.getStart(file), message: "A 'return' statement can only be used within a function body" });
    }
    const inner = ts.isFunctionLike(node) ? (isAsync(node) ? 'async' : 'sync') : context;
    ts.forEachChild(node, child => visit(child,
      ts.isPropertyDeclaration(node) && child === node.initializer ? 'sync'
        : child === (node as { name?: ts.Node }).name || ts.isDecorator(child) ? context : inner));
  };
  visit(file, 'module');
  return { literals, misplaced };
}

/**
 * The syntax errors of a suite source, as the runner's parser reads the file
 * it writes (`atoma.acceptance.test.ts`); empty when it parses. That parser
 * (oxc, through Vite, in the worker) is not a control-plane dependency, so
 * TypeScript's, already loaded here, stands in for it with two corrections
 * measured against Vite's `parseAst` (2026-10-25): the strict-mode lexical
 * errors oxc accepts are dropped (`RUNNER_ACCEPTS`), and the module errors
 * TypeScript leaves to its checker are found by `suiteModuleScan`, reported
 * only once the source parses otherwise. So corrected, they agreed on each
 * of 5,381 sources that day (this repository's sources and tests, its
 * dependencies' test files and JavaScript modules). Agreement, not parity: an
 * error neither covers still surfaces at run time as "the suite module did
 * not load". One parse and one walk, bounded by the suite size (32,000).
 */
export function parentSuiteParseDiagnostics(source: string): SuiteParseDiagnostic[] {
  return suiteParseErrors(ts.createSourceFile('atoma.acceptance.test.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
}

function suiteParseErrors(file: ts.SourceFile): SuiteParseDiagnostic[] {
  const source = file.text;
  const parsed = (file as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const { literals, misplaced } = suiteModuleScan(file);
  const within = (start: number, template?: boolean): boolean =>
    literals.some(each => each.start <= start && start < each.end && (template === undefined || each.template === template));
  const errors = parsed.filter(each => !RUNNER_ACCEPTS.has(each.code) || (TEMPLATE_ESCAPES.has(each.code) && within(each.start, true)))
    .map(each => ({ start: each.start, message: ts.flattenDiagnosticMessageText(each.messageText, ' ') }));
  return (errors.length > 0 ? errors : misplaced).map(({ start, message }) => {
    const { line, character } = file.getLineAndCharacterOfPosition(start);
    return { line: line + 1, column: character + 1, message: message.slice(0, 160), atBackslash: source[start] === '\\' && !within(start) };
  });
}

/**
 * A suite whose source does not parse (run 7d071257, 2026-10-25): a cell's
 * plan reply carried `\\n` for every line break, so the suite held the two
 * characters `\n` and no line break. The runner answered "the suite module did
 * not load; no test ran", the child could not edit the parent's suite, and the
 * root refused a delivery whose code was verified correct. Refused every
 * time, unlike an escaped regex backslash (`suiteRegexPrecheck`): that one is
 * a heuristic a deliberate pattern may trip, this is a fact, since a module
 * that does not parse runs no test whatever the planner meant.
 */
export function parentSuiteParseRefusal(label: string, source: string): string | undefined {
  const diagnostics = parentSuiteParseDiagnostics(source);
  if (diagnostics.length === 0) return undefined;
  const shown = diagnostics.slice(0, 3).map(each => `line ${each.line}, column ${each.column}: ${each.message.replace(/\.$/, '')}`).join('; ');
  const more = diagnostics.length > 3 ? ` (${diagnostics.length} errors in all)` : '';
  // A source escaped twice errs on a bare backslash, outside any string, regex or template; with no line
  // break, its `\n`s are the flattened line breaks. A one-line suite's `'\n'` in a string is neither.
  const escapedTwice = diagnostics.some(each => each.atBackslash);
  const flattened = escapedTwice && !source.includes('\n') && source.includes('\\n');
  const twice = !escapedTwice ? '' : (flattened
    ? ' Its source holds the two characters \\n and no line break: it was escaped twice in the JSON and must carry real line breaks.'
    : ' A backslash stands outside any string: the source was escaped twice in the JSON.') +
    ' Escape once: a line break is \\n in the JSON string, never \\\\n, and a backslash the TypeScript keeps is \\\\, never \\\\\\\\.';
  return `Acceptance suite ${label} does not parse as the TypeScript module the runner loads, so no test in it can run: ` +
    `${shown}${more}.${twice} Revise the suite.`;
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
 * computed patterns are never read; a source that does not parse yields
 * nothing here, since `parentSuiteParseRefusal` reports it.
 */
export function parentSuiteRegexFindings(source: string): SuiteRegexFinding[] {
  const file = ts.createSourceFile('atoma.acceptance.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (suiteParseErrors(file).length) return [];
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

/** The script kind TypeScript parses a file name as. */
export const scriptKindOf = (fileName: string): ts.ScriptKind =>
  /\.(?:[cm]?jsx?)$/.test(fileName) ? ts.ScriptKind.JS : /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/** `require`, and every variable a `createRequire(…)` call initializes: each loads as `require` does. */
export function requireNames(file: ts.SourceFile): Set<string> {
  const names = new Set(['require']);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if ((ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '') === 'createRequire') names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/**
 * What a source loads, read from its syntax: the one definition behind
 * `relativeSpecifiers` (the test-file precheck, the host facts) and the reach
 * walk of `parentSuiteReach.ts`. A load is an import or export-from,
 * `import x = require()`, `import()`, or `require()` through `require` itself
 * or a `createRequire` result; `import type` and `export type … from` are
 * erased and load nothing. Tolerant like the checks above: a source that does
 * not parse yields what its parse recovered, and `parsed` says so.
 */
export interface ModuleSpecifiers {
  /** Relative specifiers loaded with a literal, as written, in source order. */
  readonly relative: readonly string[];
  /** Relative specifiers handed to `require.resolve`: a path the source means to use, never loaded here. */
  readonly resolved: readonly string[];
  /** Every other literal specifier: a builtin, a package, an alias, an `#import`, an absolute path. */
  readonly bare: readonly string[];
  /** One entry per load or resolve whose specifier is computed: the literal pieces of its argument. */
  readonly computed: ReadonlyArray<readonly string[]>;
  /** `import.meta.glob`, which loads whatever its patterns match. */
  readonly glob: boolean;
  /** Every string literal and template piece under 300 characters, specifiers included. */
  readonly literals: readonly string[];
  /** The same without the specifiers of loads and resolves: a path the source names for any other use. */
  readonly mentions: readonly string[];
  readonly parsed: boolean;
}

export function moduleSpecifiers(source: string, fileName = 'atoma.acceptance.test.ts'): ModuleSpecifiers {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const requires = requireNames(file);
  const loads: string[] = [];
  const resolves: string[] = [];
  const computed: string[][] = [];
  const specifiers = new Set<ts.Node>();
  const literals = new Set<string>();
  const mentions = new Set<string>();
  let glob = false;
  const pieces = (argument: ts.Node): string[] => {
    const found: string[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
      ts.forEachChild(node, collect);
    };
    collect(argument);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.add(node.moduleSpecifier);
      const erased = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
      if (!erased && ts.isStringLiteral(node.moduleSpecifier)) loads.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifiers.add(node.moduleReference.expression);
      if (!node.isTypeOnly && ts.isStringLiteral(node.moduleReference.expression)) loads.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      const argument = node.arguments[0]!;
      const load = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requires.has(callee.text));
      const resolve = ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ts.isIdentifier(callee.expression) &&
        requires.has(callee.expression.text);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text.startsWith('glob') && ts.isMetaProperty(callee.expression)) glob = true;
      if (load || resolve) {
        if (ts.isStringLiteralLike(argument)) {
          specifiers.add(argument);
          (load ? loads : resolves).push(argument.text);
        } else computed.push(pieces(argument));
      }
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.length < 300) {
      literals.add(node.text);
      if (!specifiers.has(node)) mentions.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const relative = (specifier: string): boolean => specifier.startsWith('./') || specifier.startsWith('../');
  return {
    relative: [...new Set(loads.filter(relative))],
    resolved: [...new Set(resolves.filter(relative))],
    bare: [...new Set([...loads, ...resolves].filter(specifier => !relative(specifier)))],
    computed, glob, literals: [...literals], mentions: [...mentions],
    parsed: !(file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length,
  };
}

/** The relative specifiers a source loads (`moduleSpecifiers`). */
export function relativeSpecifiers(source: string, fileName = 'atoma.acceptance.test.ts'): string[] {
  return [...moduleSpecifiers(source, fileName).relative];
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

/** The other spellings of one module: what its `.js` specifier also loads (`TWINS`), and back. */
export function twinsOf(file: string): string[] {
  const extension = path.posix.extname(file);
  const stem = file.slice(0, file.length - extension.length);
  const back = Object.entries(TWINS).filter(([, twins]) => twins.includes(extension)).map(([from]) => from);
  return [...(TWINS[extension] ?? []), ...back].map(each => `${stem}${each}`);
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
 * a source that does not parse (`parentSuiteParseRefusal`), the regexes it
 * cannot mean (`suiteRegexPrecheck`), the APIs the runner's
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
  // Named first, in every round: while a source does not parse, none of its tests runs.
  const parse = suites.flatMap(({ label, source }) => {
    const refusal = source ? parentSuiteParseRefusal(label, source) : undefined;
    return refusal ? [refusal] : [];
  });
  const regexes = suiteRegexPrecheck(suites, memo, planner);
  const findings: string[] = [...parse, ...(regexes.refusal ? [regexes.refusal] : [])];
  const facts = [...regexes.facts];
  const told = new Set<string>();
  for (const { label, source, cwd } of suites) {
    if (!source) continue;
    // Size is a host fact, never a refusal: the parser refuses above
    // PARENT_TEST_AUTHORED_SOURCE_MAX_CHARS; between the target and that bound the
    // review asks for a split instead of spending a replan on a number the
    // planner already read (run 1622e44b, refusal 009f114d, 2026-10-22).
    if (source.length > PARENT_TEST_SOURCE_TARGET_CHARS) {
      facts.push(`HOST FACT: Acceptance suite ${label} is ${source.length.toLocaleString('en-US')} characters. The host ACCEPTS it ` +
        `(its refusal is at ${PARENT_TEST_AUTHORED_SOURCE_MAX_CHARS.toLocaleString('en-US')}); the soft target is ` +
        `${PARENT_TEST_SOURCE_TARGET_CHARS.toLocaleString('en-US')}. Size alone never refuses a plan: if the branch's contract needs ` +
        'more, ask for the branch to be split, never for a shorter suite.');
    }
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
