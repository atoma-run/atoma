import { runDuration } from '../../../client/run-utils.js';
import { Graphics } from 'pixi.js';
import { PLATFORM_STATS_DAYS } from '../../../../contracts/platformStats.js';
import { formatDateTime } from '../../../client/date-format.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { platformDaily, platformMetrics, platformNumber, PLATFORM_RUN_STATES } from '../../platform-stats.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD, VIEW_FRAME_PANE_AIR } from '../view-frame.js';

export function drawPlatform(ctx: RendererCtx, snapshot: GpuRenderSnapshot, width: number, height: number): void {
  const frame = viewFrame(width, height);
  const { t } = snapshot;
  drawViewFrame(ctx, frame, t('platform.title'), width >= 700 ? t('platform.subtitle') : '');
  const stats = snapshot.data.platformStats;
  if (!stats) return;
  const pane = createScrollPane(ctx.root, { x: frame.x, y: frame.contentTop, width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - frame.contentTop),
    scrollY: snapshot.state.scrollY.platform, bottomPadding: 24, air: VIEW_FRAME_PANE_AIR });
  const x = VIEW_FRAME_PAD;
  const w = frame.innerWidth;
  const locale = snapshot.state.locale;
  const number = (n: number | null, currency = false) => platformNumber(n, locale, currency);
  let y = 8;
  const line = (text: string, size = 11, color: number = GPU_COLORS.muted) => {
    const label = ctx.text(pane.content, text, x + 14, y, { size, color, width: Math.max(1, w - 28) });
    y += label.height + 10;
  };
  const buttonWidth = Math.min(108, (w - 16) / 3);
  for (const [index, days] of PLATFORM_STATS_DAYS.entries()) {
    ctx.button(pane.content, `platform.period.${days}`, 'button', t(w < 430 ? 'platform.daysCompact' : 'platform.days', { count: days }),
      x + index * (buttonWidth + 8), y, buttonWidth, 30, snapshot.state.platformDays === days, snapshot.onActivate);
    ctx.tooltip(pane.content, { x: x + index * (buttonWidth + 8), y, width: buttonWidth, height: 30, text: t('platform.days', { count: days }) });
  }
  y += 44;
  line(t('platform.updated', { at: formatDateTime(stats.generatedAt, locale) }));

  const columns = w >= 900 ? 4 : w >= 430 ? 2 : 1;
  const gap = 12;
  const cardWidth = (w - gap * (columns - 1)) / columns;
  const metrics = platformMetrics(stats);
  for (const [index, metric] of metrics.entries()) {
    const cardY = y + Math.floor(index / columns) * 108;
    const cardX = x + index % columns * (cardWidth + gap);
    if (!pane.visible(cardY, cardY + 96)) continue;
    ctx.panel(pane.content, cardX, cardY, cardWidth, 96, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
    ctx.text(pane.content, t(`platform.metric.${metric.key}`), cardX + 14, cardY + 12,
      { size: 11, color: GPU_COLORS.muted, width: cardWidth - 28, singleLine: true });
    ctx.text(pane.content, number(metric.value, metric.currency), cardX + 14, cardY + 32,
      { size: 25, color: GPU_COLORS.primary, width: cardWidth - 28, singleLine: true });
    const hint = metric.hint && metric.amount !== null ? t(`platform.${metric.hint}`, { count: metric.amount ?? 0 })
      : t(['accounts', 'organisations', 'projects'].includes(metric.key) ? 'platform.allTime'
        : metric.key === 'activeUsers' ? 'platform.last24h' : 'platform.selectedPeriod');
    ctx.text(pane.content, hint, cardX + 14, cardY + 72, { size: 9, color: GPU_COLORS.muted, width: cardWidth - 28, singleLine: true });
    ctx.tooltip(pane.content, { x: cardX, y: cardY, width: cardWidth, height: 96,
      text: `${t(`platform.metric.${metric.key}`)}: ${number(metric.value, metric.currency)} · ${hint}` });
  }
  y += Math.ceil(metrics.length / columns) * 108 + 8;
  line(t('platform.scope'));
  line(stats.traffic ? t('platform.trafficSince', { at: formatDateTime(stats.traffic.startedAt, locale) }) : t('platform.trafficUnavailable'));
  line(t('platform.costNote'));
  if (stats.projects?.unmeteredRuns) line(t('platform.unmetered', { count: stats.projects.unmeteredRuns }));

  const daily = platformDaily(stats);
  const chart = (key: 'requests' | 'signups' | 'runs', color: number) => {
    const chartHeight = 172;
    if (pane.visible(y, y + chartHeight)) {
      ctx.panel(pane.content, x, y, w, chartHeight, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
      ctx.text(pane.content, t(`platform.chart.${key}`), x + 14, y + 12, { size: 13, width: w - 28 });
      const max = Math.max(1, ...daily.map(row => row[key] ?? 0));
      const plotX = x + 44;
      const plotW = Math.max(1, w - 64);
      const plotY = y + 44;
      const plotH = 90;
      const step = plotW / daily.length;
      const graph = new Graphics();
      graph.moveTo(plotX, plotY + plotH).lineTo(plotX + plotW, plotY + plotH).stroke({ color: GPU_COLORS.border, width: 1 });
      ctx.text(pane.content, number(max), x + 8, plotY, { size: 9, color: GPU_COLORS.muted, width: 34, singleLine: true });
      for (const [index, day] of daily.entries()) {
        const value = day[key];
        const h = value === null ? 0 : value / max * plotH;
        if (value !== null) graph.rect(plotX + index * step, plotY + plotH - Math.max(1, h), Math.max(1, step - 2), Math.max(1, h)).fill({ color, alpha: value ? 0.85 : 0.2 });
        ctx.tooltip(pane.content, { x: plotX + index * step, y: plotY, width: step, height: plotH,
          text: `${day.day} UTC · ${t(`platform.chart.${key}`)}: ${value === null ? t('platform.noMeasurement') : number(value)}` });
      }
      pane.content.addChild(graph);
      const dateLabel = (day: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(day));
      ctx.text(pane.content, dateLabel(daily[0]!.day), plotX, y + 146, { size: 9, color: GPU_COLORS.muted });
      ctx.text(pane.content, dateLabel(daily.at(-1)!.day), Math.max(plotX, x + w - 100), y + 146, { size: 9, color: GPU_COLORS.muted, width: 85 });
    }
    y += chartHeight + 12;
  };
  chart('requests', GPU_COLORS.primary);
  chart('signups', GPU_COLORS.success);
  chart('runs', GPU_COLORS.primary);

  const section = (title: string, rows: Array<[string, string]>) => {
    y += 8;
    line(title, 14, GPU_COLORS.text);
    for (const [label, value] of rows) {
      const valueWidth = Math.min(120, w * 0.36);
      const name = ctx.text(pane.content, label, x + 14, y, { size: 11, width: Math.max(1, w - valueWidth - 42), color: GPU_COLORS.muted });
      const amount = ctx.text(pane.content, value, x + w - valueWidth - 14, y, { size: 11, width: valueWidth, color: GPU_COLORS.text });
      const rowHeight = Math.max(18, name.height, amount.height);
      ctx.tooltip(pane.content, { x: x + 14, y, width: w - 28, height: rowHeight, text: `${label}: ${value}` });
      y += rowHeight + 8;
    }
  };
  section(t('platform.execution'), PLATFORM_RUN_STATES.map(state => [t(`platform.run.${state}`), number(stats.projects?.[state] ?? null)]));
  const traffic = stats.traffic?.totals;
  section(t('platform.health'), [
    [t('platform.clientErrors'), number(traffic?.clientErrors ?? null)],
    [t('platform.serverErrors'), number(traffic?.serverErrors ?? null)],
    [t('platform.meanResponse'), traffic?.requests ? `${number(traffic.durationMs / traffic.requests)} ms` : '—'],
    [t('platform.uptime'), runDuration(stats.uptimeSeconds * 1000, t)],
    [t('platform.pendingInvitations'), number(stats.accounts.pendingInvitations)],
  ]);
  section(t('platform.surfaces'), stats.traffic?.surfaces.map(row => [t(`platform.surface.${row.surface}`), number(row.requests)]) ?? []);
  section(t('platform.recentSignups'), stats.accounts.recent.map(row => [row.displayName, formatDateTime(row.createdAt, locale)]));
  if (!stats.accounts.recent.length) line(t('platform.noSignups'));
  y += 8;
  line(t('platform.privacy'));
  pane.extend(y);
  ctx.scrollMax.platform = pane.finish();
}
