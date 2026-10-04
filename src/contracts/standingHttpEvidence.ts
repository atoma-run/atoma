import { z } from 'zod';

/**
 * HTTP OBSERVATIONS EARLIER RUNS OF THE SAME PROJECT MADE, as the HOST recorded
 * them: `fetch_url` tool events in their traces, answered by a server those
 * runs started (`servedBy`), with the digest of the code that server loaded
 * (`serverCodeDigest`, taken by `start_node_server` before spawn). Never read
 * from `.atoma-probes.json`, which a model can write.
 *
 * Root acceptance counts one toward an HTTP criterion only while the digest
 * recomputed on the delivered workspace is unchanged, and labels it RECORDED
 * EARLIER beside what this attempt observed (owner decision 2026-10-04: four
 * continuation runs of one project re-proved an unchanged backend live and were
 * refused for "no current verification").
 */
export const STANDING_HTTP_EVIDENCE_ENV = 'ATOMA_STANDING_HTTP_EVIDENCE';
export const MAX_STANDING_HTTP_EVIDENCE = 300;
/** One environment string stays far under Linux's 128 KiB per-string limit. */
export const MAX_STANDING_HTTP_EVIDENCE_CHARS = 60_000;

export const standingHttpObservationSchema = z.object({
  runId: z.string().min(1).max(64),
  eventId: z.string().min(1).max(64),
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(512),
  status: z.number().int().min(100).max(599),
  entry: z.string().min(1).max(512),
  codeDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type StandingHttpObservation = z.infer<typeof standingHttpObservationSchema>;

const standingListSchema = z.array(standingHttpObservationSchema).max(MAX_STANDING_HTTP_EVIDENCE);

/** The observations one persisted trace holds, newest first. Tolerant of foreign shapes: they are skipped. */
export function standingHttpObservationsOf(runId: string, trace: unknown): StandingHttpObservation[] {
  const events = trace && typeof trace === 'object' && Array.isArray((trace as { events?: unknown }).events)
    ? (trace as { events: unknown[] }).events : [];
  const out: StandingHttpObservation[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as { id?: unknown; kind?: unknown; name?: unknown; args?: unknown; result?: unknown };
    if (event.kind !== 'tool' || event.name !== 'fetch_url' || typeof event.id !== 'string') continue;
    const args = (event.args ?? {}) as { url?: unknown; method?: unknown };
    const result = (event.result ?? {}) as { status?: unknown; servedBy?: { entry?: unknown; codeDigest?: unknown } };
    if (typeof args.url !== 'string' || typeof result.status !== 'number') continue;
    const entry = result.servedBy?.entry;
    const codeDigest = result.servedBy?.codeDigest;
    if (typeof entry !== 'string' || typeof codeDigest !== 'string') continue;
    let path: string;
    try {
      const url = new URL(args.url);
      path = `${url.pathname}${url.search}` || '/';
    } catch {
      continue;
    }
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    const parsed = standingHttpObservationSchema.safeParse({ runId, eventId: event.id, method, path,
      status: result.status, entry, codeDigest });
    if (parsed.success) out.push(parsed.data);
  }
  return out.reverse();
}

/** Bounded, deduplicated by (method, path, status, codeDigest), first occurrence kept. */
export function encodeStandingHttpEvidence(observations: readonly StandingHttpObservation[]): string | undefined {
  const seen = new Set<string>();
  const kept: StandingHttpObservation[] = [];
  for (const observation of observations) {
    const key = `${observation.method} ${observation.path} ${observation.status} ${observation.codeDigest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (JSON.stringify([...kept, observation]).length > MAX_STANDING_HTTP_EVIDENCE_CHARS) break;
    kept.push(observation);
    if (kept.length >= MAX_STANDING_HTTP_EVIDENCE) break;
  }
  return kept.length > 0 ? JSON.stringify(kept) : undefined;
}

/** Fails CLOSED to nothing: a malformed value is no evidence. */
export function decodeStandingHttpEvidence(raw: string | undefined): StandingHttpObservation[] {
  if (!raw) return [];
  try {
    const parsed = standingListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
