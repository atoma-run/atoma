import { z } from 'zod';
import { accountSubscriptionStatusSchema } from './accountSubscriptions.js';
import { createProjectInputSchema, projectGoalSchema, projectIdSchema, projectRunIdSchema, runRequestedViaSchema } from './projects.js';
import { MAX_CHECKLIST_ITEMS, parseChecklistLines } from './acceptanceChecklist.js';
import { readRunIdsSchema, storedReadRunIdsSchema } from './readRuns.js';

const createProjectAction = z.object({ kind: z.literal('create_project'), project: createProjectInputSchema }).strict();
const startRunFields = {
  kind: z.literal('start_run'), projectId: projectIdSchema, goal: projectGoalSchema,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).max(MAX_CHECKLIST_ITEMS).default([])
    .superRefine((lines, ctx) => {
      for (const line of lines) {
        const parsed = parseChecklistLines(line);
        if (parsed.errors.length || parsed.items.length !== 1) ctx.addIssue({ code: 'custom', message: 'Invalid acceptance criterion' });
      }
    }),
};

/**
 * A proposal is data. Only a separate, version-bound client confirmation
 * executes it. This is what a writer may propose: the assistant's reply and
 * `atoma_conversation_update`. A start may name read runs
 * (docs/decisions/read-runs-2026-10-17.md), only when the person asks; the
 * writers check them against the project before saving.
 */
export const assistantProposalSchema = z.discriminatedUnion('kind', [createProjectAction, z.object({ ...startRunFields,
  readRunIds: readRunIdsSchema.optional().describe('Only when the person asks to reuse files of earlier runs: runIds from readiness.selectableRuns.'),
}).strict()]);
/**
 * What a saved proposal, an approval receipt and a restated action may hold:
 * a proposal, its read runs read back by spelling (`storedReadRunIdsSchema`),
 * so a later cap cannot make a saved conversation unreadable. Readers
 * accepted them a deployment before any writer emitted them: conversation
 * bodies and approval receipts are read back through these strict schemas,
 * so a writer deployed first and then reverted would have left every
 * conversation holding its proposal unreadable.
 */
export const assistantActionSchema = z.discriminatedUnion('kind', [createProjectAction, z.object({ ...startRunFields,
  readRunIds: storedReadRunIdsSchema.optional().describe('Restate unchanged as atoma_run_start.readRunIds with conversationApproval.'),
}).strict()]);
export type AssistantAction = z.infer<typeof assistantActionSchema>;

/**
 * THE canonical form of an action: a start's read runs sorted, the key absent
 * when there are none. A proposal takes it where it is saved, and both sides
 * of an approval's comparison take it. Never a schema transform: the SDK
 * renders `atoma_conversation`'s outputSchema in output mode, where
 * `z.toJSONSchema` throws on one. Zod keeps an explicit `readRunIds:
 * undefined`, which `isDeepStrictEqual` tells from an absent key, so without
 * it a start without read runs restated that way would never approve.
 */
export function canonicalAction(action: AssistantAction): AssistantAction {
  if (action.kind !== 'start_run') return action;
  const { readRunIds, ...start } = action;
  return readRunIds?.length ? { ...start, readRunIds: [...readRunIds].sort() } : start;
}

export const assistantReplySchema = z.object({
  message: z.string().trim().min(1).max(6000),
  proposal: assistantProposalSchema.nullable(),
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
    projectId: assistantScopeSchema, conversationId: z.string().uuid().optional(), proposalId: z.string().uuid(),
    /** The read runs the confirmation card displayed, echoed back; absent when it displayed none. */
    readRunIds: readRunIdsSchema.optional() }).strict(),
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
/**
 * One of the project's recent runs as its conversation narrates it
 * (2026-10-26): host facts from the compact run page, never a message in the
 * journal. `mine` is the viewer's own run; `requestedVia` is absent on a run
 * started before doors were recorded, and its `client` is that client's claim.
 */
export const assistantActivitySchema = z.object({
  runId: projectRunIdSchema, projectId: projectIdSchema, title: z.string().nullable(), goalExcerpt: z.string(),
  status: z.string(), createdAt: z.string().datetime(), endedAt: z.string().datetime().nullable(), costUsd: z.number().nullable(),
  requestedByName: z.string().nullable(), mine: z.boolean(), requestedVia: runRequestedViaSchema.optional(),
  continuation: z.boolean(), comparison: z.boolean(), acceptedAt: z.string().datetime().nullable(),
  publicationStatus: z.string().nullable(),
  /** Where "See the details" opens it; absent until its trace exists. */
  traceId: z.string().nullable().optional(),
});
const assistantViewRunSchema = assistantRunSchema.extend({ status: z.string(), traceId: z.string().nullable(), costUsd: z.number().nullable(), error: z.string().nullable(),
  endedAt: z.string().datetime().nullable(),
  /** Additive (2026-10-25): the run's work ended and its files wait on the requester's computer (host facts). */
  resultsWaiting: z.boolean().optional(),
  /** Additive: those results wait although the computer is connected and accepting work. */
  resultsStalled: z.boolean().optional() });
export const assistantViewSchema = z.object({
  conversation: assistantConversationSchema, available: z.boolean(), model: z.string().nullable(), busy: z.boolean(),
  choices: z.array(assistantModelChoiceSchema).max(1500).default([]),
  subscriptions: z.array(accountSubscriptionStatusSchema).max(2).optional(),
  nextBefore: z.number().int().positive().nullable().default(null),
  /** The run the conversation presents: the project's newest, else the one this conversation started. */
  run: assistantViewRunSchema.nullable(),
  /** Additive (2026-10-26): the delivery awaiting the client's acceptance (`awaitingClientAcceptance`), live run or not. */
  awaiting: assistantViewRunSchema.nullable().optional(),
  /** Additive (2026-10-26): the project's newest runs, newest first; empty before a project. */
  activity: z.array(assistantActivitySchema).max(20).optional(),
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
  proposal: assistantProposalSchema.nullable().optional(),
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
