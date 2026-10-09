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
/** The answer history's two bounds: entries, and encoded characters. */
export const CLIENT_ANSWERS_MAX = 32;
export const CLIENT_ANSWERS_MAX_CHARS = 24_000;
/** Bounded immutable answers carried with the checkpoint, separate from the project brief. */
export const clientAnswerContextSchema = z.array(z.object({
  questionId: z.string().uuid(), question: z.string().max(600),
  selectedOption: z.object({ label: z.string().max(160), consequence: z.string().max(400) }).nullable(),
  text: z.string().max(2000).nullable(), principalId: z.string().uuid(), at: z.string().datetime(),
}).strict()).max(CLIENT_ANSWERS_MAX)
  .refine(value => JSON.stringify(value).length <= CLIENT_ANSWERS_MAX_CHARS, 'Client answer history exceeds its context budget');

/**
 * Whether the history can still take an answer to `question`, checked BEFORE
 * it is asked: room for one more entry by count, and by characters for the
 * largest answer the schema admits (its longest option and a 2000-character
 * text). Checking the count alone let a question be asked into a history a
 * few long answers had filled, which then refused every answer, a plain
 * option included; the run could only be cancelled (code review 2026-10-09
 * 2.4). A text whose JSON escaping inflates it can still be refused at
 * answer time, with the message that says to shorten it.
 */
export function clientAnswerHistoryHasRoom(history: unknown, question: ClientQuestion): boolean {
  const prior = Array.isArray(history) ? history : [];
  if (prior.length >= CLIENT_ANSWERS_MAX) return false;
  const longest = question.options.reduce((widest, option) =>
    option.label.length + option.consequence.length > widest.label.length + widest.consequence.length ? option : widest);
  const placeholderId = '00000000-0000-4000-8000-000000000000';
  const worst = {
    questionId: placeholderId, question: question.question,
    selectedOption: { label: longest.label, consequence: longest.consequence },
    text: 'x'.repeat(2000), principalId: placeholderId, at: '2000-01-01T00:00:00.000Z',
  };
  return JSON.stringify([...prior, worst]).length <= CLIENT_ANSWERS_MAX_CHARS;
}
