import { z } from 'zod';
import { idempotencyKeySchema, principalIdSchema, projectIdSchema, projectRunIdSchema } from './projects.js';

export const PROJECT_CONTEXT_ENV = 'ATOMA_PROJECT_CONTEXT';
export const PROJECT_CONTEXT_MAX_CHARS = 24_000;
const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const confirmationSchema = z.string().trim().min(1).max(1_000);
const sourceSchema = z.object({
  kind: z.enum(['client', 'model']),
  summary: z.string().trim().min(1).max(600),
  runId: projectRunIdSchema.optional(),
}).strict();
const attributionSchema = z.object({ principalId: principalIdSchema, at: z.string().datetime() }).strict();
const decisionTextSchema = z.string().trim().min(1).max(600);
const decisionSchema = z.object({
  id: z.string().uuid(), text: decisionTextSchema, source: sourceSchema,
  proposedBy: attributionSchema,
  status: z.enum(['proposed', 'confirmed', 'replaced']),
  confirmation: attributionSchema.extend({ review: confirmationSchema }).optional(),
  replacement: attributionSchema.extend({ review: confirmationSchema, decisionId: z.string().uuid().optional() }).optional(),
}).strict();
export const projectContextUpdateSchema = z.object({
  expectedVersion: versionSchema, idempotencyKey: idempotencyKeySchema,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('set_brief'), text: z.string().trim().max(4_000), source: sourceSchema, confirmation: confirmationSchema }).strict(),
    z.object({ kind: z.literal('propose_decision'), text: decisionTextSchema, source: sourceSchema }).strict(),
    z.object({ kind: z.literal('confirm_decision'), decisionId: z.string().uuid(), confirmation: confirmationSchema }).strict(),
    z.object({ kind: z.literal('replace_decision'), decisionId: z.string().uuid(), confirmation: confirmationSchema,
      replacement: z.object({ text: decisionTextSchema, source: sourceSchema }).strict().optional() }).strict(),
  ]),
}).strict();
export type ProjectContextUpdate = z.infer<typeof projectContextUpdateSchema>;
export const projectContextSchema = z.object({
  projectId: projectIdSchema, version: versionSchema,
  brief: z.object({ text: z.string().max(4_000), source: sourceSchema,
    confirmedBy: attributionSchema.extend({ review: confirmationSchema }) }).strict().nullable(),
  // Replaced decisions live in the immutable revision that replaced them, not in active guidance.
  decisions: z.array(decisionSchema).max(48),
  change: z.object({ kind: z.enum(['set_brief', 'propose_decision', 'confirm_decision', 'replace_decision']),
    author: attributionSchema, decisionId: z.string().uuid().optional(), replaced: decisionSchema.optional() }).strict().nullable(),
}).strict();
export type ProjectContext = z.infer<typeof projectContextSchema>;
export const projectContextReadSchema = z.object({
  version: versionSchema.optional(), beforeVersion: versionSchema.optional(), limit: z.number().int().min(1).max(50).optional(),
}).strict();
export const projectContextResultSchema = z.object({
  context: projectContextSchema,
  history: z.array(projectContextSchema.pick({ version: true, change: true })).max(50),
  nextBeforeVersion: versionSchema.nullable(),
}).strict();

/** Only client-confirmed guidance crosses the model boundary. Audit prose stays host-side. */
export const projectContextGuidanceSchema = projectContextSchema.pick({ projectId: true, version: true }).extend({
  brief: z.string().max(4_000).nullable(),
  decisions: z.array(decisionSchema.pick({ id: true, text: true })).max(24),
}).strict();
export function encodeProjectContext(context: ProjectContext): string {
  const value = projectContextGuidanceSchema.parse({ projectId: context.projectId, version: context.version,
    brief: context.brief?.text ?? null,
    decisions: context.decisions.filter(item => item.status === 'confirmed').map(({ id, text }) => ({ id, text })),
  });
  const encoded = JSON.stringify(value);
  if (encoded.length > PROJECT_CONTEXT_MAX_CHARS) throw new Error('Confirmed project context exceeds its transport budget');
  return encoded;
}
export function decodeProjectContext(encoded: string | undefined): z.infer<typeof projectContextGuidanceSchema> | undefined {
  if (encoded === undefined) return undefined;
  if (encoded.length > PROJECT_CONTEXT_MAX_CHARS) throw new Error('Project context exceeds its transport budget');
  return projectContextGuidanceSchema.parse(JSON.parse(encoded) as unknown);
}
