import { z } from 'zod';
import { accountSubscriptionStatusSchema } from './accountSubscriptions.js';
import { createProjectInputSchema, projectGoalSchema, projectIdSchema, projectRunIdSchema } from './projects.js';
import { MAX_CHECKLIST_ITEMS, parseChecklistLines } from './acceptanceChecklist.js';

/** A proposal is data. Only a separate, version-bound client confirmation executes it. */
export const assistantActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_project'), project: createProjectInputSchema }).strict(),
  z.object({
    kind: z.literal('start_run'), projectId: projectIdSchema, goal: projectGoalSchema,
    acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).max(MAX_CHECKLIST_ITEMS).default([])
      .superRefine((lines, ctx) => {
        for (const line of lines) {
          const parsed = parseChecklistLines(line);
          if (parsed.errors.length || parsed.items.length !== 1) ctx.addIssue({ code: 'custom', message: 'Invalid acceptance criterion' });
        }
      }),
  }).strict(),
]);
export type AssistantAction = z.infer<typeof assistantActionSchema>;
export const assistantReplySchema = z.object({
  message: z.string().trim().min(1).max(6000),
  proposal: assistantActionSchema.nullable(),
}).strict();

export const assistantPayerSchema = z.enum(['principal-subscription', 'org-key', 'host-key']);
export type AssistantPayer = z.infer<typeof assistantPayerSchema>;
/** Opaque selection id plus public attribution; never a credential or profile path. */
export const assistantModelChoiceSchema = z.object({
  id: z.string().min(1).max(512), model: z.string().min(1).max(240), label: z.string().max(240), payer: assistantPayerSchema,
});
export type AssistantModelChoice = z.infer<typeof assistantModelChoiceSchema>;

export const assistantScopeSchema = projectIdSchema.nullable();
export const assistantRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), requestId: z.string().uuid(), version: z.number().int().nonnegative(),
    projectId: assistantScopeSchema, conversationId: z.string().uuid().optional(), modelChoice: z.string().min(1).max(512).optional(), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('confirm'), requestId: z.string().uuid(), version: z.number().int().nonnegative(),
    projectId: assistantScopeSchema, conversationId: z.string().uuid().optional(), proposalId: z.string().uuid() }).strict(),
]);
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export const assistantRunSchema = z.object({ projectId: projectIdSchema, runId: projectRunIdSchema });
export type AssistantRun = z.infer<typeof assistantRunSchema>;
export const assistantMessageSchema = z.object({
  id: z.string().uuid().optional(),
  origin: z.enum(['atoma', 'mcp', 'legacy']).optional(), clientLabel: z.string().max(80).optional(),
  role: z.enum(['user', 'assistant', 'receipt']), text: z.string().max(6000),
  at: z.string().datetime(), projectId: projectIdSchema.optional(), run: assistantRunSchema.optional(),
});
export const assistantConversationSchema = z.object({
  id: z.string().uuid().nullable().default(null), projectId: projectIdSchema.nullable().default(null),
  version: z.number().int().nonnegative(),
  messages: z.array(assistantMessageSchema).max(40),
  proposal: z.object({ id: z.string().uuid(), action: assistantActionSchema, projectName: z.string().max(120).optional(),
    state: z.enum(['pending', 'executing', 'done', 'uncertain']) }).nullable(),
  lastRun: assistantRunSchema.nullable(),
  costUsd: z.number().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  lastRequestId: z.string().nullable(), modelChoice: z.string().max(512).optional(),
});
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;
export const assistantViewSchema = z.object({
  conversation: assistantConversationSchema, available: z.boolean(), model: z.string().nullable(), busy: z.boolean(),
  choices: z.array(assistantModelChoiceSchema).max(1500).default([]),
  subscriptions: z.array(accountSubscriptionStatusSchema).max(2).optional(),
  nextBefore: z.number().int().positive().nullable().default(null),
  run: z.object({ status: z.string(), traceId: z.string().nullable(), costUsd: z.number().nullable(), error: z.string().nullable() }).nullable(),
});
export type AssistantView = z.infer<typeof assistantViewSchema>;

/** Caller identity and origin are host-owned; a client label is only reported attribution. */
export const conversationReadSchema = z.object({
  projectId: projectIdSchema.nullable().default(null), conversationId: z.string().uuid().optional(),
  before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(20).default(10),
}).strict();
export const conversationWriteSchema = z.object({
  projectId: projectIdSchema.nullable().default(null), conversationId: z.string().uuid().optional(),
  requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(),
  clientLabel: z.string().trim().min(1).max(80).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(6000) }).strict()).max(8).default([]),
  proposal: assistantActionSchema.nullable().optional(),
}).strict();
export type ConversationWrite = z.infer<typeof conversationWriteSchema>;
export const conversationApprovalSchema = z.object({
  conversationId: z.string().uuid(), proposalId: z.string().uuid(), requestId: z.string().uuid(),
  version: z.number().int().nonnegative(), confirmation: z.string().trim().min(1).max(1000),
}).strict();
export type ConversationApproval = z.infer<typeof conversationApprovalSchema>;
export const conversationReceiptSchema = z.object({ createdProjectId: projectIdSchema.optional(), run: assistantRunSchema.optional() }).strict();
export type ConversationReceipt = z.infer<typeof conversationReceiptSchema>;
export const conversationReadResultSchema = z.object({
  conversation: assistantConversationSchema, busy: z.boolean(), nextBefore: z.number().int().positive().nullable(),
  untrusted: z.literal(true),
});
