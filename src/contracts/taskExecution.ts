import { z } from 'zod';

/** Planner declarations, never inferred from vocabulary in the goal. */
export const executionModeSchema = z.enum(['reasoning', 'tools']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export const deliveryKindSchema = z.enum(['text', 'files']);
export type DeliveryKind = z.infer<typeof deliveryKindSchema>;

export const TASK_EXECUTION_GUIDANCE = `DELIVERY AND EXECUTION:
Set the plan's "delivery" to "text" when the requested deliverable is the final response,
or "files" when it is a workspace artifact. Text delivery may still require research tools.
For each self-contained reasoning subtask, set "executionMode": "reasoning".
Such a subtask and ALL its descendants have no tools or executable skills, including fallbacks.
Do not declare file outputs or tool proof obligations on a reasoning subtask.
Use "tools" (the default) for work requiring reads, writes, external research or execution.
The originalTask input preserves the user's exact data and global constraints; perform only
the current subtask, using that context without replacing literal values or inventing sources.
previousStepResult is the preceding phase's answer, not just its progress summary.`;

export const REASONING_EXECUTION_GUIDANCE = `This is a reasoning-only task. No tools are available.
Solve it directly from the supplied task, originalTask and previous phase results.
Return the actual answer and its reasoning in output, with a concise summary.
Do not search for an imaginary source file, create artifacts, or claim executed verification.`;
