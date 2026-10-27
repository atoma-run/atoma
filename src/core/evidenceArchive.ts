import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archivedToolEvidenceSchema, type ArchivedToolEvidence } from '../contracts/evidenceReading.js';

/** Capture before any model-facing excerpting. The gzip member is also persisted with the run trace. */
export function archiveToolEvidence(request: Record<string, unknown>, result: unknown): ArchivedToolEvidence {
  const bytes = Buffer.from(JSON.stringify({ request, result }), 'utf8');
  return { encoding: 'gzip+base64', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') };
}

/** Return the captured serialization exactly, never a live filesystem read or a command replay. */
export function readArchivedToolEvidence(value: ArchivedToolEvidence): string {
  const archive = archivedToolEvidenceSchema.parse(value);
  const bytes = gunzipSync(Buffer.from(archive.data, 'base64'), { maxOutputLength: Math.max(1, archive.bytes) });
  if (bytes.length !== archive.bytes || createHash('sha256').update(bytes).digest('hex') !== archive.sha256) {
    throw new Error('Archived evidence integrity check failed');
  }
  return bytes.toString('utf8');
}
