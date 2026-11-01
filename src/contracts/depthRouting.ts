import { z } from 'zod';
import { PROOF_OBLIGATIONS } from './attestation.js';
import { checklistCoverageSchema, checklistSourceSchema } from './acceptanceChecklist.js';
import { inheritedChecksSummarySchema } from './inheritedChecksSummary.js';

/**
 * Runtime-owned experiment inputs and evidence. Never parsed from model prose.
 *
 * `direct`: one executor with the run's tools carries the whole task, and the
 * host judges it at root acceptance like any other topology. `short`: an L2
 * cell plans and deepens once. `deep`: an L3 tissue decomposes from the start.
 */
export const depthModeSchema = z.enum(['deep', 'short', 'direct']);
export type DepthMode = z.infer<typeof depthModeSchema>;

/**
 * The depth a run takes when nobody names one: `direct` since 2026-11-01
 * (owner decision, docs/decisions/direct-depth-2026-11-01.md). Fifteen
 * controlled rounds found no task family on which supervision bought
 * correctness, at six to ten times the cost; `deep` and `short` stay opt-in.
 */
export const DEFAULT_DEPTH_MODE: DepthMode = 'direct';

/**
 * What a stored run row WITHOUT a depth was launched with. Every such row
 * predates 2026-11-01, when the default was `deep`; rows written since carry
 * their depth explicitly. Readers that re-launch, continue or rerun a stored
 * run read an absent value through this constant, never through the current
 * default, which would silently change an old run's topology.
 */
export const STORED_DEPTH_WHEN_ABSENT: DepthMode = 'deep';
export const proofFloorSchema = z.array(z.object({
  obligation: z.enum(PROOF_OBLIGATIONS),
  deliverable: z.string().min(1),
}));
export type ProofFloor = z.infer<typeof proofFloorSchema>;
const actorSchema = z.object({ name: z.string(), tier: z.union([z.literal(1), z.literal(2), z.literal(3)]) });
export const phaseCoverageSchema = z.object({
  attempt: z.number().int().positive(),
  branchId: z.string().optional(),
  acceptor: actorSchema,
  executor: actorSchema,
  obligations: z.array(z.object({
    obligation: z.enum(PROOF_OBLIGATIONS), covered: z.boolean(), reason: z.string(), eventIds: z.array(z.string()),
  })),
});
export type PhaseCoverageRecord = z.infer<typeof phaseCoverageSchema>;
export const topologySchema = z.object({
  at: z.enum(['entry', 'deepening']), mode: depthModeSchema,
  reason: z.enum(['arm', 'fallback-moment']), attempt: z.number().int().positive(),
});
export type TopologyInfo = z.infer<typeof topologySchema>;
export const acceptanceSchema = z.object({
  attempt: z.number().int().positive(), approved: z.boolean(), reasoning: z.string(),
  acceptor: actorSchema.extend({ role: z.literal('root-acceptor') }),
  executor: actorSchema.extend({ viaFallback: z.boolean() }),
  gates: z.array(z.object({ id: z.string(), disposition: z.enum(['reject', 'reject-once', 'requires-review']) })),
  probe: z.object({ requiresReview: z.boolean(), contradiction: z.boolean() }),
  floorCoverage: z.array(z.object({
    kind: z.enum(PROOF_OBLIGATIONS), deliverable: z.string(),
    status: z.enum(['covered', 'uncovered']), observationRefs: z.array(z.string()),
  })),
  phaseCoverage: z.array(phaseCoverageSchema),
  /** The run's acceptance checklist, covered from this attempt (docs/decisions/acceptance-checklist-2026-09-25.md). */
  checklist: z.array(checklistCoverageSchema).optional(),
  /** Who wrote that checklist; absent on a trace recorded before approved lists existed. */
  checklistSource: checklistSourceSchema.optional(),
  /** The host's digest of a USER list, the same one the project store holds for the run. */
  checklistDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** The host's replay of the checks earlier runs recorded (docs/decisions/inherited-checks-replay-2026-10-01.md). */
  inheritedChecks: inheritedChecksSummarySchema.optional(),
  basis: z.enum(['mechanical', 'validation-call']),
});
export type AcceptanceInfo = z.infer<typeof acceptanceSchema>;
