import { projectDocumentFormat, isProjectCode } from '../contracts/projectRetrieval.js';
import { PROJECT_RETRIEVAL_CORPUS_LIMITS } from '../contracts/projectRetrievalCorpus.js';

/** Deterministic bounded admission; documents first, then code. No silent claim of full coverage. */
export function selectRetrievalDocuments(files: readonly { path: string; sha256: string; size: number; mode: string }[]) {
  const eligible = files.filter(f => (f.mode === '100644' || (f.mode === '100755' && isProjectCode(f.path))) && projectDocumentFormat(f.path) !== null)
    .sort((a, b) => Number(isProjectCode(a.path)) - Number(isProjectCode(b.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let bytes = 0;
  const documents: { path: string; sha256: string; bytes: number }[] = [];
  for (const file of eligible) {
    if (documents.length >= PROJECT_RETRIEVAL_CORPUS_LIMITS.documents ||
        file.size > PROJECT_RETRIEVAL_CORPUS_LIMITS.documentBytes || bytes + file.size > PROJECT_RETRIEVAL_CORPUS_LIMITS.sourceBytes) continue;
    bytes += file.size;
    documents.push({ path: file.path, sha256: file.sha256, bytes: file.size });
  }
  return { documents, coverage: { eligible: eligible.length, indexed: documents.length, omitted: eligible.length - documents.length } };
}
