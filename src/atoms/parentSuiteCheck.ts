import ts from 'typescript';
import { WATCHED_PROTOTYPES, WATCHED_STATICS } from '../contracts/assertionIntegrity.js';
import { VITEST_BUILTIN_MATCHERS } from '../contracts/parentTests.js';

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
