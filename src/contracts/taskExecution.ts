import { z } from 'zod';
import { GROUND_TRUTH_MARKER } from './scriptEnvelope.js';

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

/**
 * A tool-using task whose result IS the text a run delivers. Tool-using
 * molecules are taught a file envelope ({files, probes}) by their stored
 * prompts, so their answer used to land in the summary beside the evidence,
 * and the person read checksums and commands as the answer (run 4e5c5c4b,
 * 2026-10-12). Reasoning tasks already answer in output. The exception is the
 * PERSON's request: in that run the planner's own phase text asked for the
 * probes, which the summary carries.
 */
export const TEXT_DELIVERY_GUIDANCE = `Delivery: text. The person receives this result as a written answer, not as files. Your output is that answer, or your section of it when sibling tasks write the other sections: one Markdown string written for that person, with what you found, your conclusions and what they mean. This replaces any instruction to put files or probes in output. Keep verification evidence (hashes, exit codes, tool commands, raw test inputs) out of output unless the person's original request asks for it; report what you observed after "${GROUND_TRUTH_MARKER}" in the summary, even when a phase description asks you to state it. Files you write while working are not delivered.`;

/** The same fact for planners and validators, who judge or plan that answer rather than write it. */
export const TEXT_DELIVERY_CONTEXT = `Delivery: text. This task's result reaches the person as a written answer, not as files; its executor is asked to write that answer in output as Markdown and its evidence in the summary. Judge the answer wherever it was placed: never refuse a correct result for its placement alone, and never propose its placement as a lasting prompt change. The delivery shape belongs to this run.`;

const REASONING_TASK_GUIDANCE = `This is a reasoning-only task. No tools are available.
Solve it directly from the supplied task, originalTask and previous phase results.
Do not search for an imaginary source file, create artifacts, or claim executed verification.`;

export const REASONING_PLAN_GUIDANCE = `${REASONING_TASK_GUIDANCE}
Plan only the current subtask. Return one JSON object with reasoning, proposedAction and expectedOutput.
Result-format feedback applies to the later execution; do not wrap this plan in output or summary.`;

export const REASONING_EXECUTION_GUIDANCE = `${REASONING_TASK_GUIDANCE}
${TEXT_VERIFICATION_GUIDANCE}
Return one JSON object with the actual answer and its reasoning in output, and a concise summary.`;
