import { Graphics } from 'pixi.js';
import { dateTimeFormat } from '../../../client/date-format.js';
import type { VizProjectRun } from '../../../client/types.js';
import { BUTTON_LABEL_INSET } from '../../gpu-renderer.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { fmtMs } from '../../../client/run-utils.js';
import { relativeTime, timestampTooltip } from '../relative-time.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_CONTENT_TOP, VIEW_FRAME_PAD } from '../view-frame.js';
import { drawResultPanel } from './result.js';
import { latestDeliveredResult } from '../../run-result.js';

/**
 * Projects view: the organisation's projects, their GitHub repository state
 * and their runs with publication receipts. Follows the 2026-08-15 view
 * decomposition: a free function over the exported RendererCtx, one measured
 * layout pass, scroll through the shared masked pane, honest `scrollMax`.
 *
 * The MCP onboarding guide is a DOM overlay (`.gpu-project-mcp`). GPU copy
 * and the project list start below that band so labels never sit under it.
 */

const ROW_HEIGHT = 58;
/**
 * Wide rows keep the name button a single-line control and stack the
 * metadata BELOW it, like the run rows stack their second line. The metadata
 * used to render INSIDE the 46px button frame, 11px under a vertically
 * centred label — the two lines nearly touched, and the frame read as
 * cramped at any width (2026-08-24 review of the live Projects screen).
 */
const PROJECT_BUTTON_HEIGHT = 46;
const COMPACT_ROW_HEIGHT = ROW_HEIGHT;
/** A selected project owns the page title, so its detail row omits the name button. */
const SELECTED_PROJECT_DETAIL_HEIGHT = ROW_HEIGHT;
const SELECTED_PROJECT_COMPACT_DETAIL_HEIGHT = ROW_HEIGHT;
const COMPACT_PROJECT_PANEL_WIDTH = 400;
const RUN_CARD_HEIGHT = 100;
const RUN_COMPACT_CARD_HEIGHT = 140;
const RUN_ROW_GAP = 14;
const RUN_RESULT_GAP = 14;
const RUN_RESULT_HEIGHT = 32;
const RUN_RESULT_SPACE = RUN_RESULT_GAP + RUN_RESULT_HEIGHT;
const RUN_SECOND_LINE_EXTRA = 20;
const STATUS_FONT_SIZE = 10;
/** The linked mesh carries inset detail, so its full box must be visibly larger than the copy. */
export const REPOSITORY_ICON_SIZE = 42;
/** The mesh has transparent padding inside its box; overlap it to keep the visible mark near the URL. */
export const REPOSITORY_ICON_GAP = -6;
/** Pull the padded texture toward the separator without moving the link's logical start. */
const REPOSITORY_ICON_OFFSET_X = -8;
export const PRIVATE_REPOSITORY_ICON_SIZE = 13;
export const PRIVATE_REPOSITORY_ICON_GAP = 6;
const PROJECT_INFO_GAP = 10;
const PROJECT_INFO_SEPARATOR = '·';
const PROJECT_INFO_SEPARATOR_BEFORE_GAP = 6;
/** Compensates for the repository mesh's transparent left inset. */
const PROJECT_INFO_SEPARATOR_AFTER_GAP = 0;
const PROJECT_INFO_TEXT_Y = 15;
const PROJECT_NAME_Y = 7;
const PROJECT_METADATA_Y = 28;

const PROJECT_CREATED_OPTIONS: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };

function projectCreatedDate(createdAt: string, locale: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return dateTimeFormat(locale, PROJECT_CREATED_OPTIONS).format(date);
}

/**
 * The repository link under the status needs more room than the status word:
 * at 108 it wrapped mid-URL. Reserved by the name/slug column on every row, so
 * a row that has a link and one that does not keep the same left column.
 */
/** Breathing room between the status column and the row's right border. */
export const PROJECTS_ROW_PAD = 14;
/**
 * Must match `.gpu-project-mcp { top }` in styles.css. The guide is the first
 * thing inside the column frame, so this is the frame's own content top.
 */
export const PROJECTS_MCP_GUIDE_TOP =
  GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + VIEW_FRAME_CONTENT_TOP;
/** The guide has one shape regardless of project selection. */
export const PROJECTS_MCP_GUIDE_HEIGHT = 180;
/** Below this content width the guide gains room for wrapped copy. */
export const PROJECTS_NARROW_CONTENT_WIDTH = 480;
/** Must match the narrow media query in styles.css. */
export const PROJECTS_MCP_GUIDE_NARROW_HEIGHT = 300;

export function projectsGuideHeight(contentWidth = Number.POSITIVE_INFINITY): number {
  return contentWidth < PROJECTS_NARROW_CONTENT_WIDTH
    ? PROJECTS_MCP_GUIDE_NARROW_HEIGHT
    : PROJECTS_MCP_GUIDE_HEIGHT;
}

export function projectsGpuContentTop(contentWidth = Number.POSITIVE_INFINITY): number {
  return PROJECTS_MCP_GUIDE_TOP + projectsGuideHeight(contentWidth) + 16;
}

/**
 * Room the runs heading takes, shared by the measuring and drawing passes —
 * two copies of this number would desynchronise `scrollMax` from the rows.
 */
const RUNS_HEADING_HEIGHT = 30;

/**
 * Whether a run row says, in plain words, what to do next. Only the NEWEST
 * run of a project, and only when it is incomplete: that is the one the next
 * run continues from, and on an older row "run again" is advice already taken.
 * An incomplete row's `error` is the acceptor's technical prose, so no
 * incomplete row prints it: the Runs view keeps it under its technical-details
 * heading instead.
 */
function showsPartialGuidance(run: VizProjectRun, newest: boolean): boolean {
  return newest && run.status === 'partial';
}

function runRowHeight(run: VizProjectRun, compact = false, newest = false): number {
  const hasSecondLine = Boolean(
    showsPartialGuidance(run, newest) ||
    (run.error && run.status !== 'partial') ||
    (run.publication?.status === 'published' && run.publication.pullRequestUrl)
  );
  return (compact ? RUN_COMPACT_CARD_HEIGHT : RUN_CARD_HEIGHT) + RUN_ROW_GAP + RUN_RESULT_SPACE +
    (hasSecondLine ? RUN_SECOND_LINE_EXTRA : 0);
}

const STATUS_COLORS: Record<string, number> = {
  active: GPU_COLORS.success,
  pending: GPU_COLORS.muted,
  creating: GPU_COLORS.warning,
  ready: GPU_COLORS.success,
  failed: GPU_COLORS.error,
  queued: GPU_COLORS.muted,
  running: GPU_COLORS.warning,
  delivered: GPU_COLORS.success,
  partial: GPU_COLORS.warning,
  cancelled: GPU_COLORS.muted,
  published: GPU_COLORS.success,
  publishing: GPU_COLORS.warning,
  suspended: GPU_COLORS.warning,
  deleted: GPU_COLORS.error,
};

function statusColor(status: string): number {
  return STATUS_COLORS[status] ?? GPU_COLORS.text;
}

function statusLabel(
  t: GpuRenderSnapshot['t'],
  status: string,
  prefix: string
): string {
  return t(`${prefix}.${status}`);
}

/**
 * A run's total cost, in MONEY — two decimals, and a leading `<` under a cent
 * rather than a rounded `$0.00` that reads as free.
 *
 * NOT `fmtCost`, which is fixed at four decimals on purpose: it prices a
 * SINGLE LLM call, where a tenth of a cent is the signal. A whole run's total
 * is read as an amount spent, and `$1.0200` reads as a defect. The wide
 * precision was invisible here only while the column truncated it away.
 */
function runCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

/** Horizontal inset the column leaves inside the content viewport, in total. */
export const PROJECTS_COLUMN_INSET = GPU_LAYOUT.gap * 2;

/**
 * ONE content column for this view, full-bleed like the other tabs. The DOM
 * guide and the GL panels below it are two cards in a single stack, and they
 * only read as one while they agree on both edges — the old form used to sit
 * flush left at 20 while the list centred itself, so the two cards stepped
 * sideways from each other. `.gpu-project-mcp` computes exactly this in
 * CSS; a test holds the two constants together.
 */
export function projectsColumn(viewportWidth: number): { x: number; width: number } {
  const frame = viewFrame(viewportWidth, 0);
  return { x: frame.innerX, width: frame.innerWidth };
}

/**
 * A SELECTION IS A FILTER, not just a highlight: with one project selected the
 * list shows THAT project and nothing else, so the MCP guide at the top of the
 * column names the project for the connected agent. Its name moves to the page
 * title rather than repeating as an active row; re-clicking Projects in the
 * rail returns to the full list.
 *
 * ONE definition, consulted by both the measuring pass (`projectLayout`) and
 * the drawing pass. Two copies of this rule would desynchronise `scrollMax`
 * from the content the moment one of them changed.
 */
function projectHidden(index: number, selectedIndex: number): boolean {
  return selectedIndex >= 0 && index !== selectedIndex;
}

function projectRowHeight(compact: boolean, selected: boolean): number {
  if (selected) {
    return compact ? SELECTED_PROJECT_COMPACT_DETAIL_HEIGHT : SELECTED_PROJECT_DETAIL_HEIGHT;
  }
  return compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
}

export function projectLayout(
  viewportWidth: number,
  projectCount: number,
  selectedIndex: number,
  selectedRuns: readonly VizProjectRun[]
) {
  const { x, width: panelWidth } = projectsColumn(viewportWidth);
  const compactRunRows = panelWidth < COMPACT_PROJECT_PANEL_WIDTH;

  const listTop = 16;
  let cursor = listTop;
  for (let index = 0; index < projectCount; index++) {
    if (projectHidden(index, selectedIndex)) continue;
    cursor += projectRowHeight(compactRunRows, index === selectedIndex);
    if (index !== selectedIndex) continue;
    if (selectedRuns.length === 0) {
      cursor += 24;
      continue;
    }
    cursor += RUNS_HEADING_HEIGHT;
    selectedRuns.forEach((run, runIndex) => {
      cursor += runRowHeight(run, compactRunRows, runIndex === 0);
    });
  }
  const contentBottom = cursor + 20;
  return { x, panelWidth, listTop, contentBottom };
}

/** Draw the projects list. Selected project expands to show its runs. */
export function drawProjects(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const projects = snapshot.data.projects ?? [];
  const installations = snapshot.data.githubInstallations ?? [];
  const runsByProject = snapshot.data.projectRuns ?? {};
  const scroll = snapshot.state.scrollY.projects;

  const selectedProject = projects.find((p) => p.projectId === snapshot.state.selectedProjectId);
  const frame = viewFrame(width, height);
  // Selection changes the SUBJECT of the screen. Once one project is open,
  // its name is the title; the collection count and “viewing …” subtitle no
  // longer describe the job in front of the viewer.
  drawViewFrame(
    ctx,
    frame,
    selectedProject
      ? snapshot.t('projects.selectedTitle', { name: selectedProject.name })
      : snapshot.t('nav.projects'),
    selectedProject ? undefined : snapshot.t('projects.summary', { count: projects.length })
  );

  // The form's fields are DOM, but its CARD is the same GPU panel as the list
  // below. A CSS imitation could share dimensions and still disagree on the
  // pointer-driven shadow, which is exactly what made the two adjacent cards
  // read at different depths. The DOM wrapper is transparent and supplies
  // interaction only; this panel owns material, border, radius and elevation.
  if (snapshot.data.auth !== null) {
    ctx.panel(
      ctx.root,
      frame.innerX,
      PROJECTS_MCP_GUIDE_TOP,
      frame.innerWidth,
      projectsGuideHeight(width),
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
  }

  // The DOM guide is gated on a session (`projectGuideEnabled` in DomBridge),
  // so an UNGATED instance renders none — and reserving the band it would have
  // occupied left a ~260px hole between the title and the copy explaining why
  // there is nothing here. Reserve the band only when the guide is really there.
  let contentTop = snapshot.data.auth === null
    ? frame.contentTop
    : projectsGpuContentTop(width);
  const resultRows = selectedProject ? runsByProject[selectedProject.projectId] ?? [] : [];
  if (snapshot.state.resultRunId && resultRows.some(run => (run.traceId ?? run.projectRunId) === snapshot.state.resultRunId)) {
    drawResultPanel(ctx, snapshot, frame.innerX, contentTop, frame.innerWidth,
      Math.max(100, frame.bottom - contentTop - VIEW_FRAME_PAD));
    ctx.scrollMax.projects = 0;
    return;
  }
  const latestResult = latestDeliveredResult(resultRows);
  if (latestResult) {
    ctx.button(ctx.root, `result.open.${latestResult.traceId}`, 'button', snapshot.t('result.latest'),
      frame.innerX, contentTop, Math.min(300, frame.innerWidth), 30, false, snapshot.onActivate);
    contentTop += 42;
  }
  if (projects.length === 0) {
    // Ungated deployments have no organisations, so projects cannot exist and
    // their API routes are absent — say that, instead of coaching the viewer
    // toward a GitHub connect flow the server will 404.
    const connectHint = snapshot.data.auth === null
      ? snapshot.t('projects.gateOff')
      : installations.length === 0
        ? snapshot.t('projects.emptyNoInstallation')
        : snapshot.t('projects.empty');
    ctx.text(ctx.root, connectHint, frame.innerX, contentTop, {
      size: 13,
      color: GPU_COLORS.muted,
      width: frame.innerWidth,
    });
    ctx.scrollMax.projects = 0;
    return;
  }

  // Clipped to the FRAME, not the viewport: rows that scrolled past the
  // column's bottom edge would otherwise draw over the page beneath it.
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: scroll,
    bottomPadding: 24,
  });

  const expandedRunList: (readonly VizProjectRun[])[] = projects.map(
    (p) => runsByProject[p.projectId] ?? []
  );
  const selectedIndex = selectedProject
    ? projects.findIndex((project) => project.projectId === selectedProject.projectId)
    : -1;
  const selectedRuns = selectedIndex >= 0 ? expandedRunList[selectedIndex] ?? [] : [];
  const viewportLayout = projectLayout(width, projects.length, selectedIndex, selectedRuns);
  // `projectLayout` stays viewport-absolute because the DOM guide consumes its
  // edges too. The scroll pane is positioned at `frame.x`, so drawing inside
  // `pane.content` uses the same layout relative to that pane.
  const layout = { ...viewportLayout, x: viewportLayout.x - frame.x };

  // Hug the list. Stretching to the remaining viewport left a hollow slab
  // under a handful of rows.
  ctx.panel(
    pane.content,
    layout.x,
    0,
    layout.panelWidth,
    layout.contentBottom,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );

  const columnX = layout.x + 18;
  const innerWidth = layout.panelWidth - 36;
  const runColumnX = layout.x + 34;
  const compactRunRows = layout.panelWidth < COMPACT_PROJECT_PANEL_WIDTH;
  let cursor = layout.listTop;
  projects.forEach((project, index) => {
    // A selection filters the list to its own card. Same rule the measuring
    // pass applied, so `scrollMax` describes what is really drawn.
    if (projectHidden(index, selectedIndex)) return;
    const y = cursor;
    const selected = project.projectId === snapshot.state.selectedProjectId;
    const rowLabel = project.name.replace(/\s+/g, ' ');
    const repositoryStatusCopy = statusLabel(
      snapshot.t,
      project.repositoryStatus,
      'projects.repoStatus'
    );
    const privateIconSpace = project.repositoryTarget.visibility === 'private'
      ? PRIVATE_REPOSITORY_ICON_SIZE + PRIVATE_REPOSITORY_ICON_GAP
      : 0;
    const statusWidth = ctx.measureText(repositoryStatusCopy, {
      size: STATUS_FONT_SIZE,
      mono: true,
    });
    const separatorWidth = ctx.measureText(PROJECT_INFO_SEPARATOR, {
      size: STATUS_FONT_SIZE,
      mono: true,
    });
    const destinationPath =
      `${project.repositoryTarget.owner}/${project.repositoryTarget.name}`;
    const destinationText = project.repositoryUrl ?? destinationPath;
    const destinationTextSize = project.repositoryUrl ? 9 : 10;
    const destinationTextNaturalWidth = ctx.measureText(destinationText, {
      size: destinationTextSize,
    });
    const destinationChromeWidth = project.repositoryUrl
      ? REPOSITORY_ICON_OFFSET_X + REPOSITORY_ICON_SIZE + REPOSITORY_ICON_GAP
      : 0;
    const fixedInfoWidth =
      privateIconSpace +
      statusWidth +
      PROJECT_INFO_SEPARATOR_BEFORE_GAP +
      separatorWidth +
      PROJECT_INFO_SEPARATOR_AFTER_GAP +
      destinationChromeWidth;
    // On a list row the project name keeps a useful left-hand column. In
    // detail its name is already the page title, so the repository sequence
    // may use the complete framed row.
    const nameReserve = selected
      ? 0
      : Math.min(280, Math.max(140, innerWidth * 0.22));
    const infoMaxWidth = Math.max(
      0,
      innerWidth - BUTTON_LABEL_INSET * 2 - nameReserve
    );
    const destinationTextWidth = Math.max(
      0,
      Math.min(destinationTextNaturalWidth, infoMaxWidth - fixedInfoWidth)
    );
    const infoWidth = fixedInfoWidth + destinationTextWidth;
    const infoX = selected
      ? columnX + BUTTON_LABEL_INSET
      : columnX + innerWidth - PROJECTS_ROW_PAD - infoWidth;
    const nameLabelWidth = Math.max(
      0,
      infoX - columnX - BUTTON_LABEL_INSET * 2 - PROJECT_INFO_GAP
    );

    if (!selected) {
      ctx.button(
        pane.content,
        `project.select.${project.projectId}`,
        'button',
        rowLabel,
        columnX,
        y,
        innerWidth,
        PROJECT_BUTTON_HEIGHT,
        false,
        snapshot.onActivate,
        GPU_COLORS.primary,
        false,
        false,
        nameLabelWidth,
        PROJECT_NAME_Y
      );
      const runCount = project.runCount ?? runsByProject[project.projectId]?.length;
      const lastRunAt = project.lastRunAt ?? runsByProject[project.projectId]?.[0]?.createdAt;
      const lastRunAgo = lastRunAt
        ? relativeTime(lastRunAt, snapshot.t, snapshot.state.locale)
        : '';
      const metadata = [
        runCount === undefined ? null : snapshot.t('projects.cardRuns', { count: runCount }),
        project.costUsd == null ? null : runCost(project.costUsd),
        snapshot.t('projects.cardCreated', {
          date: projectCreatedDate(project.createdAt, snapshot.state.locale),
        }),
        lastRunAgo ? snapshot.t('projects.cardLastRun', { ago: lastRunAgo }) : null,
      ].filter((value): value is string => value !== null).join(' · ');
      ctx.text(
        pane.content,
        metadata,
        columnX + BUTTON_LABEL_INSET,
        y + PROJECT_METADATA_Y,
        {
          size: 9,
          color: GPU_COLORS.muted,
          width: nameLabelWidth,
          singleLine: true,
        }
      );
    } else {
      ctx.panel(
        pane.content,
        columnX,
        y,
        innerWidth,
        PROJECT_BUTTON_HEIGHT,
        GPU_COLORS.panelRaised,
        GPU_COLORS.border,
        7,
        1
      );
    }
    let infoCursor = infoX;
    if (project.repositoryTarget.visibility === 'private') {
      ctx.privateRepositoryIcon(
        pane.content,
        infoCursor,
        y + 16,
        PRIVATE_REPOSITORY_ICON_SIZE
      );
      infoCursor += privateIconSpace;
    }
    ctx.text(
      pane.content,
      repositoryStatusCopy,
      infoCursor,
      y + PROJECT_INFO_TEXT_Y,
      {
        size: 10,
        color: statusColor(project.repositoryStatus),
        mono: true,
        width: statusWidth,
        singleLine: true,
      }
    );
    infoCursor += statusWidth + PROJECT_INFO_SEPARATOR_BEFORE_GAP;
    ctx.text(
      pane.content,
      PROJECT_INFO_SEPARATOR,
      infoCursor,
      y + PROJECT_INFO_TEXT_Y,
      {
        size: STATUS_FONT_SIZE,
        color: GPU_COLORS.muted,
        mono: true,
        width: separatorWidth,
        singleLine: true,
      }
    );
    infoCursor += separatorWidth + PROJECT_INFO_SEPARATOR_AFTER_GAP;
    if (project.repositoryUrl) {
      const repositoryGroupWidth =
        REPOSITORY_ICON_OFFSET_X +
        REPOSITORY_ICON_SIZE +
        REPOSITORY_ICON_GAP +
        destinationTextWidth;
      const repositoryLink = ctx.linkRegion(
        pane.content,
        `project.repository.${project.projectId}`,
        destinationText,
        infoCursor,
        y + 2,
        repositoryGroupWidth,
        REPOSITORY_ICON_SIZE,
        snapshot.onActivate
      );
      ctx.repositoryIcon(
        repositoryLink,
        REPOSITORY_ICON_OFFSET_X,
        0,
        REPOSITORY_ICON_SIZE
      );
      ctx.text(
        repositoryLink,
        destinationText,
        REPOSITORY_ICON_OFFSET_X + REPOSITORY_ICON_SIZE + REPOSITORY_ICON_GAP,
        14,
        {
          size: 9,
          color: GPU_COLORS.primary,
          width: destinationTextWidth,
          singleLine: true,
        }
      );
    } else {
      ctx.text(
        pane.content,
        destinationText,
        infoCursor,
        y + PROJECT_INFO_TEXT_Y,
        {
          size: 10,
          color: GPU_COLORS.muted,
          width: destinationTextWidth,
          singleLine: true,
        }
      );
    }
    cursor += projectRowHeight(compactRunRows, selected);

    const runs = expandedRunList[index] ?? [];
    if (selected && runs.length > 0) {
      ctx.text(
        pane.content,
        snapshot.t('projects.runsHeading', { count: runs.length }),
        runColumnX,
        cursor,
        { size: 10, color: GPU_COLORS.muted, weight: '600' }
      );
      cursor += RUNS_HEADING_HEIGHT;
      runs.forEach((run, runIndex) => {
        const newest = runIndex === 0;
        const rowHeight = runRowHeight(run, compactRunRows, newest);
        const cardHeight = rowHeight - RUN_ROW_GAP - RUN_RESULT_SPACE;
        const goalWidth = Math.max(0, layout.panelWidth - 52);
        const textX = runColumnX + BUTTON_LABEL_INSET;
        const textWidth = goalWidth - BUTTON_LABEL_INSET * 2;
        const rail = new Graphics();
        const railX = runColumnX - 12;
        rail.moveTo(railX, cursor + (newest ? 16 : -RUN_ROW_GAP));
        rail.lineTo(railX, cursor + (runIndex === runs.length - 1 ? 16 : rowHeight));
        rail.stroke({ color: GPU_COLORS.border, width: 2 });
        rail.circle(railX, cursor + 16, 4).fill(statusColor(run.status));
        pane.content.addChild(rail);
        const statusText = statusLabel(snapshot.t, run.status, 'projects.runStatus');
        const cost = run.costUsd === null ? '' : ' · ' + runCost(run.costUsd);
        const date = relativeTime(run.createdAt, snapshot.t, snapshot.state.locale) || run.createdAt;
        const metrics = [
          run.durationS == null ? '—' : fmtMs(run.durationS * 1000),
          snapshot.t('projects.runTokens', { value: run.tokens?.toLocaleString(snapshot.state.locale) ?? '—' }),
          snapshot.t('projects.runLlmCalls', { value: run.llmCalls?.toLocaleString(snapshot.state.locale) ?? '—' }),
          snapshot.t('projects.runJevCalls', { value: run.jevCalls == null ? '—'
            : (run.jevCallsLowerBound ? '≥ ' : '') + run.jevCalls.toLocaleString(snapshot.state.locale) }),
        ];
        ctx.button(pane.content, 'project.run.' + (run.traceId ?? run.projectRunId), 'button',
          // The short title once the run was named; the bubble keeps the whole goal.
          run.title ?? run.goal.replace(/\s+/g, ' '), runColumnX, cursor, goalWidth, cardHeight,
          false, snapshot.onActivate, GPU_COLORS.primary, false, false, undefined, 9,
          [run.goal, date, statusText + cost, ...metrics].join(' · '));
        ctx.text(pane.content, date, textX, cursor + 32,
          { size: 12, color: GPU_COLORS.muted, width: textWidth, singleLine: true });
        const exact = timestampTooltip(run.createdAt, snapshot.state.locale);
        if (exact) ctx.tooltip(pane.content, { x: textX, y: cursor + 32, width: textWidth, height: 18, text: exact });
        ctx.text(pane.content, statusText + cost, textX, cursor + 54,
          { size: 12, color: statusColor(run.status), width: textWidth, singleLine: true });
        const metricRows = compactRunRows ? [metrics.slice(0, 2), metrics.slice(2, 3), metrics.slice(3)] : [metrics];
        metricRows.forEach((values, metricIndex) => {
          const copy = values.join(' · ');
          const metricY = cursor + 76 + metricIndex * 20;
          ctx.text(pane.content, copy, textX, metricY,
            { size: 12, color: GPU_COLORS.muted, width: textWidth, singleLine: true });
          const tooltip = run.jevCallsLowerBound && (!compactRunRows || metricIndex === metricRows.length - 1)
            ? copy + '\n' + snapshot.t('projects.runJevCallsLowerBound') : copy;
          ctx.tooltip(pane.content, { x: textX, y: metricY, width: textWidth, height: 18, text: tooltip });
        });
        const extraY = cursor + (compactRunRows ? RUN_COMPACT_CARD_HEIGHT : RUN_CARD_HEIGHT);
        if (run.publication?.status === 'published' && run.publication.pullRequestUrl) {
          ctx.text(pane.content, snapshot.t('projects.pullRequest'), textX, extraY,
            { size: 9, color: GPU_COLORS.primary, width: textWidth, singleLine: true });
          ctx.linkRegion(pane.content, 'project.pullRequest.' + run.projectRunId, snapshot.t('projects.pullRequest'),
            textX, extraY - 3, textWidth, 18, snapshot.onActivate);
        } else if (showsPartialGuidance(run, newest)) {
          ctx.text(pane.content, snapshot.t(run.rerunOf ? 'projects.runPartial.rerun'
            : project.repositoryTarget.source ? 'projects.runPartial.imported' : 'projects.runPartial.continue'),
            textX, extraY, { size: 9, color: GPU_COLORS.warning, width: textWidth, singleLine: true });
        } else if (run.error && run.status !== 'partial') {
          ctx.text(pane.content, run.error.replace(/\s+/g, ' '), textX, extraY,
            { size: 9, color: GPU_COLORS.error, width: textWidth, singleLine: true });
        }
        ctx.button(pane.content, `result.open.${run.traceId ?? run.projectRunId}`, 'button', snapshot.t('result.title'),
          runColumnX, cursor + cardHeight + RUN_RESULT_GAP, Math.min(180, goalWidth), RUN_RESULT_HEIGHT, false, snapshot.onActivate);
        cursor += rowHeight;
      });
    } else if (selected && runs.length === 0) {
      ctx.text(
        pane.content,
        snapshot.t('projects.noRuns'),
        runColumnX,
        cursor,
        { size: 10, color: GPU_COLORS.muted }
      );
      cursor += 24;
    }
  });

  pane.extend(layout.contentBottom);
  ctx.scrollMax.projects = pane.finish();
}
