import { Graphics, type Container } from 'pixi.js';
import type { VizProjectRun, VizRun } from '../../client/types.js';
import { BUTTON_LABEL_INSET, type GpuRenderSnapshot, type RendererCtx } from '../gpu-renderer.js';
import { BUTTON_ICON_SPACE } from '../button-icons.js';
import { GPU_COLORS } from '../theme.js';
import { canGetComputeResults, computeResultsMessageKey, computeResultsWaiting, COMPUTE_RESULTS_ACTION } from '../compute-results.js';

/** Plain copy wrapped over measured 12px lines, every word drawn. */
export function wrapCopyLines(ctx: RendererCtx, copy: string, width: number): string[] {
  const lines: string[] = [];
  let rest = copy.replace(/\s+/g, ' ').trim();
  while (rest) {
    if (ctx.measureText(rest, { size: 12 }) <= width) { lines.push(rest); break; }
    const fitted = ctx.fitText(rest, width, { size: 12 }).replace(/…$/, '');
    const boundary = fitted.lastIndexOf(' ');
    const length = Math.max(1, boundary > 0 ? boundary : fitted.length);
    lines.push(rest.slice(0, length));
    rest = rest.slice(length).trimStart();
  }
  return lines;
}

export interface ComputeResultsBlock {
  readonly lines: string[];
  readonly noticeLines: string[];
  /** From the separator to the last notice line, padding excluded. */
  readonly height: number;
}

/**
 * Finished work whose files wait on a computer: the plain sentence, "Get the
 * results", and why it failed or who may press it. Null for any other run.
 * ONE layout for the project's run card and the run's own page.
 */
export function computeResultsBlock(ctx: RendererCtx, snapshot: GpuRenderSnapshot, run: VizProjectRun, width: number): ComputeResultsBlock | null {
  if (!computeResultsWaiting(run)) return null;
  const progress = snapshot.data.githubRecovery?.runId === run.projectRunId ? snapshot.data.githubRecovery : null;
  const lines = wrapCopyLines(ctx, snapshot.t(computeResultsMessageKey(run, snapshot.data.auth)), width);
  const notice = progress?.message ?? (!canGetComputeResults(run, snapshot.data.auth) ? snapshot.t('projects.resultsWaiting.requesterOnly') : null);
  const noticeLines = notice ? wrapCopyLines(ctx, notice, width) : [];
  return { lines, noticeLines, height: 16 + lines.length * 20 + 12 + 40 + (noticeLines.length ? 12 + noticeLines.length * 20 : 0) };
}

export function drawComputeResultsBlock(ctx: RendererCtx, parent: Container, snapshot: GpuRenderSnapshot, run: VizProjectRun,
  block: ComputeResultsBlock, x: number, y: number, width: number): void {
  parent.addChild(new Graphics().moveTo(x, y).lineTo(x + width, y).stroke({ color: GPU_COLORS.border, width: 1 }));
  const progress = snapshot.data.githubRecovery?.runId === run.projectRunId ? snapshot.data.githubRecovery : null;
  block.lines.forEach((line, index) => ctx.text(parent, line, x, y + 16 + index * 20,
    { size: 12, color: GPU_COLORS.text, width, singleLine: true }));
  const actionY = y + 16 + block.lines.length * 20 + 12;
  const label = snapshot.t(progress?.busy ? 'projects.resultsWaiting.getting' : 'projects.resultsWaiting.get');
  const actionWidth = Math.min(width, Math.ceil(ctx.measureText(label, { size: 11, weight: '600' })) + BUTTON_LABEL_INSET * 2 + BUTTON_ICON_SPACE);
  ctx.button(parent, `${COMPUTE_RESULTS_ACTION}${run.projectRunId}`, 'button', label,
    x, actionY, actionWidth, 40, false, snapshot.onActivate, GPU_COLORS.primary, false, !!progress?.busy,
    undefined, undefined, undefined, !canGetComputeResults(run, snapshot.data.auth) || !!progress?.busy);
  block.noticeLines.forEach((line, index) => ctx.text(parent, line, x, actionY + 52 + index * 20,
    { size: 12, color: GPU_COLORS.warning, width, singleLine: true }));
}

/**
 * The project run behind this trace when it is finished work whose files wait
 * on a computer (the server's host fact on the project's run list). The trace
 * ended and may read delivered; this outranks it wherever the run's verdict shows.
 */
export function runAwaitingResults(snapshot: GpuRenderSnapshot, run: Pick<VizRun, 'id'>): VizProjectRun | null {
  const entry = snapshot.data.runs.find(candidate => candidate.id === run.id);
  const projectRunId = entry?.projectRunId ?? entry?.id;
  const projectRun = entry?.projectId && projectRunId
    ? snapshot.data.projectRuns[entry.projectId]?.find(candidate => candidate.projectRunId === projectRunId) : undefined;
  return projectRun && computeResultsWaiting(projectRun) ? projectRun : null;
}
