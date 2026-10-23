import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const protocol = JSON.parse(readFileSync(root + 'protocol.json', 'utf8'));
const names = new Set(['requestField', 'probeCommand', 'shellEvidenceExcerpt', 'renderTransportEvidence']);
export const sources = Object.fromEntries(Object.entries(protocol.selectors).map(([arm, revision]) => {
  const source = execFileSync('git', ['show', revision + ':src/atoms/verdict.ts'], { encoding: 'utf8' });
  const parsed = ts.createSourceFile('verdict.ts', source, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(parsed));
  if (!functions.some(text => text.startsWith('export function renderTransportEvidence'))) throw Error('Renderer missing');
  const selected = 'const MAX_TOOL_EVIDENCE_CHARS = budget; const MAX_BROWSER_EVIDENCE_LINES = 8;\n' + functions.join('\n');
  const compiled = ts.transpileModule(selected, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return [arm, { revision, sourceSha256: createHash('sha256').update(source).digest('hex'), projectionSha256: createHash('sha256').update(compiled).digest('hex'), compiled }];
}));
export function renderer(arm, budget) {
  const exports = {};
  // Only pinned repository code is executable. Observations are data, never code.
  const load = new Function('exports', 'transportWitnesses', 'budget', sources[arm].compiled);
  load(exports, evidence => (evidence ?? []).filter(w => w.source === 'transport-observed'), budget);
  return exports.renderTransportEvidence;
}
if (process.argv.includes('--emit')) writeFileSync(root + 'renderers.compiled.json', JSON.stringify(sources, null, 2) + '\n');
