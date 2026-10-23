import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const plan = JSON.parse(readFileSync(root + 'analysis-plan.json', 'utf8'));
const revision = plan.selectorRevision;
if (revision !== 'f9d71587b1f2111de0d636d31c2734489ca44da5') throw Error('Unexpected selector revision');
const source = execFileSync('git', ['show', revision + ':src/atoms/verdict.ts'], { encoding: 'utf8' });
const names = new Set(['requestField', 'probeCommand', 'shellEvidenceExcerpt', 'renderTransportEvidence']);
const parsed = ts.createSourceFile('verdict.ts', source, ts.ScriptTarget.Latest, true);
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(parsed));
if (functions.length !== names.size) throw Error('Missing pinned renderer functions');
const selected = 'const MAX_TOOL_EVIDENCE_CHARS = budget; const MAX_BROWSER_EVIDENCE_LINES = 8;\n' + functions.join('\n');
const compiled = ts.transpileModule(selected, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const hash = text => createHash('sha256').update(text).digest('hex');
const sources = { current: { revision, sourceSha256: hash(source), projectionSha256: hash(compiled), compiled } };
const protocol = { ...plan, phaseA: { runs: [plan.runId] } };
const template = readFileSync(root + 'projection-audit.template.mjs', 'utf8');
writeFileSync(root + 'projection-audit.host.mjs', template.replace('__PROTOCOL__', JSON.stringify(protocol)).replace('__SOURCES__', JSON.stringify(sources)));
writeFileSync(root + 'projection-source.json', JSON.stringify({ revision, sourceSha256: hash(source), projectionSha256: hash(compiled) }, null, 2) + '\n');
console.log(JSON.stringify({ revision, sourceSha256: hash(source), projectionSha256: hash(compiled), paidCalls: 0 }));
