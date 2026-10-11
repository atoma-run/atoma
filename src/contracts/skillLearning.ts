import { z } from 'zod';
import { CONTEXT_SOURCES } from './llmTrace.js';

export const generationParamsSchema = z.object({
  temperature: z.number().optional(), maxTokens: z.number().optional(),
  topP: z.number().optional(),
  /** Reasoning-depth hint; transport capability gates it, and planning pins medium. */
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

const lessonCommon = {
  owner: z.string().min(1),
  host: z.object({
    name: z.string(), model: z.string(), params: generationParamsSchema,
    // Captured through the atom's builder, including the original context fold.
    systemPrompt: z.string(),
    context: z.array(z.object({ id: z.string(), source: z.enum(CONTEXT_SOURCES),
      text: z.string(), skillId: z.string().optional() })).optional(),
  }),
  branchId: z.string().optional(),
  task: z.string(), summary: z.string(),
};

/** Host-authored evidence of an approved phase; no closures, tools or credentials. */
export const skillLessonSchema = z.discriminatedUnion('kind', [
  z.object({ ...lessonCommon, kind: z.literal('task'), childName: z.string(),
    childTools: z.array(z.string()), hostTools: z.array(z.string()).optional(),
    visibleNamespaces: z.array(z.string()).optional(), verificationOnly: z.boolean().optional(),
    successfulToolAction: z.boolean(), recordedCommandProbes: z.boolean(),
  }),
  z.object({ ...lessonCommon, kind: z.literal('event'), diagnostic: z.string() }),
]);
export type SkillLesson = z.infer<typeof skillLessonSchema>;
export const learningSourceSchema = z.object({ runId: z.string(), lessonIndex: z.number().int().nonnegative() });
export type LearningSource = z.infer<typeof learningSourceSchema>;

export const learningJobSchema = z.object({
  version: z.literal(1), runId: z.string(), approvedAt: z.string(),
  skillsPath: z.string(), runsPath: z.string(),
  scope: z.object({ orgId: z.string(), projectId: z.string(), principalId: z.string() }).optional(),
  model: z.string(),
  policy: z.object({ promote: z.string().optional(), threshold: z.string().optional() }),
  budget: z.object({ tokens: z.number().nullable(), costUsd: z.number().nullable() }),
  lessons: z.array(skillLessonSchema).min(1),
});
export type LearningJob = z.infer<typeof learningJobSchema>;

export const learningReceiptSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked']),
  lessons: z.number(), completedLessons: z.number(),
  llmCalls: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number(),
  error: z.string().nullable(), updatedAt: z.string(),
  retries: z.array(z.object({ at: z.string(), actorType: z.literal('cli') })),
});
export type LearningReceipt = z.infer<typeof learningReceiptSchema>;
