import type { Locale } from './locales.js';
import { computePreparationSchema, computeImageProgressSchema } from './computeSetup.js';
import { z } from 'zod';
import { computeLocalAllocationSchema, computeResourceBudgetSchema } from './computeLocal.js';
export const computeDesktopCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('resources'), budget: computeResourceBudgetSchema }).strict(),
  z.object({ action: z.literal('pair'), name: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.enum(['install-docker', 'install-wsl', 'prepare', 'diagnose', 'connect', 'disconnect', 'disconnect-idle', 'accept', 'drain', 'pause', 'stop', 'refresh', 'cancel']) }).strict(),
]);
export type ComputeDesktopCommand = z.infer<typeof computeDesktopCommandSchema>;
export const computeDesktopStateSchema = z.object({
  resourceBudget: computeResourceBudgetSchema.nullable().default(null),
  activeResourceBudget: computeResourceBudgetSchema.nullable().default(null),
  preparationPending: z.boolean().default(false),
  preparation: computePreparationSchema.nullable().default(null),
  paired: z.boolean(), connected: z.boolean(), accepting: z.boolean(),
  phase: z.enum(['idle', 'pairing', 'downloading', 'diagnosing', 'connecting', 'connected', 'stopping', 'error']),
  issue: z.enum(['download', 'docker', 'resources', 'busy', 'connection', 'credential', 'pairing', 'stop-unconfirmed', 'unsupported', 'setup']).nullable(),
  deviceName: z.string().max(120),
  imageProgress: computeImageProgressSchema.nullable().default(null),
  download: z.object({ completed: z.number().int().min(0).max(4), total: z.number().int().min(1).max(4) }).nullable(),
  diagnostic: z.object({ cpus: z.number(), memoryBytes: z.number(), diskBytes: z.number(), hostDiskBytes: z.number(), version: z.string().max(80) }).nullable(),
  allocations: z.array(computeLocalAllocationSchema).max(20),
  transfers: z.array(z.object({ id: z.string().max(200), direction: z.enum(['upload', 'download']), kind: z.enum(['workspace', 'checkpoint', 'delivery']), bytes: z.number().nonnegative(), files: z.number().nonnegative(), state: z.enum(['transferring', 'transferred', 'interrupted']) })).max(8),
  resources: z.array(z.object({ workload: z.string().max(128), cpuPercent: z.number(), memory: z.string().max(80), processes: z.number() })).max(20),
}).strict();
export type ComputeDesktopState = z.infer<typeof computeDesktopStateSchema>;
export const computeDesktopLinkSchema = z.enum(['atoma', 'docker', 'updates']);
export type ComputeDesktopLink = z.infer<typeof computeDesktopLinkSchema>;
export const computeDesktopUpdateActionSchema = z.enum(['check', 'install', 'cancel']);
export type ComputeDesktopUpdateAction = z.infer<typeof computeDesktopUpdateActionSchema>;
export const computeDesktopUpdateStateSchema = z.object({
  phase: z.enum(['unsupported', 'idle', 'checking', 'current', 'available', 'downloading', 'waiting', 'installing', 'error']),
  version: z.string().min(1).max(80).nullable(),
  percent: z.number().min(0).max(100).nullable(),
}).strict();
export type ComputeDesktopUpdateState = z.infer<typeof computeDesktopUpdateStateSchema>;
export interface ComputeDesktopApi {
  state(): Promise<ComputeDesktopState>;
  language(locale: Locale): Promise<void>;
  command(command: ComputeDesktopCommand): Promise<void>;
  open(link: ComputeDesktopLink): Promise<void>;
  subscribe(listener: (state: ComputeDesktopState) => void): () => void;
  updateState(): Promise<ComputeDesktopUpdateState>;
  update(action: ComputeDesktopUpdateAction): Promise<void>;
  subscribeUpdates(listener: (state: ComputeDesktopUpdateState) => void): () => void;
}
