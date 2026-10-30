import { createHash } from 'node:crypto';
import { archiveToolEvidence, readArchivedToolEvidence } from '../core/evidenceArchive.js';
import { COMPUTE_FRAME_BYTES, type ComputeExecution } from '../contracts/computeProtocol.js';
import { computeToolResultArchiveSchema, type ComputeToolResponse } from '../contracts/computeTools.js';
import { WORKER_FRAME_BYTES } from '../contracts/workerProtocol.js';

/** Keep legacy small replies unchanged. Compression carries the complete result,
 * including nested raw logs and nonzero command exits, never an excerpt. */
export function computeToolResultFrame(execution: ComputeExecution, id: number, result: unknown) {
  const frame = { kind: 'tool-result' as const, execution, response: { id, ok: true as const, result } };
  if (Buffer.byteLength(JSON.stringify(frame)) <= COMPUTE_FRAME_BYTES) return frame;
  const captured = JSON.stringify({ request: {}, result });
  if (Buffer.byteLength(captured) > WORKER_FRAME_BYTES) throw new Error('Compute tool result exceeds the worker response limit');
  const compressed = { kind: 'tool-result' as const, execution,
    response: { id, ok: true as const, resultArchive: archiveToolEvidence({}, result) } };
  if (Buffer.byteLength(JSON.stringify(compressed)) > COMPUTE_FRAME_BYTES) {
    throw new Error('Compute tool result exceeds the compressed transfer limit');
  }
  return compressed;
}

/** Call only after request identity and current execution authority are checked.
 * Verify before removing the pending request, so corrupt data fences its effects. */
export function readComputeToolResult(response: Extract<ComputeToolResponse, { ok: true }>): unknown {
  if (!('resultArchive' in response)) return response.result;
  const archive = computeToolResultArchiveSchema.parse(response.resultArchive);
  const text = readArchivedToolEvidence(archive);
  // The shared reader returns UTF-8 text. Rehash its encoding to refuse lossy
  // replacement of malformed input before parsing the authenticated bytes.
  if (createHash('sha256').update(text).digest('hex') !== archive.sha256) throw new Error('Invalid Compute result UTF-8');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !('request' in value) || !('result' in value) ||
      !value.request || typeof value.request !== 'object' || Array.isArray(value.request) || Object.keys(value.request).length) {
    throw new Error('Invalid Compute result envelope');
  }
  return value.result;
}
