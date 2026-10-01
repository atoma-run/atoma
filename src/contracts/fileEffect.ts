import { z } from 'zod';

/** The semantic prefilter's file intent, distinct from the host's restoration policy. */
export const fileEffectSchema = z.enum(['read-only', 'mutating']);
export type FileEffect = z.infer<typeof fileEffectSchema>;
