import { parseArgs } from 'node:util';
import { resolve, basename, sep } from 'node:path';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { haystackModelRevision } from '../dist/projects/retrievalModelFiles.js';
const { values } = parseArgs({ options: { embedding: { type: 'string' }, reranker: { type: 'string' }, 'query-prefix': { type: 'string' }, 'document-prefix': { type: 'string' } } });
if (!values.embedding || !values.reranker || values['query-prefix'] === undefined) throw new Error('Supply --embedding, --reranker and --query-prefix (may be empty)');
const out = resolve('dist/compute-models');
const context = { signal: AbortSignal.timeout(120_000), deadlineAt: Date.now() + 120_000 };
const revisions = {};
for (const name of ['embedding', 'reranker']) {
  const source = resolve(values[name]), destination = resolve(out, name);
  if (source === destination || source.startsWith(out + sep)) throw new Error('Use a source outside dist/compute-models');
  const revision = await haystackModelRevision(source, context);
  mkdirSync(out, { recursive: true }); rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, dereference: false,
    filter: path => path === source || !basename(path).startsWith('.') });
  if (await haystackModelRevision(destination, context) !== revision) throw new Error('Model changed while packaging');
  revisions[`${name}Revision`] = revision;
}
writeFileSync(resolve(out, 'models.json'), JSON.stringify({ mode: 'hybrid-rerank', ...revisions, queryPrefix: values['query-prefix'], documentPrefix: values['document-prefix'] ?? '' }, null, 2));
console.log(JSON.stringify(revisions));
