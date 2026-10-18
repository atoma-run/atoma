import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { projectRetrievalHash } from './retrievalCorpus.js';

const DDL = `CREATE TABLE IF NOT EXISTS project_embedding_cache (
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  encoder_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension BETWEEN 1 AND 4096),
  vector BLOB NOT NULL,
  vector_sha256 TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, project_id, encoder_key, input_hash)
);`;
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_VECTOR_BYTES = 4096 * 4;

/** A content-derived key; the query prefix and reranker do not encode documents. */
export function retrievalEncoderKey(embeddingRevision: string, runtimeSha256: string, documentPrefix = ''): string {
  return projectRetrievalHash(JSON.stringify(['dense-document-v1', embeddingRevision, runtimeSha256,
    'sentence-transformers', 'torch', 'cpu', 'float32', 'default-suffix-and-normalization', documentPrefix]));
}

function validVector(vector: Buffer, dimension: number): boolean {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096 ||
      vector.length !== dimension * 4 || vector.length > MAX_VECTOR_BYTES) return false;
  for (let i = 0; i < vector.length; i += 4) if (!Number.isFinite(vector.readFloatLE(i))) return false;
  return true;
}

/** Disposable data in the existing product store. Every operation is best-effort and scoped. */
export class ProjectEmbeddingCache {
  private readonly db: Database.Database;
  constructor(dbPath: string, private readonly orgId: string, private readonly projectId: string,
    private readonly encoderKey: string, options?: { maxDatabaseBytes: number }) {
    this.db = new Database(dbPath, { timeout: 0 });
    try {
      this.db.pragma('busy_timeout = 0');
      if (options) {
        if (!Number.isSafeInteger(options.maxDatabaseBytes) || options.maxDatabaseBytes < 65536 || options.maxDatabaseBytes > MAX_TOTAL_BYTES) throw new Error('Invalid local cache bound');
        const pageSize = this.db.pragma('page_size', { simple: true }) as number;
        this.db.pragma(`max_page_count = ${Math.floor(options.maxDatabaseBytes / pageSize)}`);
      }
      this.db.exec(DDL);
    } catch (error) { this.db.close(); throw error; }
  }

  get(inputHash: string): { vector: Buffer; dimension: number } | null {
    const row = this.db.prepare(`SELECT dimension, vector, vector_sha256 FROM project_embedding_cache
      WHERE org_id = ? AND project_id = ? AND encoder_key = ? AND input_hash = ?`)
      .get(this.orgId, this.projectId, this.encoderKey, inputHash) as
      { dimension: number; vector: Buffer; vector_sha256: string } | undefined;
    if (!row || !validVector(row.vector, row.dimension) ||
        createHash('sha256').update(row.vector).digest('hex') !== row.vector_sha256) return null;
    return { vector: row.vector, dimension: row.dimension };
  }

  putMany(rows: readonly { inputHash: string; vector: Buffer; dimension: number }[]): void {
    if (!rows.length) return;
    const insert = this.db.prepare(`INSERT INTO project_embedding_cache
      (org_id, project_id, encoder_key, input_hash, dimension, vector, vector_sha256, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, project_id, encoder_key, input_hash) DO UPDATE SET
        dimension = excluded.dimension, vector = excluded.vector,
        vector_sha256 = excluded.vector_sha256, used_at = excluded.used_at`);
    const now = Date.now();
    this.db.transaction(() => {
      for (const row of rows) {
        if (!validVector(row.vector, row.dimension)) continue;
        insert.run(this.orgId, this.projectId, this.encoderKey, row.inputHash, row.dimension,
          row.vector, projectRetrievalHash(row.vector), now);
      }
      // Bounded deletions keep one run from holding the product store's write lock indefinitely.
      const projectBytes = (this.db.prepare(`SELECT COALESCE(SUM(length(vector)), 0) AS n
        FROM project_embedding_cache WHERE org_id = ? AND project_id = ?`)
        .get(this.orgId, this.projectId) as { n: number }).n;
      if (projectBytes > MAX_PROJECT_BYTES) this.db.prepare(`DELETE FROM project_embedding_cache WHERE rowid IN
        (SELECT rowid FROM project_embedding_cache WHERE org_id = ? AND project_id = ?
         ORDER BY used_at, rowid LIMIT 256)`).run(this.orgId, this.projectId);
      const totalBytes = (this.db.prepare('SELECT COALESCE(SUM(length(vector)), 0) AS n FROM project_embedding_cache')
        .get() as { n: number }).n;
      if (totalBytes > MAX_TOTAL_BYTES) this.db.prepare(`DELETE FROM project_embedding_cache WHERE rowid IN
        (SELECT rowid FROM project_embedding_cache ORDER BY used_at, rowid LIMIT 256)`).run();
    }).immediate();
  }

  close(): void { this.db.close(); }
}
