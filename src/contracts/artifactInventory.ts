import { z } from 'zod';
import { deliveryKindSchema } from './taskExecution.js';

/**
 * A RUN'S SAVED FILES: the artifact manifest and its entries, the shape a
 * delivered or partial run's inventory is stored, compared, published and read
 * in. Defined here, below `projects.ts`, which re-exports every name, so a
 * contract `projects.ts` itself imports can use the manifest without an import
 * cycle (`readRuns.ts`, whose launch index carries other runs' manifests).
 */

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const artifactPathSchema = z.string().min(1).max(512);
export const artifactFileSchema = z
  .object({
    path: artifactPathSchema,
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
    mode: z.enum(['100644', '100755']),
  })
  .strict();

export const artifactManifestSchema = z
  .object({
    version: z.literal(1),
    // Absent on legacy plan-only manifests. Never infer complete coverage.
    source: z.literal('workspace').optional(),
    delivery: deliveryKindSchema.optional(),
    files: z.array(artifactFileSchema),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.files.length === 0 && manifest.source !== 'workspace') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'only a workspace inventory may be empty' });
    }
    const paths = new Set<string>();
    let total = 0;
    let previous = '';
    for (const [index, file] of manifest.files.entries()) {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'artifact paths must be unique',
        });
      }
      if (index > 0 && file.path.localeCompare(previous) < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'artifact files must be sorted by canonical path',
        });
      }
      paths.add(file.path);
      previous = file.path;
      total += file.size;
    }
    if (total !== manifest.totalBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalBytes'],
        message: `totalBytes must equal the file-size sum (${total})`,
      });
    }
  });

export type ArtifactFile = z.infer<typeof artifactFileSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
