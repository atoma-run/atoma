import { z } from 'zod';

/** Private gateway binding; hosting uses the project id as its route, whereas
 * an ephemeral preview uses its run id and generation. */
export const previewClaimBindingSchema = z.object({
  principalId: z.string().min(1),
  /** Null when the authenticated transport exposes no session id. */
  sessionId: z.string().nullable(),
  orgId: z.string().min(1),
  projectRunId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  host: z.string().min(1),
}).readonly();
export type PreviewClaimBinding = z.infer<typeof previewClaimBindingSchema>;

export const previewGrantSchema = z.object({
  binding: previewClaimBindingSchema,
  expiresAt: z.number().int().nonnegative(),
}).strict().readonly();
export type PreviewGrant = z.infer<typeof previewGrantSchema>;
