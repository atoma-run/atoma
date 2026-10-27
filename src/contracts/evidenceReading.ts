import { z } from 'zod';

/** Host-captured bytes, independent of the bounded observation presented to a model. */
export const archivedToolEvidenceSchema = z.object({
  encoding: z.literal('gzip+base64'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  data: z.string(),
}).strict();
export type ArchivedToolEvidence = z.infer<typeof archivedToolEvidenceSchema>;

/** A review can request recorded bytes only; this is never an element invocation. */
const readRequests = z.object({
  readEvidence: z.array(z.object({
    eventId: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().positive().optional(),
    find: z.string().min(1).optional(),
  }).strict()).min(1).max(8),
  notes: z.string().optional(),
}).strict();
export const evidenceReadRequestSchema = z.union([readRequests, z.object({
  listEvidence: z.object({ offset: z.number().int().nonnegative() }).strict(),
  notes: z.string().optional(),
}).strict()]);
export type EvidenceReadRequest = z.infer<typeof evidenceReadRequestSchema>;
