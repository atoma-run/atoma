import { Rectangle } from 'pixi.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { resultSections, resultText, resultFileUrl } from '../../run-result.js';
import { runStatus } from '../../../client/run-utils.js';
import { formatDateTime } from '../../../client/date-format.js';

/** One bounded result reader shared by Projects and Runs. No model HTML executes. */
export function drawResultPanel(ctx: RendererCtx, snapshot: GpuRenderSnapshot,
  x: number, y: number, width: number, height: number): void {
  const run = snapshot.data.resultRun?.id === snapshot.state.resultRunId ? snapshot.data.resultRun : null;
  const projectRun = Object.values(snapshot.data.projectRuns).flat()
    .find(row => row.traceId === snapshot.state.resultRunId || row.projectRunId === snapshot.state.resultRunId);
  ctx.panel(ctx.root, x, y, width, height, GPU_COLORS.panel, GPU_COLORS.border);
  ctx.text(ctx.root, snapshot.t('result.title'), x + 16, y + 12, { size: 16, weight: '700' });
  ctx.button(ctx.root, 'result.close', 'button', snapshot.t('result.back'), x + width - 130, y + 8, 114, 30, false, snapshot.onActivate);
  const top = y + 48;
  const pane = createScrollPane(ctx.root, { x: x + 12, y: top, width: width - 24,
    height: Math.max(0, height - 60), scrollY: ctx.detailScrollY });
  ctx.detailBounds = new Rectangle(x + 12, top, width - 24, Math.max(0, height - 60));
  let cursor = 4;
  const text = (value: string, heading = false) => {
    const label = ctx.text(pane.content, value, 4, cursor, { size: heading ? 13 : 12,
      weight: heading ? '700' : '400', color: GPU_COLORS.text, width: width - 44 });
    cursor += label.height + 14;
  };
  if (!run) {
    text(snapshot.t(snapshot.data.resultFailed ? 'result.unavailable' : 'result.loading'));
  } else {
    const goal = run.task?.description ?? run.label;
    const goalLabel = ctx.text(pane.content, goal, 4, cursor, { size: 13, weight: '700',
      color: GPU_COLORS.text, width: width - 44, singleLine: true });
    ctx.tooltip(pane.content, { x: 4, y: cursor, width: width - 44, height: goalLabel.height, text: goal });
    cursor += goalLabel.height + 14;
    text(`${snapshot.t(`runs.flag.${runStatus(run)}`)} · ${formatDateTime(run.startedAt, snapshot.state.locale)} · ${run.id.slice(0, 8)}`);
    if (runStatus(run) !== 'delivered') text(snapshot.t('result.notFinal'));
    const output = resultText(run);
    if (output !== null) {
      const actions = [['result.copy', 'result.copy'], ['result.download', 'result.download']] as const;
      for (const [id, key] of actions) {
        ctx.button(pane.content, id, 'button', snapshot.t(key), 4, cursor, Math.min(240, width - 44), 30, false, snapshot.onActivate);
        cursor += 36;
      }
      if (snapshot.state.resultActionStatus) text(snapshot.t(`result.${snapshot.state.resultActionStatus}`));
      let remaining = 24000;
      let shortened = false;
      const sections = resultSections(run);
      for (const section of sections.slice(0, 80)) {
        if (remaining <= 0) { shortened = true; break; }
        if (section.title) text(section.title, true);
        // Bound GPU geometry, retaining the full value in copy/download.
        text(section.text.slice(0, remaining));
        shortened ||= section.text.length > remaining;
        remaining -= section.text.length;
      }
      if (shortened || sections.length > 80) text(snapshot.t('result.truncated'));
    } else text(snapshot.t('result.noOutput'));
    if (run.result?.summary) {
      text(snapshot.t('result.summary'), true);
      text(run.result.summary.slice(0, 12000));
      if (run.result.summary.length > 12000) text(snapshot.t('result.truncated'));
    }
  }
  const files = projectRun?.artifactManifest?.files ?? [];
  if (files.length > 0 && projectRun) {
    text(snapshot.t('result.files', { count: files.length }), true);
    if (projectRun.bytesExpiredAt) text(snapshot.t('result.expired'));
    for (const file of files) {
      const label = `${file.path} · ${file.size.toLocaleString(snapshot.state.locale)} B`;
      if (resultFileUrl(projectRun, file.path)) {
        ctx.button(pane.content, `result.file.${encodeURIComponent(file.path)}`, 'button', label, 4, cursor,
          width - 44, 32, false, snapshot.onActivate);
        cursor += 38;
      } else text(label);
    }
    text(snapshot.t(files.some(file => resultFileUrl(projectRun, file.path)) ? 'result.filesPublished' : 'result.filesUnavailable'));
  }
  pane.extend(cursor);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
}
