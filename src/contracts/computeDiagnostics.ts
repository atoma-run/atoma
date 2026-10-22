import { z } from 'zod';

/** Host-generated metadata only: never log frames, credentials, arguments,
 * remote close text or exception messages (each can contain customer data). */
export const computeDiagnosticSchema = z.object({
  at: z.string().datetime(), side: z.enum(['server', 'client']),
  reason: z.enum(['connected', 'transport-interrupted', 'transport-resumed', 'local-close', 'socket-error', 'socket-close', 'send-error',
    'handshake-timeout', 'heartbeat-failed', 'lease-expired', 'session-invalid',
    'invalid-frame', 'assignment-failed', 'reconciliation-failed', 'workspace-failed',
    'preview-failed', 'retrieval-failed', 'tool-failed', 'control-failed',
    'assignment-timeout', 'workspace-timeout', 'preview-timeout', 'retrieval-timeout',
    'tool-timeout', 'control-timeout', 'stop-confirmed', 'stop-unconfirmed',
    'gateway-shutdown', 'idle-cutover', 'dispatch-finished', 'dispatch-interrupted']),
  connectionId: z.string().uuid(), deviceId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(), connectionGeneration: z.number().int().optional(),
  runId: z.string().uuid().optional(), executionGeneration: z.number().int().optional(),
  ageMs: z.number().nonnegative(), lastReceiveAgoMs: z.number().nonnegative(),
  lastHeartbeatAgoMs: z.number().nonnegative().nullable(),
  socketState: z.number().int(), bufferedBytes: z.number().nonnegative(),
  closeCode: z.number().int().optional(), closeReasonBytes: z.number().nonnegative().optional(),
  failure: z.enum(['schema-validation', 'json-decoding', 'session-expired', 'execution-fenced',
    'unexpected-response', 'mismatched-method', 'replayed-request', 'other']).optional(),
  errorCode: z.enum(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
    'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
    'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']).optional(),
  pending: z.array(z.object({ channel: z.enum(['assignment', 'workspace', 'preview', 'retrieval', 'tools', 'control']),
    id: z.number().int().optional(), method: z.string().regex(/^[a-z-]{1,64}$/).optional(),
    ageMs: z.number().nonnegative().optional(), count: z.number().nonnegative().optional() }).strict()).max(64),
}).strict();
export type ComputeDiagnostic = z.infer<typeof computeDiagnosticSchema>;
export type ComputeCloseReason = ComputeDiagnostic['reason'];

export function computeErrorCode(error: unknown): ComputeDiagnostic['errorCode'] {
  try {
    if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
    const parsed = computeDiagnosticSchema.shape.errorCode.safeParse(error.code);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Classify trusted error categories without copying their payload or message. */
export function computeFailure(error: unknown): ComputeDiagnostic['failure'] {
  if (error instanceof z.ZodError) return 'schema-validation';
  if (error instanceof SyntaxError) return 'json-decoding';
  if (!(error instanceof Error)) return 'other';
  switch (error.message) {
    case 'Compute session expired': case 'Compute session expired or superseded': case 'Compute lease expired':
    case 'Compute lease is not active': return 'session-expired';
    case 'Compute execution unavailable': return 'execution-fenced';
    case 'Unexpected tool result': case 'Unexpected result': case 'Unexpected preview result':
    case 'Unexpected retrieval result': case 'Unexpected assignment': return 'unexpected-response';
    case 'Mismatched result': case 'Mismatched preview result': case 'Mismatched retrieval result':
    case 'Mismatched workspace result': return 'mismatched-method';
    case 'Replayed heartbeat': case 'Replayed compute request': return 'replayed-request';
    default: return 'other';
  }
}

export function recordComputeDiagnostic(record: ComputeDiagnostic, sink?: (line: string) => void): void {
  try {
    const line = `[atoma compute] ${JSON.stringify(computeDiagnosticSchema.parse(record))}\n`;
    process.stderr.write(line);
    sink?.(line);
  } catch { /* Diagnostics must never prevent fencing or confirmed teardown. */ }
}
