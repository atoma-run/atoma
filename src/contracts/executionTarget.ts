import { z } from 'zod';

/** Project preference and immutable run receipt share one shape. */
export const executionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hosted') }).strict(),
  z.object({ kind: z.literal('customer-device'), deviceId: z.string().uuid() }).strict(),
]);
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export const executionTargetSettingSchema = z.object({
  target: executionTargetSchema, expected: executionTargetSchema,
}).strict();

export const executionProvenanceSchema = z.enum(['hosted', 'customer-device']);
export type ExecutionProvenance = z.infer<typeof executionProvenanceSchema>;
/** Customer observations require independent hosted validation before credit. */
export function canCreditSharedKnowledge(provenance: ExecutionProvenance | undefined): boolean {
  return provenance !== 'customer-device';
}

/** Non-mutating ledger receipt for an observation excluded from the commons. */
export const withheldKnowledgeSchema = z.object({
  operation: z.enum(['success', 'failure', 'revision', 'direct-failure']),
  provenance: z.literal('customer-device'),
  reason: z.literal('Customer execution requires independent hosted validation'),
  by: z.string(),
  via: z.string().optional(),
  automaticValidation: z.literal(true).optional(),
});
export type WithheldKnowledge = z.infer<typeof withheldKnowledgeSchema>;

export function withheldComputeKnowledge(
  operation: WithheldKnowledge['operation'], by: string, via?: string
): WithheldKnowledge {
  return { operation, by, ...(via ? { via } : {}), provenance: 'customer-device', automaticValidation: true,
    reason: 'Customer execution requires independent hosted validation' };
}
