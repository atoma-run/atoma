import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { archiveToolEvidence } from '../src/core/evidenceArchive.js';
import { computeClientFrameSchema, COMPUTE_FRAME_BYTES } from '../src/contracts/computeProtocol.js';
import { WORKER_FRAME_BYTES } from '../src/contracts/workerProtocol.js';
import { computeToolResultFrame, readComputeToolResult } from '../src/launcher/computeToolResult.js';

const execution = { runId: randomUUID(), generation: 1 };
it('keeps legacy success and failure frames compatible and the application frame bounded', () => {
  const result = { exitCode: 1, stdout: 'unchanged' };
  expect(computeToolResultFrame(execution, 7, result)).toEqual({ kind: 'tool-result', execution, response: { id: 7, ok: true, result } });
  expect(readComputeToolResult({ id: 7, ok: true, result })).toBe(result);
  expect(computeClientFrameSchema.parse({ kind: 'tool-result', execution, response: { id: 7, ok: false, error: 'original failure' } })).toBeTruthy();
  const frame = computeToolResultFrame(execution, 8, { stdout: 'x'.repeat(COMPUTE_FRAME_BYTES), exitCode: 1 });
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(COMPUTE_FRAME_BYTES);
  expect(computeClientFrameSchema.parse(frame)).toEqual(frame);
  expect(readComputeToolResult(frame.response)).toEqual({ stdout: 'x'.repeat(COMPUTE_FRAME_BYTES), exitCode: 1 });
});

it('names actual size refusals without pretending the live transport disconnected', () => {
  expect(() => computeToolResultFrame(execution, 1, { stdout: 'x'.repeat(WORKER_FRAME_BYTES) })).toThrow('worker response limit');
  expect(() => computeToolResultFrame(execution, 1, { stdout: randomBytes(COMPUTE_FRAME_BYTES).toString('base64') })).toThrow('compressed transfer limit');
});

it('rejects invalid UTF-8 and malformed archived envelopes even with valid byte hashes', () => {
  const bytes = Buffer.concat([Buffer.from('{"request":{},"result":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  expect(() => readComputeToolResult({ id: 1, ok: true, resultArchive: { encoding: 'gzip+base64', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), data: gzipSync(bytes).toString('base64') } })).toThrow('UTF-8');
  const archive = archiveToolEvidence({}, { exitCode: 0 });
  const text = Buffer.from('{"request":{"unexpected":true},"result":null}');
  archive.bytes = text.length; archive.sha256 = createHash('sha256').update(text).digest('hex'); archive.data = gzipSync(text).toString('base64');
  expect(() => readComputeToolResult({ id: 1, ok: true, resultArchive: archive })).toThrow('envelope');
});
