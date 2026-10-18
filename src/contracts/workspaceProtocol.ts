import { z } from 'zod';
import { readOnlyExecutionRecordSchema, readOnlyRestorationSchema } from './readOnlyPhase.js';
import { startingSnapshotSchema, deliveredSnapshotSchema } from './startingWorkspace.js';
import { readRunCopyCheckSchema, readRunFileComparisonsSchema } from './readRuns.js';
import { routingRepositorySchema } from './tissueRouting.js';
import { artifactManifestSchema } from './artifactInventory.js';
import { inheritedWorkspaceStateSchema, workspaceSourceSchema, artifactExportOptionsSchema } from './workspaceRuntime.js';
import { checkpointTransferHeaderSchema, checkpointWireFrameSchema } from './checkpointTransfer.js';

export const WORKSPACE_PROTOCOL_VERSION = 1;
export const WORKSPACE_FRAME_BYTES = 32 * 1024 * 1024;
/** No caller-selected root, arbitrary command, or tool invocation on this channel. */
export const workspaceCommandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('import-open'), header: checkpointTransferHeaderSchema, archive: z.boolean(), source: workspaceSourceSchema.optional() }).strict(),
  z.object({ method: z.literal('import-frame'), handle: z.string().uuid(), frame: checkpointWireFrameSchema }).strict(),
  z.object({ method: z.literal('import-abort'), handle: z.string().uuid() }).strict(),
  z.object({ method: z.literal('validate-sources') }).strict(),
  z.object({ method: z.literal('prepare'), clean: z.boolean() }).strict(),
  z.object({ method: z.literal('restart') }).strict(),
  z.object({ method: z.literal('starting-snapshot') }).strict(),
  z.object({ method: z.literal('ensure-read-runs') }).strict(),
  z.object({ method: z.literal('canonical-path') }).strict(),
  z.object({ method: z.literal('checkpoint-digest') }).strict(),
  z.object({ method: z.literal('artifact-open'), options: artifactExportOptionsSchema }).strict(),
  z.object({ method: z.literal('checkpoint-open') }).strict(),
  z.object({ method: z.literal('checkpoint-next'), handle: z.string().uuid() }).strict(),
  z.object({ method: z.literal('checkpoint-close'), handle: z.string().uuid() }).strict(),
  z.object({ method: z.literal('inherited-state') }).strict(),
  z.object({ method: z.literal('replace-manifest'), text: z.string(), expected: z.string().optional() }).strict(),
  z.object({ method: z.literal('routing') }).strict(),
  z.object({ method: z.literal('delivered'), start: startingSnapshotSchema }).strict(),
  z.object({ method: z.literal('capture-read-runs') }).strict(),
  z.object({ method: z.literal('check-read-runs') }).strict(),
  z.object({ method: z.literal('compare-read-runs'), criteria: z.array(z.string()).readonly() }).strict(),
  z.object({ method: z.literal('begin-read-only'), phase: z.string().max(16000), attempt: z.number().int().positive() }).strict(),
  z.object({ method: z.literal('end-read-only'), handle: z.string().uuid(), record: readOnlyExecutionRecordSchema }).strict(),
]);
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export const workspaceRequestSchema = z.object({
  version: z.literal(WORKSPACE_PROTOCOL_VERSION), id: z.number().int().positive(), command: workspaceCommandSchema,
}).strict();
export const workspaceReplySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('import-open'), value: z.string().uuid() }).strict(),
  z.object({ method: z.literal('import-frame'), value: z.null() }).strict(),
  z.object({ method: z.literal('import-abort'), value: z.null() }).strict(),
  z.object({ method: z.literal('validate-sources'), value: z.null() }).strict(),
  z.object({ method: z.literal('prepare'), value: z.null() }).strict(),
  z.object({ method: z.literal('restart'), value: z.null() }).strict(),
  z.object({ method: z.literal('starting-snapshot'), value: startingSnapshotSchema.nullable() }).strict(),
  z.object({ method: z.literal('ensure-read-runs'), value: z.string().nullable() }).strict(),
  z.object({ method: z.literal('canonical-path'), value: z.string() }).strict(),
  z.object({ method: z.literal('checkpoint-digest'), value: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ method: z.literal('artifact-open'), value: z.object({ handle: z.string().uuid(), header: checkpointTransferHeaderSchema, manifest: artifactManifestSchema }).strict() }).strict(),
  z.object({ method: z.literal('checkpoint-open'), value: z.object({ handle: z.string().uuid(), header: checkpointTransferHeaderSchema }).strict() }).strict(),
  z.object({ method: z.literal('checkpoint-next'), value: checkpointWireFrameSchema }).strict(),
  z.object({ method: z.literal('checkpoint-close'), value: z.null() }).strict(),
  z.object({ method: z.literal('inherited-state'), value: inheritedWorkspaceStateSchema.nullable() }).strict(),
  z.object({ method: z.literal('replace-manifest'), value: z.boolean() }).strict(),
  z.object({ method: z.literal('routing'), value: routingRepositorySchema }).strict(),
  z.object({ method: z.literal('delivered'), value: deliveredSnapshotSchema }).strict(),
  z.object({ method: z.literal('capture-read-runs'), value: z.null() }).strict(),
  z.object({ method: z.literal('check-read-runs'), value: z.array(readRunCopyCheckSchema).readonly() }).strict(),
  z.object({ method: z.literal('compare-read-runs'), value: readRunFileComparisonsSchema }).strict(),
  z.object({ method: z.literal('begin-read-only'), value: z.string().uuid() }).strict(),
  z.object({ method: z.literal('end-read-only'), value: readOnlyRestorationSchema }).strict(),
]);
export type WorkspaceReply = z.infer<typeof workspaceReplySchema>;
export const workspaceResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), reply: workspaceReplySchema }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.enum(['invalid-request', 'operation-failed']),
    message: z.string().max(8192).optional() }).strict(),
]);
