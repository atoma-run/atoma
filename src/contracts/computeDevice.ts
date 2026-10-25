import { z } from 'zod';

export const COMPUTE_PROTOCOL_VERSION = 1;
/** How long a device keeps its session and workloads without a heartbeat
 * acknowledgement, on both ends: the client stops its workloads when it
 * expires, the server invalidates the session. 30 s until 2026-10-23; a
 * reverse-proxy restart (5 s) plus a Wi-Fi migration (20-30 s) sat at its
 * edge, and the transport resumes the same session within it, so the cost of
 * a longer lease is only how long a vanished device delays a run's failure. */
export const COMPUTE_LEASE_MS = 120_000;
export const COMPUTE_PAIRING_MS = 10 * 60_000;
export const computeActorSchema = z.object({ orgId: z.string().uuid(), principalId: z.string().uuid() }).strict();
export type ComputeActor = z.infer<typeof computeActorSchema>;
export const computeResourcesSchema = z.object({
  cpus: z.number().finite().positive().max(1024),
  memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  diskBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ComputeResources = z.infer<typeof computeResourcesSchema>;
export const computeCapabilitiesSchema = computeResourcesSchema.extend({
  protocol: z.literal(COMPUTE_PROTOCOL_VERSION),
  appVersion: z.string().min(1).max(80),
  platform: z.enum(['darwin', 'win32']), architecture: z.enum(['arm64', 'x64']),
  /** `preview-classification` is a hello-only signal: the connection keeps it
   * in memory and never stores it, so an older executor generation reading the
   * stored row never meets a value its strict schema rejects. */
  services: z.array(z.enum(['workspace', 'tools', 'retrieval', 'preview', 'preview-classification'])).max(5).optional(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type ComputeCapabilities = z.infer<typeof computeCapabilitiesSchema>;
export const computeSessionSchema = z.object({
  deviceId: z.string().uuid(), sessionId: z.string().uuid(), generation: z.number().int().positive(),
}).strict();
export type ComputeSession = z.infer<typeof computeSessionSchema>;
export const computeAssignmentSchema = z.object({
  runId: z.string().uuid(), projectId: z.string().uuid(), generation: z.number().int().positive(),
  state: z.enum(['active', 'indeterminate']),
}).strict();
export type ComputeAssignment = z.infer<typeof computeAssignmentSchema>;

/** Read-only execution progress; never a lease-release authorization. */
export const computeRunProgressSchema = z.enum(['executing', 'finalizing', 'transferred', 'stop-confirmation-pending', 'stopped']);
export type ComputeRunProgress = z.infer<typeof computeRunProgressSchema>;

/**
 * A Compute run whose runner ended (its result is persisted and the transfer
 * journal says `finalizing`) while no host process is moving the files: the
 * work is finished and its results wait on the customer's computer. Host
 * facts only, never model text. `since` is when the files started waiting:
 * the first time no driver held the run after its runner ended, else the
 * journal's own timestamp. `computerReady` (additive): that computer is
 * connected and accepting work, so "open Atoma Compute" is not the remedy.
 */
export const computeResultsWaitingSchema = z.object({ since: z.string(), computerReady: z.boolean().optional() }).strict();
export type ComputeResultsWaiting = z.infer<typeof computeResultsWaitingSchema>;
/**
 * The plain sentences every reader (web, MCP, task line) shows for it. They
 * are viewer-neutral: other members read them too. The results arrive by
 * themselves: the selected executor finishes the transfer once the computer
 * is connected (src/projects/AGENTS.md).
 */
export const COMPUTE_RESULTS_WAITING_MESSAGE = 'The work is finished. Its results are on the computer that ran it and will arrive by themselves as soon as Atoma Compute is open, connected and accepting work there.';
export const COMPUTE_RESULTS_STALLED_MESSAGE = 'The work is finished, but its results could not be transferred from the computer that ran it yet. The person who started the run can choose "Get the results"; contact support if this continues.';
export function computeResultsWaitingMessage(waiting: Pick<ComputeResultsWaiting, 'computerReady'>): string {
  return waiting.computerReady ? COMPUTE_RESULTS_STALLED_MESSAGE : COMPUTE_RESULTS_WAITING_MESSAGE;
}

export const computeAdmissionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), session: computeSessionSchema }).strict(),
  z.object({ status: z.literal('waiting'), reason: z.enum([
    'disconnected', 'busy', 'resources-insufficient', 'version-incompatible', 'not-accepting', 'access-unavailable',
  ]) }).strict(),
]);
export type ComputeAdmission = z.infer<typeof computeAdmissionSchema>;
