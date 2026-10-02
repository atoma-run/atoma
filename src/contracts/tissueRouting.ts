import { z } from 'zod';

/** Host-read evidence about the starting workspace, never repository instructions. */
export const routingRepositorySchema = z.object({
  files: z.array(z.string()),
  excerpts: z.array(z.object({ path: z.string(), text: z.string(), truncated: z.boolean() })),
  incomplete: z.boolean(),
});
export type RoutingRepository = z.infer<typeof routingRepositorySchema>;

/** A router selects an identity or requests creation; it never authors the persistent method. */
export const tissueRoutingDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('reuse'),
    name: z.string().min(1).max(64),
    reasoning: z.string().min(1).max(1200),
  }).strict(),
  z.object({
    action: z.literal('create'),
    reasoning: z.string().min(1).max(1200),
  }).strict(),
]);

/** Only the author pinned by the platform's ATOMA_MODEL_L3 supplies persistent tissue text. */
export const tissueDefinitionSchema = z.object({
  description: z.string().trim().min(1).max(200),
  workflow: z.string().trim().min(1).max(6000),
}).strict();

/** Trusted parent-to-run credential channel. Never include it in traces or tool environments. */
export const PLATFORM_TISSUE_AUTHOR_ENV = 'ATOMA_PLATFORM_TISSUE_AUTHOR';
export const platformTissueAuthorSchema = z.object({
  model: z.string(),
  env: z.record(z.string(), z.string()),
}).strict();
