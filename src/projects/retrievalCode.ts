import ts from 'typescript';
import { posix } from 'node:path';
import { isProjectCode, type ProjectCodeMetadata } from '../contracts/projectRetrieval.js';

/** Parse source only: never load tsconfig, resolve packages, execute code or read outside the admitted set. */
export function analyseProjectCode(path: string, text: string, admitted: readonly string[]) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const parseStatus = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length
    ? 'syntax-errors' as const : 'parsed' as const;
  const symbols: Omit<ProjectCodeMetadata, 'relations' | 'relationsTruncated'>[] = [];
  const imports = new Set<string>();
  const paths = new Set(admitted);
  const resolve = (specifier: string) => {
    if (!specifier.startsWith('.')) return;
    const base = posix.normalize(posix.join(posix.dirname(path), specifier));
    if (base.startsWith('../') || base.startsWith('/')) return;
    // JS import spellings in TS sources are resolved only when unambiguous.
    const stem = base.replace(/\.(?:mjs|cjs|js|jsx)$/, '');
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].map(e => base + e),
      ...['.ts', '.tsx', '.mts', '.cts'].map(e => stem + e),
      ...['.ts', '.tsx', '.js', '.jsx'].map(e => base + '/index' + e)];
    const found = [...new Set(candidates)].filter(p => paths.has(p) && isProjectCode(p));
    if (found.length === 1) imports.add(found[0]!);
  };
  const line = (offset: number) => source.getLineAndCharacterOfPosition(offset).line + 1;
  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) resolve(statement.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)) resolve(statement.moduleReference.expression.text);
    const named = statement as ts.Statement & { name?: ts.DeclarationName; body?: ts.Node };
    const name = named.name?.getText(source) ?? (ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(d => d.name.getText(source)).join(', ') : '<module>');
    const start = statement.getStart(source);
    const signatureEnd = named.body?.getStart(source) ?? Math.min(statement.end, start + 512);
    symbols.push({ symbol: name.slice(0, 256), kind: ts.SyntaxKind[statement.kind],
      signature: text.slice(start, signatureEnd).replace(/\s+/g, ' ').slice(0, 512),
      startLine: line(start), endLine: line(Math.max(start, statement.end - 1)), parseStatus });
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      for (const member of statement.members) {
        if (!member.name) continue;
        const memberStart = member.getStart(source);
        const body = (member as ts.Node & { body?: ts.Node }).body;
        symbols.push({ symbol: `${name}.${member.name.getText(source)}`.slice(0, 256), kind: ts.SyntaxKind[member.kind],
          signature: text.slice(memberStart, body?.getStart(source) ?? Math.min(member.end, memberStart + 512)).replace(/\s+/g, ' ').slice(0, 512),
          startLine: line(memberStart), endLine: line(Math.max(memberStart, member.end - 1)), parseStatus });
      }
    }
  }
  // Syntax errors retain exact text but never advertise resolved dependencies.
  return { symbols, imports: parseStatus === 'parsed' ? [...imports].sort() : [], parseStatus };
}

export type ProjectCodeAnalysis = ReturnType<typeof analyseProjectCode>;
export function codeRelations(path: string, analyses: ReadonlyMap<string, ProjectCodeAnalysis>) {
  const all: ProjectCodeMetadata['relations'] = [
    ...(analyses.get(path)?.imports ?? []).map(target => ({ path: target, kind: 'imports' as const })),
    ...[...analyses].filter(([, a]) => a.imports.includes(path)).map(([target]) => ({ path: target, kind: 'imported-by' as const })),
  ];
  return { relations: all.slice(0, 20), relationsTruncated: all.length > 20 };
}
