import { z } from 'zod';

export const hostingIdentitySchema = z.object({ orgId: z.string().uuid(), projectId: z.string().uuid(), deploymentId: z.string().uuid() }).strict();
export const hostingLaunchSchema = hostingIdentitySchema.extend({ entry: z.string().min(1).max(512).refine(p => !p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s !== '..' && s !== '.' && s !== '') && /\.(mjs|cjs|js)$/.test(p)), kind: z.enum(['node', 'static']), browser: z.boolean().optional() }).strict();
export const hostingHandleSchema = z.object({ hostPort: z.number().int().min(1).max(65535), image: z.string() }).strict();
export type HostingIdentity = z.infer<typeof hostingIdentitySchema>;
export type HostingLaunch = z.infer<typeof hostingLaunchSchema>;
export type HostingHandle = z.infer<typeof hostingHandleSchema>;
export interface HostingLauncher {
  prepareHosting(identity: HostingIdentity): Promise<string>;
  /**
   * Creates every engine object of a deployment (networks, containers, pinned
   * addresses) without starting any, so a later `startHosting` of the same
   * spec only starts them. Nothing of another deployment is touched: an update
   * prepares its new version this way while the online one keeps serving.
   */
  createHosting(spec: HostingLaunch): Promise<void>;
  startHosting(spec: HostingLaunch): Promise<HostingHandle>;
  inspectHosting(identity: HostingIdentity): Promise<HostingHandle | null>;
  /**
   * Every deployment with engine objects (containers or networks), as its
   * creation labelled them, started or not. Recovery compares it with the
   * store and removes, through `stopHosting`, what no running row names.
   */
  listHosting(): Promise<HostingIdentity[]>;
  stopHosting(identity: HostingIdentity): Promise<void>;
}
export const hostingDeployInputSchema = z.object({
  runId: z.string().uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDeploymentId: z.string().uuid().nullable(),
}).strict();
export const hostedDeploymentSchema = hostingIdentitySchema.extend({
  runId: z.string().uuid(), manifestHash: z.string(), commitSha: z.string(),
  state: z.enum(['starting', 'ready', 'failed', 'stopped']),
  kind: z.enum(['node', 'static']), entry: z.string(), browser: z.boolean().optional(),
  createdAt: z.string(), error: z.enum(['startup-failed', 'runtime-unavailable', 'interrupted', 'cleanup-failed']).nullable(),
  hostPort: z.number().int().nullable(), image: z.string().nullable(),
  /**
   * The accepted run that was online when an update stopped it to start this
   * one: what "put the previous version back" redeploys. Absent on first
   * deployments, plain deploys and rows written before 2026-10-25.
   */
  previousRunId: z.string().uuid().optional(),
}).strict();
export type HostedDeployment = z.infer<typeof hostedDeploymentSchema>;
/** An accepted version described in words: the run's title and the client's acceptance date. */
export const hostingVersionSchema = z.object({
  runId: z.string().uuid(), commitSha: z.string(),
  /** The run's one-line title; null until the run is named, and on runs named before titles existed. */
  title: z.string().nullable(),
  /** When the client accepted it; null for a publication receipt older than client acceptance. */
  acceptedAt: z.string().nullable(),
}).strict();
export type HostingVersion = z.infer<typeof hostingVersionSchema>;
export const hostingSummarySchema = z.object({
  available: z.boolean(), state: z.enum(['not-deployed', 'starting', 'ready', 'failed', 'stopped']),
  deploymentId: z.string().uuid().nullable(), runId: z.string().uuid().nullable(),
  commitSha: z.string().nullable(), url: z.string().nullable(), error: z.string().nullable(),
  /** The project's stable address, assigned before its first deployment; null until then. */
  address: z.string().nullable(),
  candidate: hostingVersionSchema.extend({ manifestHash: z.string() }).nullable(),
  /** The version `runId`/`commitSha` name, in words; null when nothing was ever deployed. */
  version: hostingVersionSchema.nullable(),
  /**
   * The version an update stopped, offered back while the update's new version
   * failed to start and nothing is online. Only when its bytes are retained
   * and it is still accepted and published.
   */
  previous: hostingVersionSchema.extend({ manifestHash: z.string() }).nullable(),
  /** Replacing what runs now stops it first (a stateful Node application): the site is down meanwhile. */
  updateStops: z.boolean(),
  /**
   * The version the newest deployment tried to put online, when that attempt
   * failed; null otherwise. Which version failed is named, never inferred: a
   * static application keeps serving beside a failed attempt, and the
   * accepted version may have moved on since.
   */
  failed: z.object({ runId: z.string().uuid() }).strict().nullable(),
}).strict();
export type HostingSummary = z.infer<typeof hostingSummarySchema>;

/** Explicit capability in an accepted delivery; engine options remain host-owned. */
export const hostingManifestSchema = z.object({ version: z.literal(1), runtime: z.literal('node-browser'), entry: hostingLaunchSchema.shape.entry }).strict();
