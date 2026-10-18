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
