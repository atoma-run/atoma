import { z } from 'zod';
import { projectRunStatusSchema } from './projects.js';

/** Opt-in paging keeps the original no-argument list responses compatible. */
export const projectPageInputSchema = z.object({
  view: z.literal('compact').optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(2048).optional(),
});
export const runPageInputSchema = projectPageInputSchema.extend({ status: projectRunStatusSchema.optional() });
export type ProjectPageInput = z.infer<typeof projectPageInputSchema>;
export type RunPageInput = z.infer<typeof runPageInputSchema>;
export const pageCursorSchema = z.object({ at: z.string().datetime(), id: z.string().min(1), query: z.string() }).strict();
export type PageCursor = z.infer<typeof pageCursorSchema>;

export const compactRunSchema = z.object({
  projectRunId: z.string(), projectId: z.string(), title: z.string().nullable(), goalExcerpt: z.string(),
  status: projectRunStatusSchema, createdAt: z.string(), startedAt: z.string().nullable(), endedAt: z.string().nullable(),
  costUsd: z.number().nullable(), publicationStatus: z.string().nullable(), repositoryUrl: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
});
export type CompactRun = z.infer<typeof compactRunSchema>;

export const serviceProblemSchema = z.object({
  code: z.enum(['invalid_input', 'authentication_required', 'permission_denied', 'not_found', 'conflict',
    'expired', 'too_large', 'busy', 'configuration_required', 'github_required', 'unavailable']),
  message: z.string(),
  retryable: z.boolean(),
  nextAction: z.string(),
  fields: z.array(z.string()).optional(),
});
export type ServiceProblem = z.infer<typeof serviceProblemSchema>;

/** Default guidance follows typed status, never pattern-matches exception prose. */
export function serviceProblem(status: number, message: string, details?: Partial<ServiceProblem>): ServiceProblem {
  const defaults: Record<number, Pick<ServiceProblem, 'code' | 'retryable' | 'nextAction'>> = {
    400: { code: 'invalid_input', retryable: false, nextAction: 'Correct the named arguments and try again.' },
    401: { code: 'authentication_required', retryable: false, nextAction: 'Reconnect Atoma and sign in again.' },
    403: { code: 'permission_denied', retryable: false, nextAction: 'Check your active organisation and ask its administrator for the required role.' },
    404: { code: 'not_found', retryable: false, nextAction: 'List the projects or runs visible to your account and select an existing item.' },
    409: { code: 'conflict', retryable: false, nextAction: 'Read the current run or project state before trying again.' },
    410: { code: 'expired', retryable: false, nextAction: 'Retrieve the published files from the repository; retained workspace bytes have expired.' },
    413: { code: 'too_large', retryable: false, nextAction: 'Choose a smaller file or use the published repository.' },
    429: { code: 'busy', retryable: true, nextAction: 'Wait for the active work to finish, then retry the same request.' },
    503: { code: 'unavailable', retryable: true, nextAction: 'Retry shortly. If this persists, ask the instance administrator to check availability.' },
  };
  return { ...(defaults[status] ?? defaults[503]!), message, ...details };
}

export const runProgressSchema = z.object({
  stage: z.enum(['queued', 'preparing', 'planning', 'building', 'checking', 'finalizing', 'finished', 'unknown']),
  message: z.string(),
  lastActivityAt: z.string().nullable(),
  source: z.enum(['trace', 'run']),
  evidence: z.enum(['available', 'unavailable']),
  criteria: z.array(z.object({ id: z.string(), behaviour: z.string(), status: z.string(), met: z.boolean().nullable(), reason: z.string() })),
  criteriaTruncated: z.boolean(),
  /** Recorded acceptance is evidence of that attempt, not a new delivery decision. */
  acceptanceApproved: z.boolean().nullable(),
});
export type RunProgress = z.infer<typeof runProgressSchema>;

export const artifactPageInputSchema = z.object({
  search: z.string().max(200).optional(), offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const runComparisonInputSchema = artifactPageInputSchema.extend({
  baseRunId: z.string().min(1),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const runComparisonResultSchema = z.object({
  projectId: z.string(), baseRunId: z.string(), runId: z.string(), snapshot: z.string(),
  evidence: z.literal('saved_manifests'), untrusted: z.literal(true),
  base: z.object({ status: z.enum(['delivered', 'partial']), coverage: z.enum(['workspace', 'declared']) }),
  target: z.object({ status: z.enum(['delivered', 'partial']), coverage: z.enum(['workspace', 'declared']) }),
  counts: z.object({ added: z.number(), removed: z.number(), modified: z.number(), unchanged: z.number() }),
  files: z.array(z.object({
    path: z.string(), change: z.enum(['added', 'removed', 'modified']),
    before: z.object({ size: z.number(), sha256: z.string() }).nullable(),
    after: z.object({ size: z.number(), sha256: z.string() }).nullable(),
  })),
  total: z.number(), nextOffset: z.number().nullable(),
  note: z.string(),
});
export type RunComparisonResult = z.infer<typeof runComparisonResultSchema>;
export const artifactReadInputSchema = z.object({
  path: z.string().min(1).max(4096),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(24000).optional(),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ArtifactReadInput = z.infer<typeof artifactReadInputSchema>;

export const artifactPageResultSchema = z.object({
  projectId: z.string(), runId: z.string(), status: z.enum(['delivered', 'partial']),
  files: z.array(z.object({ path: z.string(), size: z.number(), uri: z.string().optional() })),
  total: z.number(), nextOffset: z.number().nullable(),
});
export const artifactFileResultSchema = z.object({
  projectId: z.string(), runId: z.string(), path: z.string(), size: z.number(), snapshot: z.string(),
  mimeType: z.string(), kind: z.enum(['text', 'binary']), text: z.string().nullable(), textOffset: z.number(),
  nextTextOffset: z.number().nullable(), untrusted: z.literal(true), uri: z.string().optional(),
});
/** The small UI projection is validated independently of additive run detail fields. */
export const runViewSchema = z.object({
  projectId: z.string(), projectRunId: z.string(), title: z.string().nullable().optional(), goal: z.string(),
  status: projectRunStatusSchema, costUsd: z.number().nullable().optional(), progress: runProgressSchema.optional(),
  actions: z.object({ canCancel: z.boolean() }).optional(),
  publication: z.object({ status: z.string(), repositoryUrl: z.string().nullable(), pullRequestUrl: z.string().optional() }).nullable().optional(),
});
