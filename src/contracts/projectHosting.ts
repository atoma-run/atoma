import { z } from 'zod';

export const hostingIdentitySchema = z.object({ orgId: z.string().uuid(), projectId: z.string().uuid(), deploymentId: z.string().uuid() }).strict();
export const hostingLaunchSchema = hostingIdentitySchema.extend({ entry: z.string().min(1).max(512).refine(p => !p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s !== '..' && s !== '.' && s !== '') && /\.(mjs|cjs|js)$/.test(p)), kind: z.enum(['node', 'static']) }).strict();
export const hostingHandleSchema = z.object({ hostPort: z.number().int().min(1).max(65535), image: z.string() }).strict();
export type HostingIdentity = z.infer<typeof hostingIdentitySchema>;
export type HostingLaunch = z.infer<typeof hostingLaunchSchema>;
export type HostingHandle = z.infer<typeof hostingHandleSchema>;
export interface HostingLauncher {
  prepareHosting(identity: HostingIdentity): Promise<string>;
  startHosting(spec: HostingLaunch): Promise<HostingHandle>;
  inspectHosting(identity: HostingIdentity): Promise<HostingHandle | null>;
  stopHosting(identity: HostingIdentity): Promise<void>;
}
export const hostingDeployInputSchema = z.object({
  runId: z.string().uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDeploymentId: z.string().uuid().nullable(),
}).strict();
export const hostedDeploymentSchema = hostingIdentitySchema.extend({
  runId: z.string().uuid(), manifestHash: z.string(), commitSha: z.string(),
  state: z.enum(['starting', 'ready', 'failed', 'stopped']),
  kind: z.enum(['node', 'static']), entry: z.string(),
  createdAt: z.string(), error: z.enum(['startup-failed', 'runtime-unavailable', 'interrupted', 'cleanup-failed']).nullable(),
  hostPort: z.number().int().nullable(), image: z.string().nullable(),
}).strict();
export type HostedDeployment = z.infer<typeof hostedDeploymentSchema>;
export const hostingSummarySchema = z.object({
  available: z.boolean(), state: z.enum(['not-deployed', 'starting', 'ready', 'failed', 'stopped']),
  deploymentId: z.string().uuid().nullable(), runId: z.string().uuid().nullable(),
  commitSha: z.string().nullable(), url: z.string().nullable(), error: z.string().nullable(),
  candidate: z.object({ runId: z.string().uuid(), manifestHash: z.string(), commitSha: z.string() }).nullable(),
}).strict();
export type HostingSummary = z.infer<typeof hostingSummarySchema>;
