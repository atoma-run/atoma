import { z } from 'zod';
import { startProjectRunInputSchema, type GitHubAccessRequired } from './projects.js';
import { previewClassificationSchema, previewEgressHostsSchema } from './preview.js';

const identity = z.string().min(1).max(200);
export const executorPreviewStartSchema = z.object({ orgId: identity, projectId: identity, runId: identity,
  generation: z.number().int().positive(), source: z.enum(['delivered', 'in-flight']),
  classification: previewClassificationSchema.optional(), mode: z.enum(['app', 'terminal']),
  copyMaxBytes: z.number().int().positive(), allowedHosts: previewEgressHostsSchema,
  attribution: z.boolean(), hardMs: z.number().int().positive().max(86_400_000) }).strict();
export type ExecutorPreviewStart = z.infer<typeof executorPreviewStartSchema>;
/** Host-private commands. Public membership and task binding stay at the existing service doors. */
export const executorRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('health') }).strict(),
  z.object({ method: z.literal('yield-background') }).strict(),
  z.object({ method: z.literal('retire-previews') }).strict(),
  z.object({ method: z.literal('start'), input: z.object({ orgId: identity, principalId: identity,
    projectId: identity, request: startProjectRunInputSchema }).strict() }).strict(),
  z.object({ method: z.literal('publish'), orgId: identity, runId: identity }).strict(),
  z.object({ method: z.literal('compute-finalize'), orgId: identity, runId: identity, principalId: identity }).strict(),
  z.object({ method: z.literal('preview-start'), input: executorPreviewStartSchema }).strict(),
  z.object({ method: z.literal('preview-stop'), orgId: identity, runId: identity, generation: z.number().int().positive() }).strict(),
  z.object({ method: z.literal('operator-start'), input: z.object({ goal: z.string().min(1).max(4000),
    timeoutMs: z.number().int().positive().optional(), learnSkills: z.boolean().optional(), promoteSkills: z.boolean().optional(),
    directSkills: z.boolean().optional(), container: z.boolean().optional(), egress: z.boolean().optional(),
    keepWorkspace: z.boolean().optional() }).strict() }).strict(),
]);
export type ExecutorRequest = z.input<typeof executorRequestSchema>;
export interface ExecutorFailure { name: string; message: string; access?: GitHubAccessRequired }
