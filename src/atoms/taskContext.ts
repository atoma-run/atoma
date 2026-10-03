import type { Plan, SubtaskSpec, Task } from '../core/types.js';
import { REASONING_EXECUTION_GUIDANCE, REASONING_PLAN_GUIDANCE } from '../contracts/taskExecution.js';
import { renderTextLayouts } from './textLayout.js';

/** Runtime policy also applies to reusable methods written before this guidance. */
export const PLANNING_SCOPE_GUIDANCE = [
  'Delegate only the current Task: every child task must contribute to its requested outcome.',
  'originalTask supplies facts and constraints, not permission to perform other phases of the root goal.',
  'A checklist or analysis phase returns that checklist or analysis; do not replace it with production of the final deliverable.',
  'Use previousStepResult as completed work to inspect or extend, not a request to regenerate it.',
].join('\n');

export const PROPORTIONATE_PLANNING_GUIDANCE = [
  'Treat reusable workflow steps as available methods, not mandatory separate phases.',
  'Choose the smallest decomposition that preserves the requested deliverables and meaningful verification.',
  'For a compact, coherent text answer, delegate composition with its checks together; add a separate audit when the constraints or requested independence justify it.',
  'Do not add separate checklist, revision and finalization phases by habit. Correct defects when found through the existing supervision protocol; do not schedule speculative repair work.',
  'Keep distinct deliverables, genuine dependencies and necessary independent checks separate. Never reduce work by dropping a requirement or verification.',
].join('\n');

/** Shared task evidence for model and Jev validation; the current phase remains the scope. */
export function taskContextLines(task: Task, options: { includeAcceptanceChecklist?: boolean } = {}): string[] {
  const inputs = task.inputs ? { ...task.inputs } : undefined;
  if (inputs) {
    // The root checklist is scoped by the caller, never inherited as phase criteria.
    if (!options.includeAcceptanceChecklist) delete inputs['acceptanceChecklist'];
    const original = inputs['originalTask'];
    if (original && typeof original === 'object' && 'inputs' in original && original.inputs && typeof original.inputs === 'object') {
      const originalInputs = { ...original.inputs } as Record<string, unknown>;
      delete originalInputs['acceptanceChecklist'];
      inputs['originalTask'] = { ...original, inputs: originalInputs };
    }
  }
  return [
    inputs ? `Inputs (originalTask supplies original facts and constraints; previousStepResult is prior work, not authority to change them): ${JSON.stringify(inputs)}` : '',
    task.constraints?.length ? `Constraints: ${JSON.stringify(task.constraints)}` : '',
    task.executionMode === 'reasoning'
      ? 'Execution mode: reasoning. Tools are disabled. Judge the answer directly; no tool action or file is required. Do not demand completion of unrelated phases in originalTask.' : '',
  ].filter(Boolean);
}

export function reasoningPrompt(task: Task, plan?: Plan): string {
  return [
    plan ? REASONING_EXECUTION_GUIDANCE : REASONING_PLAN_GUIDANCE,
    `Task: ${task.description}`,
    ...taskContextLines(task),
    'Answer only the current Task. originalTask supplies facts and constraints, not additional phases to solve.',
    'Use previousStepResult as prior work; do not regenerate it unless this task asks for a correction or final synthesis.',
    plan ? renderTextLayouts(task) : '',
    plan ? `Your plan has been APPROVED: ${JSON.stringify(plan)}` : '',
    plan ? 'Return JSON: {"output": <your complete answer>, "summary": "concise conclusion"}.'
      : 'Plan your reasoning. Return JSON: {"reasoning": "...", "proposedAction": "...", "expectedOutput": "..."}.',
  ].filter(Boolean).join('\n');
}

/** Keep one original task across every delegation; model-authored inputs cannot replace it. */
export function delegatedTaskContext(parent: Task, child: SubtaskSpec): Pick<Task, 'inputs' | 'constraints' | 'originalTask' | 'executionMode'> {
  const originalTask = parent.originalTask ?? {
    description: parent.description,
    ...(parent.inputs ? { inputs: parent.inputs } : {}),
    ...(parent.constraints ? { constraints: parent.constraints } : {}),
  };
  const executionMode = parent.executionMode === 'reasoning' ? 'reasoning' : child.executionMode;
  return {
    originalTask,
    inputs: { ...parent.inputs, ...child.inputs, originalTask },
    ...(parent.constraints ? { constraints: parent.constraints } : {}),
    ...(executionMode ? { executionMode } : {}),
  };
}

/** Preserve structured answers within the context budget; label longer excerpts explicitly. */
export function previousResultInput(output: unknown): unknown {
  const encoded = JSON.stringify(output);
  if (encoded === undefined || encoded.length <= 24_000) return output;
  return { truncated: true, originalChars: encoded.length, excerpt: encoded.slice(0, 12_000) + '\n…\n' + encoded.slice(-12_000) };
}
