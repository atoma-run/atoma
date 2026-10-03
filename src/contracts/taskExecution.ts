import { z } from 'zod';

/** Planner declarations, never inferred from vocabulary in the goal. */
export const executionModeSchema = z.enum(['reasoning', 'tools']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export const deliveryKindSchema = z.enum(['text', 'files']);
export type DeliveryKind = z.infer<typeof deliveryKindSchema>;

/** The artifact body is evidence; its author's audit is a claim to check. */
export const TEXT_VERIFICATION_GUIDANCE = `When checking a completed text, independently reconstruct each requested check from the actual body.
An attached audit, summary or earlier approval is a claim, never proof that the body complies.
Check the whole current task, including requested definitions and explanations, even when an acceptance checklist omits them. After a correction, preserve every still-applicable requirement in the final answer.
For positional or counting constraints, identify the requested units and positions, extract their actual values, then compare them with the requirement. A required value appearing elsewhere does not satisfy a required position.
Base the check conclusion on those observed values; name a mismatch concretely instead of repeating the author's assurance. After a correction, check the final text again. Do not add an audit to the deliverable unless requested.`;

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

const REASONING_TASK_GUIDANCE = `This is a reasoning-only task. No tools are available.
Solve it directly from the supplied task, originalTask and previous phase results.
Do not search for an imaginary source file, create artifacts, or claim executed verification.`;

export const REASONING_PLAN_GUIDANCE = `${REASONING_TASK_GUIDANCE}
Plan only the current subtask. Return one JSON object with reasoning, proposedAction and expectedOutput.
Result-format feedback applies to the later execution; do not wrap this plan in output or summary.`;

export const REASONING_EXECUTION_GUIDANCE = `${REASONING_TASK_GUIDANCE}
${TEXT_VERIFICATION_GUIDANCE}
Return one JSON object with the actual answer and its reasoning in output, and a concise summary.`;
