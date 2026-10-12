import type { VizEvent, VizRun } from './types.js';
import { buildLlmEnvelopeDetail, type StructuredDetailNode } from './structured-detail.js';
import { skillContextDetail } from './skill-context-detail.js';

type Translator = (key: string, vars?: Record<string, unknown>) => string;

/** Explain the call's output before the supporting input; retain the recorded bytes on demand. */
export function llmDetailNodes(
  event: VizEvent, run: VizRun, response: readonly StructuredDetailNode[],
  rawContext: boolean, t: Translator
): readonly StructuredDetailNode[] {
  const nodes: StructuredDetailNode[] = [];
  if (event.role === 'plan') {
    const branch = event.branchId ? run.events.find(candidate =>
      candidate.kind === 'branch' && candidate.op === 'start' && candidate.branchId === event.branchId) : undefined;
    const task = branch?.label ?? (!event.branchId ? run.task?.description : undefined);
    if (typeof task === 'string' && task.trim()) nodes.push({
      kind: 'field', key: 'mission', label: t('detail.planning.mission'),
      value: task, presentation: 'text', tone: 'info',
    });
  }
  nodes.push({
    kind: 'section', key: 'response',
    label: t(event.error ? 'detail.field.error' : event.role === 'plan' ? 'detail.planning.proposal' : 'detail.llm.response'),
    children: response.length ? response : [{
      kind: 'field', key: 'missingResponse', label: t('detail.field.status'),
      value: t('detail.llm.missingResponse'), presentation: 'text', tone: 'neutral',
    }],
  });
  if (rawContext) return [...nodes, ...buildLlmEnvelopeDetail(event, t)];
  const context = (event.context ?? []).map((block): StructuredDetailNode => {
    const detail = block.source === 'skill' ? skillContextDetail(block, t) : null;
    return {
      kind: 'section', key: 'contextBlock',
      label: [t(`detail.enum.contextSource.${block.source}`), block.skillId].filter(Boolean).join(' · '),
      children: detail ? [
        ...(detail.truncated ? [{
          kind: 'field' as const, key: 'truncated', label: t('detail.field.status'),
          value: t('detail.skillContext.truncated'), tone: 'warning' as const, presentation: 'text' as const,
        }] : []),
        ...(detail.nodes.length ? detail.nodes : [{
          kind: 'field' as const, key: 'missingRecipe', label: t('detail.skillContext.recipe'),
          value: t('detail.skillContext.missingRecipe'), tone: 'neutral' as const, presentation: 'text' as const,
        }]),
      ] : [{ kind: 'field', key: 'preview', label: t('detail.field.content'),
        value: block.preview, tone: 'neutral', presentation: 'text' }],
    };
  });
  if (context.length) nodes.push({ kind: 'section', key: 'resources', label: t('detail.llm.resources'), children: context });
  return [...nodes, ...buildLlmEnvelopeDetail({ toolNames: event.toolNames }, t)];
}
