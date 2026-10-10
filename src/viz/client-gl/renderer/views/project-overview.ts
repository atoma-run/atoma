import { Container, Graphics, Rectangle } from 'pixi.js';
import type { VizProject, VizProjectRun } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { dateTimeFormat } from '../../../client/date-format.js';
import { fmtCost, runCost, runDuration } from '../../../client/run-utils.js';
import { relativeTime, timestampTooltip } from '../relative-time.js';
import { drawChevron } from '../button-icon.js';
import { CHEVRON_SIZE } from '../../button-icons.js';
import { createScrollPane } from '../scroll-pane.js';
import { viewFrame } from '../view-frame.js';
import { projectOverview, type OverviewSlice, type OverviewSliceModel, type ProjectOverview } from '../../project-overview.js';
import type { CostSliceKey } from '../../../../contracts/runCostBreakdown.js';

/**
 * The selected project's general view: who ran it, how often, how it went,
 * and where the money went by L1/L2/L3 pin and Jev. A RIGHT COLUMN beside the
 * Conversation and Runs sections where the frame has room for both; below
 * that width it heads the Runs list instead, so a phone still reaches it and
 * the conversation keeps the whole column.
 */

/** Below this content width the column would squeeze the conversation. */
export const PROJECT_ASIDE_MIN_CONTENT_WIDTH = 960;
export const PROJECT_ASIDE_GAP = 16;
const ASIDE_MIN_WIDTH = 300;
const ASIDE_MAX_WIDTH = 400;
const PAD = 16;
const ROW = 18;
const SECTION_GAP = 14;
const HEADING_HEIGHT = 20;
const LEGEND_ROW = 22;
const LEGEND_SUB_ROW = 18;
const RIM_WIDTH = 3;
const RIM_GAP = 3;
const DONUT_MAX = 168;
/**
 * Clear of the pane's scrollbar, which is drawn 5–8px inside the pane's right
 * edge: content that ran to 4px of it read as glued to the thumb.
 */
const SCROLLBAR_GUTTER = 24;
/** The folded column: a strip holding the toggle and the total. */
export const PROJECT_ASIDE_COLLAPSED_WIDTH = 52;
const TOGGLE_SIZE = 28;
const TOGGLE_ID = 'project.overview.toggle';
/**
 * Where hover bubbles for a region stay, so none slides under the DOM
 * conversation. In the coordinates of the parent that declares the bubble.
 */
type Lane = { readonly x: number; readonly width: number };

/**
 * Categorical identity of each slice. L1/L2/L3 are the tier colours the rest
 * of the client already uses, so a tier reads the same here as on a card; Jev
 * takes rose, validated against them on the panel surface (CVD ΔE ≥ 10,
 * normal-vision ΔE ≥ 15 for every adjacent pair). Unattributed spend is grey.
 */
export const OVERVIEW_SLICE_COLORS: Readonly<Record<CostSliceKey, number>> = {
  l1: GPU_COLORS.tiers[1],
  l2: GPU_COLORS.tiers[2],
  l3: GPU_COLORS.tiers[3],
  jev: 0xfb7185,
  other: GPU_COLORS.muted,
};

/**
 * The shade of the `index`-th model to serve a tier, in order of first use:
 * the tier's own colour first, then alternately lighter and darker steps of
 * the SAME hue, so every shade still reads as its tier. Identity never rests
 * on the shade alone: the legend names each model and a hairline parts them.
 */
const SHADE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0xffffff, 0], [0x000000, 0.34], [0xffffff, 0.42], [0x000000, 0.55], [0xffffff, 0.68], [0x000000, 0.18],
];
export function modelShade(base: number, index: number): number {
  const [toward, amount] = SHADE_STEPS[index % SHADE_STEPS.length]!;
  const mix = (shift: number) => {
    const from = (base >> shift) & 0xff;
    const to = (toward >> shift) & 0xff;
    return Math.round(from + (to - from) * amount) << shift;
  };
  return mix(16) | mix(8) | mix(0);
}

/** Where the column sits, or null when the frame is too narrow for it. */
export function projectAsideLayout(viewportWidth: number, collapsed = false): { mainWidth: number; asideX: number; asideWidth: number } | null {
  const frame = viewFrame(viewportWidth, 0);
  if (frame.innerWidth < PROJECT_ASIDE_MIN_CONTENT_WIDTH) return null;
  const asideWidth = collapsed ? PROJECT_ASIDE_COLLAPSED_WIDTH
    : Math.round(Math.min(ASIDE_MAX_WIDTH, Math.max(ASIDE_MIN_WIDTH, frame.innerWidth * 0.28)));
  return {
    mainWidth: frame.innerWidth - asideWidth - PROJECT_ASIDE_GAP,
    asideX: frame.innerX + frame.innerWidth - asideWidth,
    asideWidth,
  };
}

/** The sections that carry the column; the others need the whole width. */
export function projectSectionShowsAside(section: GpuRenderSnapshot['state']['projectSection']): boolean {
  return section === 'conversation' || section === 'runs';
}

/**
 * Width the DOM conversation must leave on its right, in scene pixels: the
 * renderer publishes it as `--gpu-project-aside` so the transparent form and
 * the GPU card beneath it keep one right edge.
 */
export function projectAsideReserve(snapshot: GpuRenderSnapshot, viewportWidth: number): number {
  if (!snapshot.state.selectedProjectId || !projectSectionShowsAside(snapshot.state.projectSection)) return 0;
  if (!snapshot.data.projects?.some(project => project.projectId === snapshot.state.selectedProjectId)) return 0;
  const aside = projectAsideLayout(viewportWidth, snapshot.state.projectOverviewCollapsed);
  return aside ? aside.asideWidth + PROJECT_ASIDE_GAP : 0;
}

type Translate = GpuRenderSnapshot['t'];

function sliceLabel(t: Translate, key: CostSliceKey): string {
  return t(`projects.overview.slice.${key}`);
}

/** Cents for anything a cent can show; four decimals below, where cents would read "<$0.01". */
function cost(value: number): string {
  return value > 0 && value < 0.01 ? fmtCost(value) : runCost(value);
}

function percent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function whole(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

const SUBSCRIPTION_PAYERS = new Set(['host-subscription', 'principal-subscription']);

/** Everything a reader needs to analyse one slice, for the bubble and the accessible table. */
export function overviewSliceDetail(t: Translate, slice: OverviewSlice, overview: ProjectOverview, locale: string): string {
  const lines = [
    `${sliceLabel(t, slice.key)} — ${cost(slice.costUsd)} (${percent(slice.share, locale)})`,
    t(slice.key === 'jev' ? 'projects.overview.detail.decisions' : 'projects.overview.detail.calls', {
      count: slice.calls, value: whole(slice.calls, locale),
    }) + (slice.requests !== undefined ? ` · ${t('projects.overview.detail.requests', { value: whole(slice.requests, locale) })}` : ''),
    t('projects.overview.detail.tokens', {
      input: compact(slice.inputTokens, locale), output: compact(slice.outputTokens, locale),
    }) + (slice.cacheReadInputTokens + slice.cacheCreationInputTokens > 0
      ? ` · ${t('projects.overview.detail.cache', {
        read: compact(slice.cacheReadInputTokens, locale), written: compact(slice.cacheCreationInputTokens, locale),
      })}` : ''),
    t('projects.overview.detail.perRun', { cost: cost(slice.costUsd / Math.max(1, slice.runs)), count: slice.runs }),
  ];
  if (slice.models.length) {
    lines.push(t('projects.overview.detail.models'));
    for (const model of slice.models.slice(0, 6)) {
      lines.push(`  ${model.model} — ${cost(model.costUsd)} · ${t('projects.overview.detail.callsShort', { count: model.calls, value: whole(model.calls, locale) })} · ${t('projects.overview.runs', { count: model.runs })}`);
    }
    if (slice.models.length > 6) lines.push(`  ${t('projects.overview.detail.more', { count: slice.models.length - 6 })}`);
  }
  if (slice.roles.length) {
    lines.push(t('projects.overview.detail.roles'));
    for (const role of slice.roles.slice(0, 8)) {
      lines.push(`  ${role.role} — ${cost(role.costUsd)} · ${whole(role.calls, locale)}`);
    }
    if (slice.roles.length > 8) lines.push(`  ${t('projects.overview.detail.more', { count: slice.roles.length - 8 })}`);
  }
  if (slice.pins.length) {
    lines.push(t('projects.overview.detail.pins'));
    for (const pin of slice.pins.slice(0, 4)) lines.push(`  ${pin.selection} · ${t('projects.overview.runs', { count: pin.runs })}`);
  }
  if (slice.payers.length) {
    lines.push(t('projects.overview.detail.payers', {
      value: slice.payers.map(payer => `${t(`projects.overview.payer.${payer.payer}`)} ×${payer.runs}`).join(', '),
    }));
  }
  if (slice.payers.some(payer => SUBSCRIPTION_PAYERS.has(payer.payer))) lines.push(t('projects.overview.subscriptionNote'));
  if (slice.key === 'jev') lines.push(t('projects.overview.jevNote'));
  if (overview.breakdownRuns < overview.runCount) {
    lines.push(t('projects.overview.coverage', { covered: overview.breakdownRuns, count: overview.runCount }));
  }
  return lines.join('\n');
}

/** One model's share of its tier: the bubble of its shaded wedge and legend row. */
export function overviewModelDetail(t: Translate, slice: OverviewSlice, model: OverviewSliceModel,
  overview: ProjectOverview, locale: string): string {
  const firstUse = new Date(model.firstRunAt);
  return [
    `${sliceLabel(t, slice.key)} › ${model.model}`,
    t('projects.overview.modelShare', {
      cost: cost(model.costUsd),
      share: percent(overview.breakdownTotalUsd > 0 ? model.costUsd / overview.breakdownTotalUsd : 0, locale),
      tierShare: percent(slice.costUsd > 0 ? model.costUsd / slice.costUsd : 0, locale),
      tier: sliceLabel(t, slice.key),
    }),
    `${t('projects.overview.detail.callsShort', { count: model.calls, value: whole(model.calls, locale) })} · ${t('projects.overview.modelRuns', {
      count: model.runs,
      date: Number.isNaN(firstUse.getTime()) ? model.firstRunAt : dateTimeFormat(locale, { dateStyle: 'medium' }).format(firstUse),
    })}`,
  ].join('\n');
}

/** Draw the overview body from `y`; returns its height. */
function drawBody(ctx: RendererCtx, snapshot: GpuRenderSnapshot, parent: Container, x: number, y: number, width: number,
  project: VizProject, overview: ProjectOverview, lane: Lane, withHeader: boolean): number {
  const { t } = snapshot;
  // Every bubble of this column stays inside it (`TooltipRegion.lane`).
  const tip = (region: Parameters<RendererCtx['tooltip']>[1]) => ctx.tooltip(parent, { ...region, lane });
  const locale = snapshot.state.locale;
  let cursor = y;
  const heading = (copy: string) => {
    if (cursor > y) cursor += SECTION_GAP;
    ctx.text(parent, copy, x, cursor, { size: 10, weight: '700', color: GPU_COLORS.muted, width, singleLine: true });
    cursor += HEADING_HEIGHT;
  };
  const labelWidth = Math.min(132, Math.round(width * 0.42));
  const row = (label: string, value: string, tooltip?: string | null, color: number = GPU_COLORS.text) => {
    ctx.text(parent, label, x, cursor, { size: 11, color: GPU_COLORS.muted, width: labelWidth - 8, singleLine: true });
    ctx.text(parent, value, x + labelWidth, cursor, { size: 11, color, width: width - labelWidth, singleLine: true });
    tip({ x, y: cursor, width, height: ROW - 2, text: tooltip ?? `${label}: ${value}` });
    cursor += ROW;
  };
  const exact = (instant: string | null) => instant ? timestampTooltip(instant, locale) : null;
  const ago = (instant: string | null) => instant ? relativeTime(instant, t, locale) || instant : '—';

  if (withHeader) {
    drawHeader(ctx, snapshot, parent, x, cursor, width, lane);
    cursor += 34;
  }

  heading(t('projects.overview.project'));
  const created = new Date(project.createdAt);
  row(t('projects.overview.created'), Number.isNaN(created.getTime()) ? project.createdAt
    : dateTimeFormat(locale, { dateStyle: 'medium' }).format(created), exact(project.createdAt));
  // The repository is the page header's, beside the section tabs: not repeated here.
  if (project.status === 'archived') row(t('projects.overview.state'), t('projects.overview.archived'), null, GPU_COLORS.warning);

  heading(t('projects.overview.runsHeading'));
  row(t('projects.overview.runCount'), whole(overview.runCount, locale) + (overview.reruns
    ? ` (${t('projects.overview.reruns', { count: overview.reruns })})` : ''));
  if (overview.runCount > 0) {
    const counts = overview.statusCounts;
    const outcomes = (['delivered', 'partial', 'failed', 'cancelled', 'running', 'queued'] as const)
      .filter(status => counts[status] > 0)
      .map(status => `${counts[status]} ${t(`projects.runStatus.${status}`)}`);
    row(t('projects.overview.outcomes'), outcomes.join(' · '), outcomes.join('\n'));
    const ended = counts.delivered + counts.partial + counts.failed + counts.cancelled;
    if (ended > 0) {
      row(t('projects.overview.deliveryRate'), percent(counts.delivered / ended, locale),
        t('projects.overview.deliveryRateHint', { delivered: counts.delivered, ended }));
    }
    row(t('projects.overview.published'), whole(overview.published, locale));
    row(t('projects.overview.firstRun'), ago(overview.firstRunAt), exact(overview.firstRunAt));
    row(t('projects.overview.lastRun'), ago(overview.lastRunAt), exact(overview.lastRunAt));
    row(t('projects.overview.runTime'), runDuration(overview.totalDurationS * 1000, t),
      overview.medianDurationS === null ? null
        : t('projects.overview.medianRunTime', { value: runDuration(overview.medianDurationS * 1000, t) }));

    heading(t('projects.overview.usage'));
    row(t('projects.overview.llmCost'), runCost(overview.llmCostUsd),
      t('projects.overview.llmCostHint', { value: cost(overview.llmCostUsd ?? 0), average: cost((overview.llmCostUsd ?? 0) / overview.runCount) }));
    row(t('projects.overview.tokens'), compact(overview.tokens, locale), whole(overview.tokens, locale));
    row(t('projects.overview.llmCalls'), whole(overview.llmCalls, locale));
    row(t('projects.overview.jevCalls'), (overview.jevCallsLowerBound ? '≥ ' : '') + whole(overview.jevCalls, locale),
      overview.jevCallsLowerBound ? t('projects.runJevCallsLowerBound') : null);

    heading(t('projects.overview.launchedBy'));
    for (const requester of overview.requesters) {
      const value = `${t('projects.overview.runs', { count: requester.runs })} · ${runCost(requester.costUsd)}`;
      const valueWidth = Math.min(width * 0.5, Math.ceil(ctx.measureText(value, { size: 11 })));
      ctx.text(parent, requester.name, x, cursor, { size: 11, width: width - valueWidth - 10, singleLine: true });
      ctx.text(parent, value, x + width - valueWidth, cursor, { size: 11, color: GPU_COLORS.muted, width: valueWidth, singleLine: true });
      tip({ x, y: cursor, width, height: ROW - 2, text: [
        requester.name, value,
        t('projects.overview.lastRunBy', { value: exact(requester.lastRunAt) ?? requester.lastRunAt }),
      ].join('\n') });
      cursor += ROW;
    }
  }

  heading(t('projects.overview.costBreakdown'));
  if (overview.slices.length === 0 || overview.breakdownTotalUsd <= 0) {
    const empty = ctx.text(parent, t(overview.breakdownRuns ? 'projects.overview.noCost' : 'projects.overview.noBreakdown'),
      x, cursor, { size: 11, color: GPU_COLORS.muted, width });
    return cursor + empty.height - y;
  }
  const diameter = Math.min(DONUT_MAX, width - 24);
  // The rim groups a tier's shades as one tier; the ring sits inside it.
  const rimOuter = diameter / 2;
  const outer = rimOuter - RIM_GAP - RIM_WIDTH;
  const inner = outer * 0.62;
  const cx = x + width / 2;
  const cy = cursor + rimOuter + 4;
  const donut = new Graphics();
  const rims = new Graphics();
  let angle = -Math.PI / 2;
  const turn = Math.PI * 2;
  const paid = overview.slices.filter(slice => slice.costUsd > 0);
  const boundaries: number[] = [];
  for (const slice of paid) {
    const sliceEnd = angle + turn * slice.costUsd / overview.breakdownTotalUsd;
    const base = OVERVIEW_SLICE_COLORS[slice.key];
    const sliceDetail = overviewSliceDetail(t, slice, overview, locale);
    // One wedge per model that served this tier, shaded in order of first use.
    let modelStart = angle;
    const shaded = slice.modelsByFirstUse.filter(model => model.costUsd > 0);
    shaded.forEach((model, index) => {
      const modelEnd = index === shaded.length - 1 ? sliceEnd
        : modelStart + turn * model.costUsd / overview.breakdownTotalUsd;
      const color = modelShade(base, index);
      donut.moveTo(cx + outer * Math.cos(modelStart), cy + outer * Math.sin(modelStart));
      donut.arc(cx, cy, outer, modelStart, modelEnd);
      donut.lineTo(cx + inner * Math.cos(modelEnd), cy + inner * Math.sin(modelEnd));
      donut.arc(cx, cy, inner, modelEnd, modelStart, true);
      donut.closePath();
      donut.fill({ color });
      // A hairline between a tier's models; tiers get the wider gap below.
      if (shaded.length > 1) donut.stroke({ color: GPU_COLORS.panel, width: 1 });
      tip({
        x: cx - rimOuter, y: cy - rimOuter, width: diameter, height: diameter,
        // The model's own share; the tier's full detail is its rim's and its legend row's.
        text: overviewModelDetail(t, slice, model, overview, locale),
        accent: color, fontSize: 11,
        wedge: { cx, cy, inner, outer, start: modelStart, end: modelEnd },
      });
      modelStart = modelEnd;
    });
    rims.arc(cx, cy, rimOuter - RIM_WIDTH / 2, angle, sliceEnd);
    rims.stroke({ color: base, width: RIM_WIDTH });
    tip({
      x: cx - rimOuter, y: cy - rimOuter, width: diameter, height: diameter,
      text: sliceDetail, accent: base, fontSize: 11,
      wedge: { cx, cy, inner: outer, outer: rimOuter, start: angle, end: sliceEnd },
    });
    boundaries.push(angle);
    angle = sliceEnd;
  }
  // The surface gap between TIERS, wider than the hairline between a tier's models.
  if (paid.length > 1) {
    for (const boundary of boundaries) {
      donut.moveTo(cx + (inner - 1) * Math.cos(boundary), cy + (inner - 1) * Math.sin(boundary));
      donut.lineTo(cx + (rimOuter + 1) * Math.cos(boundary), cy + (rimOuter + 1) * Math.sin(boundary));
      donut.stroke({ color: GPU_COLORS.panel, width: 3 });
    }
  }
  parent.addChild(rims, donut);
  const total = runCost(overview.breakdownTotalUsd);
  const totalStyle = { size: 16, weight: '700' } as const;
  const totalWidth = Math.ceil(ctx.measureText(total, totalStyle));
  ctx.text(parent, total, cx - totalWidth / 2, cy - 14, { ...totalStyle, width: totalWidth + 2, singleLine: true });
  const caption = t('projects.overview.total');
  const captionWidth = Math.min(inner * 1.6, Math.ceil(ctx.measureText(caption, { size: 9 })));
  ctx.text(parent, caption, cx - captionWidth / 2, cy + 6, { size: 9, color: GPU_COLORS.muted, width: captionWidth + 2, singleLine: true });
  cursor += diameter + 16;

  const legendRow = (swatchColor: number, indent: number, label: string, value: string, tooltip: string,
    accent: number, size: number, labelColor: number = GPU_COLORS.text) => {
    const main = size >= 11;
    const swatch = new Graphics();
    const box = main ? 10 : 8;
    swatch.roundRect(x + indent, cursor + (main ? 3 : 4), box, box, 2).fill({ color: swatchColor });
    parent.addChild(swatch);
    const valueWidth = Math.ceil(ctx.measureText(value, { size }));
    const labelX = x + indent + box + 8;
    ctx.text(parent, label, labelX, cursor, { size, color: labelColor,
      width: Math.max(0, x + width - valueWidth - 10 - labelX), singleLine: true });
    ctx.text(parent, value, x + width - valueWidth, cursor, { size, color: GPU_COLORS.muted, width: valueWidth + 2, singleLine: true });
    tip({ x, y: cursor, width, height: (main ? LEGEND_ROW : LEGEND_SUB_ROW) - 2, text: tooltip, accent, fontSize: 11 });
    cursor += main ? LEGEND_ROW : LEGEND_SUB_ROW;
  };
  for (const slice of overview.slices) {
    const base = OVERVIEW_SLICE_COLORS[slice.key];
    const sliceDetail = overviewSliceDetail(t, slice, overview, locale);
    const models = slice.modelsByFirstUse;
    // One model: named on the tier's row. Several: counted there, each on its own shaded row.
    const label = models.length === 1 ? `${sliceLabel(t, slice.key)} · ${models[0]!.model}`
      : models.length > 1 ? `${sliceLabel(t, slice.key)} · ${t('projects.overview.models', { count: models.length })}`
        : sliceLabel(t, slice.key);
    legendRow(base, 0, label, `${cost(slice.costUsd)} · ${percent(slice.share, locale)}`, sliceDetail, base, 11);
    if (models.length > 1) {
      models.forEach((model, index) => {
        const color = modelShade(base, index);
        legendRow(color, 18, model.model,
          `${cost(model.costUsd)} · ${percent(model.costUsd / overview.breakdownTotalUsd, locale)}`,
          overviewModelDetail(t, slice, model, overview, locale), color, 10, GPU_COLORS.muted);
      });
      cursor += 4;
    }
  }
  const notes = [
    overview.slices.some(slice => slice.key === 'jev') ? t('projects.overview.jevNote') : null,
    overview.subscriptionPriced ? t('projects.overview.subscriptionNote') : null,
    overview.breakdownRuns < overview.runCount
      ? t('projects.overview.coverage', { covered: overview.breakdownRuns, count: overview.runCount }) : null,
  ].filter((note): note is string => note !== null);
  if (notes.length) {
    cursor += 6;
    const note = ctx.text(parent, notes.join(' '), x, cursor, { size: 9, color: GPU_COLORS.muted, width });
    cursor += note.height;
  }
  return cursor - y;
}

/** The project's overview, from the run list the screen already holds. */
export function selectedProjectOverview(snapshot: GpuRenderSnapshot, projectId: string): ProjectOverview {
  const runs: readonly VizProjectRun[] = snapshot.data.projectRuns?.[projectId] ?? [];
  return projectOverview(runs, snapshot.t('projects.overview.unknownUser'));
}

/** The fold control: a chevron pointing where the column goes. */
function drawToggle(ctx: RendererCtx, snapshot: GpuRenderSnapshot, parent: Container, x: number, y: number,
  lane: Lane): void {
  const collapsed = snapshot.state.projectOverviewCollapsed;
  const label = snapshot.t(collapsed ? 'projects.overview.expand' : 'projects.overview.collapse');
  ctx.button(parent, TOGGLE_ID, 'button', '', x, y, TOGGLE_SIZE, TOGGLE_SIZE, false, snapshot.onActivate,
    GPU_COLORS.primary, true, false, undefined, undefined, label, false, null);
  drawChevron(parent, x + (TOGGLE_SIZE - CHEVRON_SIZE) / 2, y + (TOGGLE_SIZE - CHEVRON_SIZE) / 2, GPU_COLORS.muted,
    collapsed ? 'left' : 'right');
  ctx.tooltip(parent, { x, y, width: TOGGLE_SIZE, height: TOGGLE_SIZE, text: label, lane });
}

function drawHeader(ctx: RendererCtx, snapshot: GpuRenderSnapshot, parent: Container, x: number, y: number,
  width: number, lane: Lane): void {
  ctx.text(parent, snapshot.t('projects.overview.title'), x, y + 5,
    { size: 14, weight: '700', width: width - TOGGLE_SIZE - 8, singleLine: true });
  drawToggle(ctx, snapshot, parent, x + width - TOGGLE_SIZE, y, lane);
}

/**
 * The right column: a framed card from `top` to the frame's foot, its body
 * in its own masked pane on the detail wheel channel, so a long list of
 * launchers never pushes the chart out of reach. Folded, it is a strip with
 * the toggle and the total, and the conversation takes the width back.
 */
export function drawProjectAside(ctx: RendererCtx, snapshot: GpuRenderSnapshot, project: VizProject,
  aside: { asideX: number; asideWidth: number }, top: number, bottom: number): void {
  const height = Math.max(0, bottom - top);
  ctx.panel(ctx.root, aside.asideX, top, aside.asideWidth, height, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
  const lane = { x: aside.asideX, width: aside.asideWidth };
  const overview = selectedProjectOverview(snapshot, project.projectId);
  if (snapshot.state.projectOverviewCollapsed) {
    drawToggle(ctx, snapshot, ctx.root, aside.asideX + (aside.asideWidth - TOGGLE_SIZE) / 2, top + 12, lane);
    if (overview.breakdownTotalUsd > 0) {
      const total = runCost(overview.breakdownTotalUsd);
      const style = { size: 10, weight: '600', color: GPU_COLORS.muted } as const;
      const fitted = ctx.fitText(total, aside.asideWidth - 8, style);
      const totalWidth = Math.ceil(ctx.measureText(fitted, style));
      ctx.text(ctx.root, fitted, aside.asideX + (aside.asideWidth - totalWidth) / 2, top + 50, { ...style, width: totalWidth + 2, singleLine: true });
      ctx.tooltip(ctx.root, { x: aside.asideX, y: top + 46, width: aside.asideWidth, height: 20,
        text: snapshot.t('projects.overview.collapsedTotal', { value: total }) });
    }
    return;
  }
  // The header stays put above the scrolled body, so the toggle never scrolls away.
  const inset = PAD;
  drawHeader(ctx, snapshot, ctx.root, aside.asideX + inset, top + 12, aside.asideWidth - inset - SCROLLBAR_GUTTER + 8, lane);
  const paneX = aside.asideX + 4;
  const paneY = top + 50;
  const paneWidth = aside.asideWidth - 8;
  const paneHeight = Math.max(0, bottom - 4 - paneY);
  const pane = createScrollPane(ctx.root, { x: paneX, y: paneY, width: paneWidth, height: paneHeight,
    scrollY: ctx.detailScrollY, bottomPadding: PAD });
  ctx.detailBounds = new Rectangle(paneX, paneY, paneWidth, paneHeight);
  const left = inset - 4;
  // A lane is in the coordinates of the parent that declares the bubble: the pane's content here.
  const used = drawBody(ctx, snapshot, pane.content, left, 4, paneWidth - left - SCROLLBAR_GUTTER, project,
    overview, { x: aside.asideX - paneX, width: aside.asideWidth }, false);
  pane.extend(used + 4);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
}

/**
 * The same overview as a card INSIDE a scrolled list (narrow frames): drawn
 * first so its height is measured, then framed beneath its own body. Folded,
 * only its header remains. Returns the card's height.
 */
export function drawProjectOverviewCard(ctx: RendererCtx, snapshot: GpuRenderSnapshot, parent: Container,
  project: VizProject, x: number, y: number, width: number): number {
  const card = new Container();
  parent.addChild(card);
  const body = new Container();
  card.addChild(body);
  const lane = { x, width };
  const collapsed = snapshot.state.projectOverviewCollapsed;
  const used = collapsed
    ? (drawHeader(ctx, snapshot, body, x + PAD, y + 10, width - PAD * 2, lane), TOGGLE_SIZE)
    : drawBody(ctx, snapshot, body, x + PAD, y + PAD, width - PAD * 2, project,
      selectedProjectOverview(snapshot, project.projectId), lane, true);
  const height = used + (collapsed ? 20 : PAD * 2);
  ctx.panel(card, x, y, width, height, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
  // Re-adding moves the body above the frame; its position, and so every
  // hover region already projected from it, is unchanged.
  card.addChild(body);
  return height;
}
