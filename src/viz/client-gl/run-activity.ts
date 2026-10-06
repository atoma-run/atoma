import type { VizEvent, VizRun } from '../client/types.js';
import { inFlightLlmEvents, isRunLive } from '../client/run-utils.js';

export type ActivityStage = 'plan' | 'validate-plan' | 'execute' | 'validate-result';
export const ACTIVITY_STAGES: readonly ActivityStage[] = ['plan', 'validate-plan', 'execute', 'validate-result'];
export const ACTIVITY_CHANGE_PAGE_SIZE = 4;

export interface ActivityPhase {
  id: string;
  label: string;
  eventId: string;
  ended: boolean;
  stages: ActivityStage[];
  files: Set<string>;
  errors: number;
}

export interface ActivityChange {
  event: VizEvent;
  status: 'confirmed' | 'failed' | 'unknown';
  /** These receipts mean the submitted text is not the final filesystem text. */
  transformed: boolean;
  replacements?: number;
}

export interface ActivityFile {
  path: string;
  changes: ActivityChange[];
  confirmed: number;
  failed: number;
}

export interface ActivityStep {
  id: 'plan' | 'execute' | 'validate-result';
  recorded: boolean;
  active: boolean;
  detail: 'active' | 'unseen' | 'recorded' | 'workSteps' | 'files' | 'reviews';
  count?: number;
}

export function activityFileSummary(file: ActivityFile, t: (key: string, vars?: Record<string, unknown>) => string): string {
  return [
    t('activity.confirmedCount', { count: file.confirmed }),
    file.failed ? t('activity.failedCount', { count: file.failed }) : '',
    file.changes.length > file.confirmed + file.failed ? t('activity.unknown') : '',
  ].filter(Boolean).join(' · ');
}

export function activityStage(event: VizEvent): ActivityStage | null {
  if (event.kind === 'tool') {
    return ['validate_html', 'record_probe'].includes(event.name ?? '') ? 'validate-result' : 'execute';
  }
  if (!['llm', 'llm-start', 'trust'].includes(event.kind)) return null;
  if (event.role === 'plan' || event.role === 'fallback-plan' || event.role === 'draft-checklist') return 'plan';
  if (event.role === 'execute' || event.role === 'fallback-execute') return 'execute';
  if (event.role === 'validate-plan' || event.subject === 'PLAN') return 'validate-plan';
  if (event.role === 'validate-result' || event.subject === 'RESULT') return 'validate-result';
  return null;
}

function receipt(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string' && value.length <= 16_384) {
    try { return receipt(JSON.parse(value)); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** View-only projection of host-recorded lifecycle and tool receipts. Never parse model prose for files. */
export function buildRunActivity(run: VizRun) {
  const branches = new Map<string, VizEvent>();
  const ended = new Set<string>();
  for (const event of run.events) {
    if (event.kind !== 'branch' || !event.branchId) continue;
    if (event.op === 'start') branches.set(event.branchId, event);
    if (event.op === 'end') ended.add(event.branchId);
  }
  const roots = new Map<string, string>();
  for (const id of branches.keys()) {
    let root = id;
    const seen = new Set([id]);
    while (true) {
      const parent = branches.get(root)?.['parentBranchId'];
      if (typeof parent !== 'string' || !branches.has(parent) || seen.has(parent)) break;
      root = parent;
      seen.add(root);
    }
    roots.set(id, root);
  }
  const phases = new Map<string, ActivityPhase>();
  const files = new Map<string, ActivityFile>();
  for (const event of run.events) {
    const branchId = event.branchId ? roots.get(event.branchId) : undefined;
    const id = branchId ?? 'run';
    const branch = branchId ? branches.get(branchId) : undefined;
    const stage = activityStage(event);
    let phase = phases.get(id);
    if (!phase && (stage || branch)) {
      phase = { id, label: typeof branch?.['label'] === 'string' ? branch['label'] : '',
        eventId: branch?.id ?? event.id, ended: branchId ? ended.has(branchId) : !!run.endedAt,
        stages: [], files: new Set(), errors: 0 };
      phases.set(id, phase);
    }
    if (phase && stage && !phase.stages.includes(stage)) phase.stages.push(stage);
    if (phase && event.error) phase.errors++;
    if (event.kind !== 'tool' || !['write_file', 'edit_file'].includes(event.name ?? '')) continue;
    const path = event.args?.['path'];
    if (typeof path !== 'string' || !path.trim()) continue;
    const result = receipt(event.result);
    const status = event.error || result?.['ok'] === false ? 'failed'
      : result?.['ok'] === true ? 'confirmed' : 'unknown';
    const change: ActivityChange = { event, status,
      transformed: !!result?.['merged'] || result?.['recoveredFromDoubleEscape'] === true,
      ...(typeof result?.['replacements'] === 'number' ? { replacements: result['replacements'] } : {}) };
    const file = files.get(path) ?? { path, changes: [], confirmed: 0, failed: 0 };
    file.changes.push(change);
    if (status === 'confirmed') { file.confirmed++; phase?.files.add(path); }
    if (status === 'failed') file.failed++;
    files.set(path, file);
  }
  const live = isRunLive(run);
  const activeStages = live
    ? [...new Set(inFlightLlmEvents(run).flatMap(event => { const stage = activityStage(event); return stage ? [stage] : []; }))]
    : [];
  const observed = new Set([...phases.values()].flatMap(phase => phase.stages));
  const touched = [...files.values()].filter(file => file.confirmed > 0).length;
  const workSteps = new Set(roots.values()).size;
  const reviews = run.events.filter(event => event.kind === 'llm' && event.role === 'validate-result' && !event.error).length;
  const steps: ActivityStep[] = (['plan', 'execute', 'validate-result'] as const).map(id => {
    const matches = (stage: ActivityStage) => stage === id || (id === 'plan' && stage === 'validate-plan');
    const recorded = [...observed].some(matches);
    const active = activeStages.some(matches);
    const count = id === 'plan' ? workSteps : id === 'execute' ? touched : reviews;
    const detail = active ? 'active' : !recorded ? 'unseen' : count === 0 ? 'recorded'
      : id === 'plan' ? 'workSteps' : id === 'execute' ? 'files' : 'reviews';
    return { id, recorded, active, detail, count };
  });
  return { phases: [...phases.values()], files: [...files.values()].reverse(), live, activeStages, steps,
    edits: [...files.values()].reduce((count, file) => count + file.confirmed, 0),
    touched };
}
