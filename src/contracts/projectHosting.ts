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
  /**
   * When it first answered visitors (2026-10-26). Absent while it never did,
   * and on rows written before: the conversation then says only what the
   * state proves.
   */
  readyAt: z.string().optional(),
  /**
   * The run that was serving visitors when this deployment was requested, or
   * null when none was (2026-10-26). Unlike `previousRunId` it names only a
   * serving version, whatever the operation. Absent on older rows.
   */
  replacedRunId: z.string().uuid().nullable().optional(),
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
/**
 * One deployment of the project, as its conversation narrates it (2026-10-26):
 * which accepted version was asked online, when, whether it was to replace a
 * version serving visitors, and what its row proves became of it. Host facts
 * from the deployment rows, never a journal message.
 */
export const hostingHistoryEntrySchema = z.object({
  deploymentId: z.string().uuid(), runId: z.string().uuid(),
  /** The run's one-line title; null until the run is named. */
  title: z.string().nullable(),
  /** The run's trace, so "See the details" opens it; null when it has none. */
  traceId: z.string().nullable(),
  createdAt: z.string(),
  /** Another version was serving visitors when this one was asked for. */
  replaced: z.boolean(),
  /**
   * `starting`; `online`, the version visitors reach now; `ended`, it served
   * and no longer does; `unavailable`, it served and stopped answering;
   * `not-started`, it never served (failed, or stopped after failing);
   * `stopped`, a row written before these facts, stopped with no proof
   * either way.
   */
  outcome: z.enum(['starting', 'online', 'ended', 'unavailable', 'not-started', 'stopped']),
  /** A `not-started` replacement left an older version serving: it is still online. */
  keptOnline: z.boolean(),
}).strict();
export type HostingHistoryEntry = z.infer<typeof hostingHistoryEntrySchema>;
/** How many deployments the summary carries for the conversation, newest first: as many as the runs it tells. */
export const HOSTING_HISTORY_MAX = 20;
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
   * The last served version after Stop, or the version a failed update stopped,
   * offered back while nothing is online. Only when its bytes are retained
   * and it is still accepted and published.
   */
  previous: hostingVersionSchema.extend({ manifestHash: z.string() }).nullable(),
  /** Replacing what runs now stops it first (a stateful Node application): the site is down meanwhile. */
  updateStops: z.boolean(),
  /**
   * The version the newest deployment tried to put online, when that attempt
   * failed to START (a later runtime loss of a version that ran is not one);
   * null otherwise. Which version failed is named, never inferred: a
   * static application keeps serving beside a failed attempt, and the
   * accepted version may have moved on since.
   */
  failed: z.object({ runId: z.string().uuid() }).strict().nullable(),
  /** Additive (2026-10-26): the newest deployments, newest first, at most `HOSTING_HISTORY_MAX`. Absent from an older server. */
  history: z.array(hostingHistoryEntrySchema).max(HOSTING_HISTORY_MAX).optional(),
}).strict();
export type HostingSummary = z.infer<typeof hostingSummarySchema>;

/** Explicit capability in an accepted delivery; engine options remain host-owned. */
export const hostingManifestSchema = z.object({ version: z.literal(1), runtime: z.literal('node-browser'), entry: hostingLaunchSchema.shape.entry }).strict();
