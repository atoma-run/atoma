import { analyseProjectCode, codeRelations, type ProjectCodeAnalysis } from './retrievalCode.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  DEFAULT_PROJECT_RETRIEVAL_CHUNKS, PROJECT_RETRIEVAL_CORPUS_LIMITS, PROJECT_RETRIEVAL_TOKENIZER,
  projectRetrievalChunkSettingsSchema, projectRetrievalIndexConfigSchema,
  projectRetrievalManifestSchema, type ProjectRetrievalChunkSettings,
  type ProjectRetrievalIndexConfig, type ProjectRetrievalManifest,
} from '../contracts/projectRetrievalCorpus.js';
import { isPlainProjectDocument, isProjectCode, projectRetrievalPassageSchema, type ProjectRetrievalPassage } from '../contracts/projectRetrieval.js';
import { extractProjectDocument } from './retrievalExtract.js';
import type { ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';

export function projectRetrievalHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertRetrievalTime(context: ProjectRetrievalCallContext): void {
  if (context.signal.aborted) throw new Error('project retrieval cancelled');
  if (!Number.isFinite(context.deadlineAt) || Date.now() >= context.deadlineAt) {
    throw new Error('project retrieval deadline exceeded');
  }
}

export function canonicalRetrievalManifest(input: unknown): ProjectRetrievalManifest {
  const parsed = projectRetrievalManifestSchema.parse(input);
  return projectRetrievalManifestSchema.parse({ ...parsed,
    documents: [...parsed.documents].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}

export function retrievalIndexConfig(chunks: Partial<ProjectRetrievalChunkSettings> = {}): ProjectRetrievalIndexConfig {
  return projectRetrievalIndexConfigSchema.parse({
    storageVersion: 1, extractionVersion: 'utf8-files-v1', chunkerVersion: 'markdown-lines-v1',
    chunks: projectRetrievalChunkSettingsSchema.parse({ ...DEFAULT_PROJECT_RETRIEVAL_CHUNKS, ...chunks }),
    contextVersion: 'path-headings-source-v1', tokenizer: PROJECT_RETRIEVAL_TOKENIZER,
    normalization: 'original-bytes; no overlap', embedding: null, generatedContext: null,
  });
}

export function retrievalConfigForManifest(manifest: ProjectRetrievalManifest,
  chunks: Partial<ProjectRetrievalChunkSettings> = {}): ProjectRetrievalIndexConfig {
  const config = retrievalIndexConfig(chunks);
  if (manifest.documents.some(d => isProjectCode(d.path))) return projectRetrievalIndexConfigSchema.parse({ ...config,
    chunkerVersion: 'typescript-symbols-v1', normalization: manifest.documents.some(d => !isPlainProjectDocument(d.path)) ? 'original-text-or-extracted-utf8; no overlap' : 'original-bytes; no overlap', extractionVersion: manifest.documents.some(d => !isPlainProjectDocument(d.path)) ? 'officeparser-7.8.0-v1' : 'utf8-files-v1' });
  return manifest.documents.some(d => !isPlainProjectDocument(d.path))
    ? projectRetrievalIndexConfigSchema.parse({ ...config, extractionVersion: 'officeparser-7.8.0-v1',
      normalization: 'original-text-or-extracted-utf8; no overlap' }) : config;
}

export function retrievalGeneration(manifest: ProjectRetrievalManifest, config: ProjectRetrievalIndexConfig): string {
  return projectRetrievalHash(JSON.stringify([projectRetrievalHash(JSON.stringify(manifest)), config]));
}

export function retrievalDocumentId(path: string, sha256: string): string {
  return projectRetrievalHash(JSON.stringify([path, sha256]));
}

/** Searchable decoration is never substituted for an original-source excerpt. */
export function retrievalPassageContext(manifest: ProjectRetrievalManifest, passage: ProjectRetrievalPassage): string {
  return [passage.path, ...(passage.code ? [passage.code.symbol, passage.code.signature,
    passage.code.symbol.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')] : []), ...passage.headingContext, manifest.corpusId, manifest.snapshotId,
    manifest.snapshotSha256, passage.sha256].join('\n');
}

export interface PreparedProjectRetrievalCorpus {
  readonly manifest: ProjectRetrievalManifest;
  readonly config: ProjectRetrievalIndexConfig;
  readonly generation: string;
  readonly passages: readonly Readonly<ProjectRetrievalPassage>[];
}

/** Source roots must be host-owned immutable snapshots, never a live worker workspace. */
export async function captureProjectDocument(root: string, document: ProjectRetrievalManifest['documents'][number],
  context: ProjectRetrievalCallContext): Promise<Buffer> {
  let file = root;
  for (const segment of document.path.split('/')) {
    file = resolve(file, segment);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('document symlinks are not admitted');
  }
  const canonical = await realpath(file);
  if (!canonical.startsWith(root + sep)) throw new Error('document escapes snapshot');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || ((before.mode & 0o111) !== 0 && !isProjectCode(document.path)) || before.size !== document.bytes) {
      throw new Error('document is not an admitted regular file');
    }
    // Bounded even if a file grows after stat. Never readFile an unbounded descriptor.
    const bytes = Buffer.alloc(document.bytes + 1);
    let count = 0;
    while (count < bytes.length) {
      assertRetrievalTime(context);
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    const captured = bytes.subarray(0, count);
    if (count !== document.bytes || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        await realpath(file) !== canonical || projectRetrievalHash(captured) !== document.sha256 ||
        (isPlainProjectDocument(document.path) && (captured.includes(0) || !Buffer.from(captured.toString('utf8'), 'utf8').equals(captured)))) {
      throw new Error('document changed or is not the admitted UTF-8 source');
    }
    return captured;
  } finally { await handle.close(); }
}

interface SourceLine { start: number; end: number; number: number; text: string }

function sourceLines(bytes: Buffer): SourceLine[] {
  const lines: SourceLine[] = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    lines.push({ start, end, number: lines.length + 1, text: bytes.subarray(start, end).toString('utf8') });
    start = end;
  }
  return lines;
}

export function chunkDocument(document: ProjectRetrievalManifest['documents'][number], bytes: Buffer,
  settings: ProjectRetrievalChunkSettings, extraction?: ProjectRetrievalPassage['extraction'], analysis?: ProjectCodeAnalysis): Readonly<ProjectRetrievalPassage>[] {
  const lines = sourceLines(bytes);
  const passages: Readonly<ProjectRetrievalPassage>[] = [];
  const boundaries = new Set(analysis?.symbols.map(s => s.startLine));
  const headings: { level: number; title: string }[] = [];
  let start = -1, end = -1, startLine = 1, endLine = 1;
  const flush = () => {
    if (start < 0) return;
    const passage = projectRetrievalPassageSchema.parse({
      documentId: retrievalDocumentId(document.path, document.sha256), path: document.path, sha256: document.sha256,
      startByte: start, endByte: end, startLine, endLine, ...(extraction ? { extraction } : {}),
      headingContext: headings.map(h => h.title), excerpt: bytes.subarray(start, end).toString('utf8'),
    });
    Object.freeze(passage.headingContext);
    if (passage.extraction) Object.freeze(passage.extraction);
    passages.push(Object.freeze(passage));
    start = -1;
  };
  const append = (line: SourceLine) => {
    let offset = line.start;
    while (offset < line.end) {
      if (start >= 0 && (line.end - start > settings.maxBytes || line.number - startLine >= settings.maxLines)) flush();
      let until = Math.min(line.end, offset + settings.maxBytes);
      // UTF-8 continuation bytes and CRLF pairs may not straddle a fallback split.
      while (until < line.end && (bytes[until]! & 0xc0) === 0x80) until--;
      if (until < line.end && bytes[until - 1] === 13 && bytes[until] === 10) until--;
      if (start < 0) { start = offset; startLine = line.number; }
      end = until; endLine = line.number;
      offset = until;
      if (until < line.end) flush();
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (boundaries.has(line.number)) flush();
    const markdown = document.path.toLowerCase().endsWith('.md');
    const heading = markdown ? /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line.text) : null;
    const setext = markdown && !heading && line.text.trim() && i + 1 < lines.length ?
      /^ {0,3}(=+|-+)[ \t]*\r?\n?$/.exec(lines[i + 1]!.text) : null;
    if (heading || setext) {
      flush();
      const level = heading ? heading[1]!.length : setext![1]![0] === '=' ? 1 : 2;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, title: Array.from(heading ? heading[2]! : line.text.trim()).slice(0, 128).join('') });
      append(line);
      if (setext) append(lines[++i]!);
      continue;
    }
    const fence = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(line.text) : null;
    if (fence) {
      let last = i;
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?\\n?$`);
      while (last + 1 < lines.length) { last++; if (closing.test(lines[last]!.text)) break; }
      // Keep a complete bounded fence together; oversized fences use the same exact-byte fallback.
      if (start >= 0 && (lines[last]!.end - start > settings.maxBytes ||
          lines[last]!.number - startLine >= settings.maxLines)) flush();
      for (; i <= last; i++) append(lines[i]!);
      i--;
    } else append(line);
  }
  flush();
  return passages;
}

/**
 * `omitUnextractable` is for the two places that DECIDE a corpus (a run's
 * launch receipt and the client reader): a binary document whose text cannot
 * be extracted leaves the manifest and is counted in `coverage.omitted`
 * instead of failing everything. Run `ea294153` (2026-10-09) was asked to
 * repair a malformed PDF and never started, because that PDF was in its seed.
 * Ingesting an already decided manifest (the run-owned Haystack process) stays
 * strict: a receipt that promised a document must deliver it.
 */
export interface ProjectRetrievalIngestionOptions {
  readonly omitUnextractable?: boolean;
}

export async function prepareProjectRetrievalCorpus(root: string, input: unknown,
  context: ProjectRetrievalCallContext, chunks: Partial<ProjectRetrievalChunkSettings> = {},
  options: ProjectRetrievalIngestionOptions = {}): Promise<PreparedProjectRetrievalCorpus> {
  try {
    assertRetrievalTime(context);
    const canonicalRoot = await realpath(root);
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error('invalid snapshot root');
    return await prepareProjectRetrievalSources(input, context, document => captureProjectDocument(canonicalRoot, document, context), chunks, options);
  } catch (cause) { assertRetrievalTime(context); throw new Error('project document ingestion failed', { cause }); }
}

/** Shared ingestion over authority-verified bytes, also used by the client reader. */
export async function prepareProjectRetrievalSources(input: unknown, context: ProjectRetrievalCallContext,
  read: (document: ProjectRetrievalManifest['documents'][number]) => Promise<Buffer>,
  chunks: Partial<ProjectRetrievalChunkSettings> = {},
  options: ProjectRetrievalIngestionOptions = {}): Promise<PreparedProjectRetrievalCorpus> {
  try {
    assertRetrievalTime(context);
    let manifest = canonicalRetrievalManifest(input);
    let config = retrievalConfigForManifest(manifest, chunks);
    const passages: Readonly<ProjectRetrievalPassage>[] = [];
    let extractedBytes = 0;
    const analyses = new Map<string, ProjectCodeAnalysis>();
    const unextractable = new Set<string>();
    for (const document of manifest.documents) {
      assertRetrievalTime(context);
      const bytes = await read(document);
      if (bytes.length !== document.bytes || projectRetrievalHash(bytes) !== document.sha256 ||
          (isPlainProjectDocument(document.path) && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))) throw new Error('source mismatch');
      if (isPlainProjectDocument(document.path)) {
        const analysis = isProjectCode(document.path) ? analyseProjectCode(document.path, bytes.toString('utf8'), manifest.documents.map(d => d.path)) : undefined;
        if (analysis) analyses.set(document.path, analysis);
        passages.push(...chunkDocument(document, bytes, config.chunks, undefined, analysis));
      }
      else {
        let extracted: Buffer;
        try { extracted = await extractProjectDocument(document.path, bytes, context); }
        catch (error) {
          // A cancelled or expired preparation is never an omission.
          assertRetrievalTime(context);
          if (!options.omitUnextractable) throw error;
          unextractable.add(document.path);
          continue;
        }
        extractedBytes += extracted.length;
        if (extractedBytes > PROJECT_RETRIEVAL_CORPUS_LIMITS.sourceBytes) throw new Error('extracted corpus too large');
        passages.push(...chunkDocument(document, extracted, config.chunks, {
          kind: 'extracted-text', version: 'officeparser-7.8.0-v1',
          sha256: projectRetrievalHash(extracted), bytes: extracted.length,
        }));
      }
      if (passages.length > PROJECT_RETRIEVAL_CORPUS_LIMITS.passages) throw new Error('too many passages');
    }
    const relations = new Map([...analyses.keys()].map(path => [path, codeRelations(path, analyses)]));
    for (let i = 0; i < passages.length; i++) {
      const passage = passages[i]!;
      const analysis = analyses.get(passage.path);
      if (!analysis) continue;
      let low = 0, high = analysis.symbols.length;
      while (low < high) { const mid = (low + high) >>> 1;
        if (analysis.symbols[mid]!.startLine <= passage.startLine) low = mid + 1; else high = mid;
      }
      const candidate = analysis.symbols[low - 1];
      const symbol = candidate && candidate.endLine >= passage.startLine ? candidate : undefined;
      passages[i] = Object.freeze(projectRetrievalPassageSchema.parse({ ...passage, code: {
        ...(symbol ?? { symbol: '<module>', kind: 'SourceFile', signature: '', startLine: passage.startLine,
          endLine: passage.endLine, parseStatus: analysis.parseStatus }), ...relations.get(passage.path)!,
      } }));
    }
    assertRetrievalTime(context);
    if (unextractable.size) {
      // The omitted documents contributed no passage. The snapshot identity is
      // unchanged: it names the authority's snapshot, which may hold non-indexed assets.
      const coverage = manifest.coverage && { ...manifest.coverage,
        indexed: manifest.coverage.indexed - unextractable.size, omitted: manifest.coverage.omitted + unextractable.size };
      manifest = canonicalRetrievalManifest({ ...manifest, ...(coverage ? { coverage } : {}),
        documents: manifest.documents.filter(document => !unextractable.has(document.path)) });
      config = retrievalConfigForManifest(manifest, chunks);
    }
    return Object.freeze({ manifest, config, generation: retrievalGeneration(manifest, config),
      passages: Object.freeze(passages) });
  } catch (cause) {
    assertRetrievalTime(context);
    throw new Error('project document ingestion failed', { cause });
  }
}
