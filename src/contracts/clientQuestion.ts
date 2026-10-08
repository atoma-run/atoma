import { z } from 'zod';
import { idempotencyKeySchema, projectRunStatusSchema } from './projects.js';

/** A blocking client choice, never a request for routine implementation advice or credentials. */
export const clientQuestionSchema = z.object({
  question: z.string().trim().min(1).max(600),
  whyClient: z.string().trim().min(1).max(600),
  missingDecision: z.string().trim().min(1).max(600),
  options: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    label: z.string().trim().min(1).max(160), consequence: z.string().trim().min(1).max(400) }).strict()).min(2).max(4),
}).strict().refine(value => new Set(value.options.map(option => option.id)).size === value.options.length, 'Option ids must be unique');
export type ClientQuestion = z.infer<typeof clientQuestionSchema>;
export const clientAnswerSchema = z.object({
  optionId: z.string().max(40).optional(), text: z.string().trim().min(1).max(2000).optional(),
}).strict().refine(value => Boolean(value.optionId || value.text), 'Supply an option or a free-text answer');
export const answerClientQuestionSchema = z.object({
  questionId: z.string().uuid(), idempotencyKey: idempotencyKeySchema, answer: clientAnswerSchema,
}).strict();
export type AnswerClientQuestion = z.infer<typeof answerClientQuestionSchema>;
export const clientQuestionRecordSchema = z.object({
  questionId: z.string().uuid(), runId: z.string().uuid(), projectId: z.string().uuid(),
  phase: z.number().int().nonnegative(), question: clientQuestionSchema, createdAt: z.string().datetime(),
  answer: z.object({ principalId: z.string().uuid(), at: z.string().datetime(), value: clientAnswerSchema }).strict().nullable(),
}).strict();
export type ClientQuestionRecord = z.infer<typeof clientQuestionRecordSchema>;
/** Shared read projection for the MCP card and the authenticated HTTP reader. */
export const clientQuestionViewSchema = z.object({
  projectId: z.string(), runId: z.string(), question: clientQuestionRecordSchema.nullable(),
  waitingForClient: z.boolean(), canAnswer: z.boolean(), canResume: z.boolean(),
  nextAction: z.enum(['answer', 'resume', 'none']),
  continuation: z.object({ runId: z.string(), status: projectRunStatusSchema }).nullable().optional(),
});
export type ClientQuestionView = z.infer<typeof clientQuestionViewSchema>;
/** Bounded immutable answers carried with the checkpoint, separate from the project brief. */
export const clientAnswerContextSchema = z.array(z.object({
  questionId: z.string().uuid(), question: z.string().max(600),
  selectedOption: z.object({ label: z.string().max(160), consequence: z.string().max(400) }).nullable(),
  text: z.string().max(2000).nullable(), principalId: z.string().uuid(), at: z.string().datetime(),
}).strict()).max(32).refine(value => JSON.stringify(value).length <= 24_000, 'Client answer history exceeds its context budget');
