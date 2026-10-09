import { drawWorkspace } from './workspace.js';
import { latestWorkspaceRun } from '../../workspace-browser.js';
import { Graphics, type Container } from 'pixi.js';
import { dateTimeFormat } from '../../../client/date-format.js';
import type { VizProject, VizProjectRun } from '../../../client/types.js';
import { BUTTON_LABEL_INSET } from '../../gpu-renderer.js';
import { BUTTON_ICON_SPACE, CHEVRON_SIZE, CHEVRON_SPACE } from '../../button-icons.js';
import { drawChevron } from '../button-icon.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { fmtMs, runCost } from '../../../client/run-utils.js';
import { relativeTime, timestampTooltip } from '../relative-time.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_CONTENT_TOP, VIEW_FRAME_PAD, VIEW_FRAME_TITLE_SIZE, VIEW_FRAME_TITLE_Y } from '../view-frame.js';
import { drawResultPanel } from './result.js';
import { latestDeliveredResult } from '../../run-result.js';
import { drawPreviewControl } from '../preview-control.js';
import { checkpointActionKey, canControlCheckpoint, pendingGitHubAccess, canContinueGitHubAccess, canRetryPublication } from '../../github-access.js';

/**
 * Projects view: the organisation's projects, their GitHub repository state
 * and their runs with publication receipts. Follows the 2026-08-15 view
 * decomposition: a free function over the exported RendererCtx, one measured
 * layout pass, scroll through the shared masked pane, honest `scrollMax`.
 *
 * The MCP guide is a DOM overlay (`.gpu-project-mcp`). A selected project's
 * tabs precede it; Conversation and Runs use separate panels.
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
const COMPACT_PROJECT_PANEL_WIDTH = 400;
const RUN_CARD_HEIGHT = 100;
const RUN_COMPACT_CARD_HEIGHT = 140;
const RUN_ROW_GAP = 14;
const RUN_RESULT_GAP = 14;
const RUN_RESULT_HEIGHT = 32;
const RUN_RESULT_SPACE = RUN_RESULT_GAP + RUN_RESULT_HEIGHT;
const RUN_SECOND_LINE_EXTRA = 20;
const GITHUB_ACCESS_HEIGHT = 198;
const PUBLICATION_RECOVERY_HEIGHT = 90;
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
const PROJECT_METADATA_Y = 23;

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
 * Must match `.gpu-project-mcp { top }` in styles.css for the collection view.
 */
export const PROJECTS_MCP_GUIDE_TOP =
  GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + VIEW_FRAME_CONTENT_TOP;
const PROJECTS_SECTION_TABS_HEIGHT = 44;
/** Must match `.gpu-project-mcp--selected { top }` in styles.css. */
export const PROJECTS_SELECTED_MCP_GUIDE_TOP = PROJECTS_MCP_GUIDE_TOP + PROJECTS_SECTION_TABS_HEIGHT;
/** The guide has one shape regardless of project selection. */
export const PROJECTS_MCP_GUIDE_HEIGHT = 180;
/** Below this content width the guide gains room for wrapped copy. */
export const PROJECTS_NARROW_CONTENT_WIDTH = 480;
/** Must match the narrow media query in styles.css. */
export const PROJECTS_MCP_GUIDE_NARROW_HEIGHT = 300;

export const PROJECTS_MCP_GUIDE_COLLAPSED_HEIGHT = 48;
/**
 * The guide HOSTING THE ASSISTANT CONVERSATION (owner, 2026-10-09): one card,
 * the conversation first and the external-agent path folded under it, then
 * the project list. Selected projects give Conversation its own tab.
 * Must match `.gpu-project-mcp--assistant { height }` in styles.css.
 * It used to be a second card, which read as the assistant twice.
 */
export const PROJECTS_MCP_GUIDE_ASSISTANT_HEIGHT = 400;
/** Wrapped controls need more room, while still leaving the runs in view. */
export const PROJECTS_MCP_GUIDE_ASSISTANT_NARROW_HEIGHT = 420;
/** An empty conversation needs no reserved history; keep DOM and canvas aligned. */
export const PROJECTS_MCP_GUIDE_ASSISTANT_COMPACT_HEIGHT = 300;
export const PROJECTS_MCP_GUIDE_ASSISTANT_COMPACT_NARROW_HEIGHT = 360;

export function projectsGuideHeight(contentWidth = Number.POSITIVE_INFINITY, collapsed = false, assistant = false, compact = false): number {
  if (collapsed) return PROJECTS_MCP_GUIDE_COLLAPSED_HEIGHT;
  if (assistant && compact) return contentWidth < PROJECTS_NARROW_CONTENT_WIDTH
    ? PROJECTS_MCP_GUIDE_ASSISTANT_COMPACT_NARROW_HEIGHT
    : PROJECTS_MCP_GUIDE_ASSISTANT_COMPACT_HEIGHT;
  if (assistant) return contentWidth < PROJECTS_NARROW_CONTENT_WIDTH
    ? PROJECTS_MCP_GUIDE_ASSISTANT_NARROW_HEIGHT
    : PROJECTS_MCP_GUIDE_ASSISTANT_HEIGHT;
  return contentWidth < PROJECTS_NARROW_CONTENT_WIDTH
    ? PROJECTS_MCP_GUIDE_NARROW_HEIGHT
    : PROJECTS_MCP_GUIDE_HEIGHT;
}

export function projectsGpuContentTop(contentWidth = Number.POSITIVE_INFINITY, selected = false, collapsed = false, assistant = false, compact = false): number {
  return (selected ? PROJECTS_SELECTED_MCP_GUIDE_TOP : PROJECTS_MCP_GUIDE_TOP)
    + projectsGuideHeight(contentWidth, collapsed, assistant, compact) + 16;
}

/**
 * Room the runs heading takes, shared by the measuring and drawing passes —
 * two copies of this number would desynchronise `scrollMax` from the rows.
 */
const RUNS_HEADING_HEIGHT = 30;
const PROJECTS_LIST_BOTTOM_PADDING = 24;

/**
 * Whether a run row says, in plain words, what to do next. Only the NEWEST
 * run of a project, and only when it is incomplete: that is the one the next
 * run continues from, and on an older row "run again" is advice already taken.
 * An incomplete row's `error` is the acceptor's technical prose, so no
 * incomplete row prints it: the Runs view keeps it under its technical-details
 * heading instead.
 */
function showsPartialGuidance(run: VizProjectRun, newest: boolean): boolean {
  return newest && run.status === 'partial' && !['paused', 'recoverable'].includes(run.checkpoint?.state ?? '');
}

function checkpointHeight(run: VizProjectRun): number { return run.checkpoint && run.checkpoint.state !== 'unavailable' ? 82 : 0; }

function runRowHeight(run: VizProjectRun, compact = false, newest = false): number {
  if (pendingGitHubAccess(run)) return (run.traceId ? (compact ? RUN_COMPACT_CARD_HEIGHT : RUN_CARD_HEIGHT) + RUN_RESULT_SPACE : 82) + GITHUB_ACCESS_HEIGHT + RUN_ROW_GAP;
  const hasSecondLine = Boolean(
    run.status === 'queued' || showsPartialGuidance(run, newest) ||
    (run.error && run.status !== 'partial') ||
    (run.publication?.status === 'published' && run.publication.pullRequestUrl)
  );
  return (compact ? RUN_COMPACT_CARD_HEIGHT : RUN_CARD_HEIGHT) + RUN_ROW_GAP + RUN_RESULT_SPACE +
    (run.publication?.status === 'failed' ? PUBLICATION_RECOVERY_HEIGHT : 0) +
    (hasSecondLine ? RUN_SECOND_LINE_EXTRA : 0) + checkpointHeight(run);
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
 * Where the project stands on the public showcase, for the people who decide
 * it (organisation owners and admins, platform admins) and nobody else: a
 * member cannot change it, and the list is theirs to read, not to audit.
 * Nothing on a server that does not say.
 */
function showcaseLabel(snapshot: GpuRenderSnapshot, project: { showcase?: 'listed' | 'hidden'; showcaseShown?: boolean }): string | null {
  const viewer = snapshot.data.auth?.viewer;
  if (!viewer || project.showcase === undefined) return null;
  if (!viewer.platformAdmin && viewer.role !== 'org:owner' && viewer.role !== 'org:admin') return null;
  if (project.showcase === 'hidden') return snapshot.t('projects.showcaseHidden');
  return snapshot.t(project.showcaseShown ? 'projects.showcaseShown' : 'projects.showcaseEligible');
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
 * list shows THAT project and nothing else, so the MCP guide below the Runs
 * tab names the project for the connected agent. Its name moves to the page
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
    return 0;
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

/** One height for the GPU card and its DOM contents, in scene coordinates. */
export function projectsGuideLayoutHeight(snapshot: GpuRenderSnapshot, width: number, height: number,
  guideTop = snapshot.state.selectedProjectId ? PROJECTS_SELECTED_MCP_GUIDE_TOP : PROJECTS_MCP_GUIDE_TOP): number {
  const frame = viewFrame(width, height);
  const projects = snapshot.data.projects ?? [];
  const selectedIndex = projects.findIndex(project => project.projectId === snapshot.state.selectedProjectId);
  const selected = selectedIndex >= 0;
  const assistant = Boolean(snapshot.data.auth?.viewer.activeOrganisation) && snapshot.data.auth?.viewer.role !== 'org:viewer';
  const collapsed = !selected && snapshot.state.projectMcpCollapsed;
  const base = projectsGuideHeight(frame.innerWidth, collapsed, assistant, snapshot.state.projectAssistantCompact);
  if (assistant && !collapsed && snapshot.state.projectAssistantCompact &&
    snapshot.state.projectAssistantCompactHeight !== null) {
    return Math.max(PROJECTS_MCP_GUIDE_COLLAPSED_HEIGHT, snapshot.state.projectAssistantCompactHeight);
  }
  if (!assistant || collapsed || snapshot.state.projectAssistantCompact) return base;
  const available = Math.max(0, frame.bottom - VIEW_FRAME_PAD - guideTop);
  if (selected) return available;
  const runs = selected ? snapshot.data.projectRuns?.[projects[selectedIndex]!.projectId] ?? [] : [];
  const listHeight = projectLayout(width, projects.length, selectedIndex, runs).contentBottom + PROJECTS_LIST_BOTTOM_PADDING;
  // Short lists keep only the space they use. Longer lists retain a visible
  // band below the conversation and scroll independently.
  const reserved = Math.min(listHeight, Math.max(180, available * 0.35));
  return Math.max(base, available - 16 - reserved);
}

/** Measured tabs wrap rather than squeezing their labels into unreadable slivers. */
export function projectSectionLayout(ctx: Pick<RendererCtx, 'measureText'>, snapshot: GpuRenderSnapshot, width: number) {
  const frame = viewFrame(width, 0);
  const narrow = frame.innerWidth < PROJECTS_NARROW_CONTENT_WIDTH;
  const sections = [
    { id: 'conversation', label: snapshot.t('projects.mcpTitle') },
    { id: 'runs', label: snapshot.t('nav.runs') },
    { id: 'preview', label: snapshot.t(narrow ? 'preview.title' : 'preview.app') },
    { id: 'files', label: snapshot.t('workspace.title') },
    { id: 'result', label: snapshot.t(narrow ? 'result.title' : 'result.latest') },
  ] as const;
  const right = frame.innerX + frame.innerWidth;
  let x = frame.innerX;
  let y = frame.contentTop;
  const tabs = sections.map(section => {
    const tabWidth = Math.min(frame.innerWidth,
      Math.ceil(ctx.measureText(section.label, { size: 11, weight: '700' })) + 20 + BUTTON_ICON_SPACE);
    if (x > frame.innerX && x + tabWidth > right) { x = frame.innerX; y += PROJECTS_SECTION_TABS_HEIGHT; }
    const tab = { ...section, x, y, width: tabWidth };
    x += tabWidth + 10;
    return tab;
  });
  if (right - x < Math.min(240, frame.innerWidth)) { x = frame.innerX; y += PROJECTS_SECTION_TABS_HEIGHT; }
  return { tabs, repository: { x, y, width: right - x }, contentTop: y + PROJECTS_SECTION_TABS_HEIGHT };
}

/** Shared metadata for the project header and project collection rows. */
function repositoryInfo(ctx: RendererCtx, snapshot: GpuRenderSnapshot, project: VizProject, infoMaxWidth: number) {
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
  const destinationTextWidth = Math.max(
    0,
    Math.min(destinationTextNaturalWidth, infoMaxWidth - fixedInfoWidth)
  );
  const infoWidth = fixedInfoWidth + destinationTextWidth;
  return { repositoryStatusCopy, privateIconSpace, statusWidth, separatorWidth,
    destinationText, destinationTextWidth, infoWidth };
}

function drawRepositoryInfo(ctx: RendererCtx, snapshot: GpuRenderSnapshot, project: VizProject,
  rowParent: Container, infoX: number, y: number, info: ReturnType<typeof repositoryInfo>): void {
  const { repositoryStatusCopy, privateIconSpace, statusWidth, separatorWidth, destinationText, destinationTextWidth } = info;
  let infoCursor = infoX;
  if (project.repositoryTarget.visibility === 'private') {
    ctx.privateRepositoryIcon(
      rowParent,
      infoCursor,
      y + 16,
      PRIVATE_REPOSITORY_ICON_SIZE
    );
    infoCursor += privateIconSpace;
  }
  ctx.text(
    rowParent,
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
    rowParent,
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
      rowParent,
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
      rowParent,
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
  drawViewFrame(ctx, frame, selectedProject ? '' : snapshot.t('nav.projects'),
    selectedProject ? undefined : `${snapshot.t('projects.summary', { count: projects.length })} · ${snapshot.t('projects.activityOrder')}`);
  if (selectedProject) {
    const titleY = frame.y + VIEW_FRAME_TITLE_Y;
    const linkStyle = { size: VIEW_FRAME_TITLE_SIZE, weight: '700', color: GPU_COLORS.primary } as const;
    const titleStyle = { size: VIEW_FRAME_TITLE_SIZE, weight: '700' } as const;
    const allProjects = snapshot.t('projects.all');
    const linkLabel = ctx.fitText(allProjects, Math.max(0, frame.innerWidth * 0.4), linkStyle);
    const linkWidth = ctx.measureText(linkLabel, linkStyle);
    const separatorWidth = CHEVRON_SPACE;
    const linkText = ctx.text(ctx.root, linkLabel, frame.innerX, titleY, { ...linkStyle, singleLine: true });
    ctx.linkRegion(ctx.root, 'project.all', allProjects, frame.innerX, titleY - 4,
      linkWidth, 28, snapshot.onActivate);
    drawChevron(ctx.root, frame.innerX + linkWidth + (separatorWidth - CHEVRON_SIZE) / 2,
      titleY + (linkText.height - CHEVRON_SIZE) / 2, GPU_COLORS.text, 'right');
    const nameX = frame.innerX + linkWidth + separatorWidth;
    const name = ctx.fitText(selectedProject.name,
      Math.max(0, frame.innerX + frame.innerWidth - nameX), titleStyle);
    ctx.text(ctx.root, name, nameX, titleY, { ...titleStyle, singleLine: true });

  }

  const sectionLayout = selectedProject ? projectSectionLayout(ctx, snapshot, width) : null;
  const guideVisible = snapshot.data.auth !== null && (!selectedProject || snapshot.state.projectSection === 'conversation');
  const guideTop = sectionLayout?.contentTop ?? PROJECTS_MCP_GUIDE_TOP;
  const guideHeight = projectsGuideLayoutHeight(snapshot, width, height, guideTop);
  // The form's fields are DOM, but its CARD is the same GPU panel as the list
  // below. A CSS imitation could share dimensions and still disagree on the
  // pointer-driven shadow, which is exactly what made the two adjacent cards
  // read at different depths. The DOM wrapper is transparent and supplies
  // interaction only; this panel owns material, border, radius and elevation.
  if (guideVisible) {
    ctx.panel(
      ctx.root,
      frame.innerX,
      guideTop,
      frame.innerWidth,
      guideHeight,
      GPU_COLORS.panel,
      GPU_COLORS.border,
      GPU_LAYOUT.radius,
      2
    );
  }

  // Reserve the guide's band only on the screen where its DOM contents render.
  let contentTop = selectedProject ? frame.contentTop
    : guideVisible ? guideTop + guideHeight + 16 : frame.contentTop;
  const resultRows = selectedProject ? runsByProject[selectedProject.projectId] ?? [] : [];
  const latestWorkspace = latestWorkspaceRun(resultRows);
  const latestResult = latestDeliveredResult(resultRows);
  if (selectedProject && sectionLayout) {
    for (const section of sectionLayout.tabs) {
      ctx.button(ctx.root, `project.section.${section.id}`, 'tab', section.label,
        section.x, section.y, section.width, 32, snapshot.state.projectSection === section.id,
        snapshot.onActivate);
    }
    // Project identity belongs to the shared header, before any section returns.
    drawRepositoryInfo(ctx, snapshot, selectedProject, ctx.root,
      sectionLayout.repository.x + BUTTON_LABEL_INSET, sectionLayout.repository.y - 5,
      repositoryInfo(ctx, snapshot, selectedProject,
        Math.max(0, sectionLayout.repository.width - BUTTON_LABEL_INSET * 2)));
    contentTop = sectionLayout.contentTop;
    if (snapshot.state.projectSection === 'conversation') {
      ctx.scrollMax.projects = 0;
      return;
    }
    if (snapshot.state.projectSection === 'preview') {
      const controlHeight = latestResult ? drawPreviewControl(ctx, snapshot, frame.innerX, contentTop, frame.innerWidth) : 0;
      if (!controlHeight) ctx.text(ctx.root, snapshot.t(latestResult ? 'preview.unavailable' : 'projects.section.noDeliveredResult'),
        frame.innerX, contentTop, { size: 13, color: GPU_COLORS.muted, width: frame.innerWidth });
      ctx.scrollMax.projects = 0;
      return;
    }
    if (snapshot.state.projectSection === 'files') {
      if (latestWorkspace && snapshot.state.workspaceRunId) {
        drawWorkspace(ctx, snapshot, width, height, {
          x: frame.innerX, top: contentTop, width: frame.innerWidth, bottom: frame.bottom,
        });
      } else {
        ctx.text(ctx.root, snapshot.t('projects.section.noFiles'), frame.innerX, contentTop,
          { size: 13, color: GPU_COLORS.muted, width: frame.innerWidth });
        ctx.scrollMax.projects = 0;
      }
      return;
    }
    if (snapshot.state.projectSection === 'result') {
      if (latestResult && snapshot.state.resultRunId === latestResult.traceId) {
        drawResultPanel(ctx, snapshot, frame.innerX, contentTop, frame.innerWidth,
          Math.max(100, frame.bottom - contentTop - VIEW_FRAME_PAD), false);
      } else {
        ctx.text(ctx.root, snapshot.t('projects.section.noDeliveredResult'), frame.innerX, contentTop,
          { size: 13, color: GPU_COLORS.muted, width: frame.innerWidth });
        ctx.scrollMax.projects = 0;
      }
      return;
    }
  }
  if (snapshot.state.resultRunId && resultRows.some(run => (run.traceId ?? run.projectRunId) === snapshot.state.resultRunId)) {
    drawResultPanel(ctx, snapshot, frame.innerX, contentTop, frame.innerWidth,
      Math.max(100, frame.bottom - contentTop - VIEW_FRAME_PAD));
    ctx.scrollMax.projects = 0;
    return;
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
    bottomPadding: PROJECTS_LIST_BOTTOM_PADDING,
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
    const selected = project.projectId === snapshot.state.selectedProjectId;
    const y = selected ? frame.contentTop - 5 : cursor;
    const rowParent = selected ? ctx.root : pane.content;
    const rowColumnX = selected ? sectionLayout!.repository.x : columnX;
    const rowWidth = selected ? Math.max(0, frame.innerX + frame.innerWidth - rowColumnX) : innerWidth;
    const rowLabel = project.name.replace(/\s+/g, ' ');
    // On a list row the project name keeps a useful left-hand column. In
    // detail the repository sequence uses the space after the section tabs.
    const nameReserve = selected
      ? 0
      : Math.min(280, Math.max(140, innerWidth * 0.22));
    const infoMaxWidth = Math.max(
      0,
      rowWidth - BUTTON_LABEL_INSET * 2 - nameReserve
    );
    const info = repositoryInfo(ctx, snapshot, project, infoMaxWidth);
    const { infoWidth } = info;
    const infoX = selected
      ? rowColumnX + BUTTON_LABEL_INSET
      : rowColumnX + innerWidth - PROJECTS_ROW_PAD - infoWidth;
    const nameLabelWidth = Math.max(
      0,
      infoX - rowColumnX - BUTTON_LABEL_INSET * 2 - PROJECT_INFO_GAP
    );

    if (!selected) {
      ctx.button(
        rowParent,
        `project.select.${project.projectId}`,
        'button',
        rowLabel,
        rowColumnX,
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
        // First, so a narrow card truncates the dates rather than this.
        showcaseLabel(snapshot, project),
        runCount === undefined ? null : snapshot.t('projects.cardRuns', { count: runCount }),
        project.costUsd == null ? null : runCost(project.costUsd),
        snapshot.t('projects.cardCreated', {
          date: projectCreatedDate(project.createdAt, snapshot.state.locale),
        }),
        lastRunAgo ? snapshot.t('projects.cardLastRun', { ago: lastRunAgo }) : null,
      ].filter((value): value is string => value !== null).join(' · ');
      ctx.text(
        rowParent,
        metadata,
        rowColumnX + BUTTON_LABEL_INSET,
        y + PROJECT_METADATA_Y,
        {
          size: 9,
          color: GPU_COLORS.muted,
          width: nameLabelWidth,
          singleLine: true,
        }
      );
      const exactLastRun = lastRunAt ? timestampTooltip(lastRunAt, snapshot.state.locale) : null;
      if (exactLastRun && nameLabelWidth > 0) {
        ctx.tooltip(rowParent, {
          x: rowColumnX + BUTTON_LABEL_INSET,
          y: y + PROJECT_METADATA_Y,
          width: nameLabelWidth,
          height: 16,
          text: exactLastRun,
        });
      }
    }
    if (!selected) drawRepositoryInfo(ctx, snapshot, project, rowParent, infoX, y, info);
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
        const access = pendingGitHubAccess(run);
        const cardHeight = rowHeight - checkpointHeight(run) - RUN_ROW_GAP - (access && !run.traceId ? 0 : RUN_RESULT_SPACE) -
          (access ? GITHUB_ACCESS_HEIGHT : run.publication?.status === 'failed' ? PUBLICATION_RECOVERY_HEIGHT : 0);
        const goalWidth = Math.max(0, layout.panelWidth - 52);
        const textX = runColumnX + BUTTON_LABEL_INSET;
        const textWidth = goalWidth - BUTTON_LABEL_INSET * 2;
        const rail = new Graphics();
        const railX = runColumnX - 12;
        rail.moveTo(railX, cursor + (newest ? 16 : -RUN_ROW_GAP));
        rail.lineTo(railX, cursor + (runIndex === runs.length - 1 ? 16 : rowHeight));
        rail.stroke({ color: GPU_COLORS.border, width: 2 });
        rail.circle(railX, cursor + 16, 4).fill(access ? GPU_COLORS.warning : statusColor(run.status));
        pane.content.addChild(rail);
        const statusText = run.checkpoint?.state === 'paused' ? snapshot.t('projects.checkpoint.paused') : access ? snapshot.t('projects.githubAccess.title')
          : run.githubAccess?.resumedRunId ? snapshot.t('projects.githubAccess.resumed')
          : run.awaitingClientAcceptance ? snapshot.t('projects.awaitingClientAcceptance')
          : statusLabel(snapshot.t, run.status, 'projects.runStatus');
        const cost = run.costUsd === null ? '' : ' · ' + runCost(run.costUsd);
        const date = relativeTime(run.createdAt, snapshot.t, snapshot.state.locale) || run.createdAt;
        const metrics = [
          run.durationS == null ? '—' : fmtMs(run.durationS * 1000),
          snapshot.t('projects.runTokens', { value: run.tokens?.toLocaleString(snapshot.state.locale) ?? '—' }),
          snapshot.t('projects.runLlmCalls', { value: run.llmCalls?.toLocaleString(snapshot.state.locale) ?? '—' }),
          snapshot.t('projects.runJevCalls', { value: run.jevCalls == null ? '—'
            : (run.jevCallsLowerBound ? '≥ ' : '') + run.jevCalls.toLocaleString(snapshot.state.locale) }),
        ];
        const runTitle = run.title ?? run.goal.replace(/\s+/g, ' ');
        if (run.traceId) {
          ctx.button(pane.content, 'project.run.' + run.traceId, 'button',
            // The short title once the run was named; the bubble keeps the whole goal.
            runTitle, runColumnX, cursor, goalWidth, cardHeight,
            false, snapshot.onActivate, GPU_COLORS.primary, false, false, undefined, 9,
            [run.goal, date, statusText + cost, ...metrics].join(' · '));
        } else {
          // A run that failed during preparation has no trace for /api/runs/:id.
          // Keep its status and error here without offering a link that 404s.
          ctx.text(pane.content, runTitle, runColumnX, cursor + 9,
            { size: 13, color: GPU_COLORS.text, width: goalWidth, singleLine: true });
          ctx.tooltip(pane.content, { x: runColumnX, y: cursor, width: goalWidth,
            height: cardHeight, text: [run.goal, run.error, statusText].filter(Boolean).join(' · ') });
        }
        ctx.text(pane.content, date, textX, cursor + 32,
          { size: 12, color: GPU_COLORS.muted, width: textWidth, singleLine: true });
        const exact = timestampTooltip(run.createdAt, snapshot.state.locale);
        if (exact) ctx.tooltip(pane.content, { x: textX, y: cursor + 32, width: textWidth, height: 18, text: exact });
        ctx.text(pane.content, statusText + cost, textX, cursor + 54,
          { size: 12, color: access ? GPU_COLORS.warning : statusColor(run.status), width: textWidth, singleLine: true });
        const metricRows = compactRunRows ? [metrics.slice(0, 2), metrics.slice(2, 3), metrics.slice(3)] : [metrics];
        (access?.phase === 'run' ? [] : metricRows).forEach((values, metricIndex) => {
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
        } else if (run.status === 'queued') {
          const waiting = snapshot.t('projects.runWaiting');
          ctx.text(pane.content, waiting, textX, extraY,
            { size: 11, color: GPU_COLORS.muted, width: textWidth, singleLine: true });
          ctx.tooltip(pane.content, { x: textX, y: extraY, width: textWidth, height: 20, text: waiting });
        } else if (showsPartialGuidance(run, newest)) {
          ctx.text(pane.content, snapshot.t(run.rerunOf ? 'projects.runPartial.rerun'
            : project.repositoryTarget.source ? 'projects.runPartial.imported' : 'projects.runPartial.continue'),
            textX, extraY, { size: 9, color: GPU_COLORS.warning, width: textWidth, singleLine: true });
        } else if (run.error && run.status !== 'partial' && !run.githubAccess) {
          ctx.text(pane.content, run.error.replace(/\s+/g, ' '), textX, extraY,
            { size: 9, color: GPU_COLORS.error, width: textWidth, singleLine: true });
        }
        if (run.traceId) {
          ctx.button(pane.content, `result.open.${run.traceId}`, 'button', snapshot.t('result.title'),
            runColumnX, cursor + cardHeight + RUN_RESULT_GAP, Math.min(180, goalWidth), RUN_RESULT_HEIGHT, false, snapshot.onActivate);
        }
        if (!access && run.publication?.status === 'failed') {
          const retryY = cursor + rowHeight - PUBLICATION_RECOVERY_HEIGHT - RUN_ROW_GAP;
          const progress = snapshot.data.githubRecovery?.runId === run.projectRunId ? snapshot.data.githubRecovery : null;
          const busy = progress?.busy;
          ctx.text(pane.content, snapshot.t('projects.githubAccess.savedResult'), textX, retryY,
            { size: 11, color: GPU_COLORS.warning, width: textWidth, singleLine: true });
          ctx.button(pane.content, `project.githubRetry.${run.projectRunId}`, 'button', snapshot.t(busy ? 'projects.githubAccess.checking' : 'projects.githubAccess.retryPublication'),
            runColumnX, retryY + 22, goalWidth, 40, false, snapshot.onActivate, GPU_COLORS.primary,
            false, !!busy, undefined, undefined, undefined, !!busy || !canRetryPublication(run, snapshot.data.auth));
          if (progress?.message) {
            ctx.text(pane.content, progress.message, textX, retryY + 66, { size: 10, color: GPU_COLORS.warning, width: textWidth, singleLine: true });
            ctx.tooltip(pane.content, { x: textX, y: retryY + 66, width: textWidth, height: 18, text: progress.message });
          }
        }
        if (access) {
          const actionY = cursor + rowHeight - GITHUB_ACCESS_HEIGHT - RUN_ROW_GAP;
          const progress = snapshot.data.githubRecovery?.runId === run.projectRunId ? snapshot.data.githubRecovery : null;
          const canContinue = canContinueGitHubAccess(run, snapshot.data.auth);
          const copy = snapshot.t(access.phase === 'run' ? 'projects.githubAccess.savedRequest' : 'projects.githubAccess.savedResult');
          ctx.text(pane.content, copy, textX, actionY,
            { size: 11, color: GPU_COLORS.muted, width: textWidth, singleLine: true });
          ctx.tooltip(pane.content, { x: textX, y: actionY, width: textWidth, height: 18, text: copy });
          ctx.text(pane.content, access.fullName, textX, actionY + 22,
            { size: 11, color: GPU_COLORS.text, width: textWidth, singleLine: true });
          ctx.tooltip(pane.content, { x: textX, y: actionY + 22, width: textWidth, height: 18,
            text: snapshot.t('projects.githubAccess.instructions', { repository: access.fullName }) });
          ctx.text(pane.content, snapshot.t('projects.githubAccess.selection'), textX, actionY + 42,
            { size: 11, color: GPU_COLORS.muted, width: textWidth, singleLine: true });
          ctx.button(pane.content, `project.githubAuthorize.${run.projectRunId}`, 'button', snapshot.t('projects.githubAccess.authorize'),
            runColumnX, actionY + 66, goalWidth, 40, false, snapshot.onActivate);
          ctx.button(pane.content, `project.githubContinue.${run.projectRunId}`, 'button',
            snapshot.t(progress?.busy ? 'projects.githubAccess.checking' : access.phase === 'run' ? 'projects.githubAccess.continue' : 'projects.githubAccess.publish'),
            runColumnX, actionY + 114, goalWidth, 40, false, snapshot.onActivate, GPU_COLORS.primary,
            false, !!progress?.busy, undefined, undefined, undefined, !!progress?.busy || !canContinue);
          const notice = progress?.message ?? (!canContinue ? snapshot.t('projects.githubAccess.requesterOnly') : '');
          if (notice) {
            ctx.text(pane.content, notice, textX, actionY + 164, { size: 10, color: GPU_COLORS.warning, width: textWidth, singleLine: true });
            ctx.tooltip(pane.content, { x: textX, y: actionY + 164, width: textWidth, height: 18, text: notice });
          }
        }
        if (checkpointHeight(run)) {
          const y = cursor + rowHeight - checkpointHeight(run) - RUN_ROW_GAP;
          const progress = snapshot.data.githubRecovery?.runId === run.projectRunId ? snapshot.data.githubRecovery : null;
          const key = checkpointActionKey(run);
          ctx.text(pane.content, snapshot.t('projects.checkpoint.progress', { completed: run.checkpoint!.completed, total: run.checkpoint!.total }),
            textX, y, { size: 10, color: GPU_COLORS.muted });
          ctx.button(pane.content, `project.checkpoint.${run.projectRunId}`, 'button', snapshot.t(key),
            runColumnX, y + 20, Math.min(260, goalWidth), 28,
            false, snapshot.onActivate, GPU_COLORS.primary, false, !!progress?.busy, undefined, undefined, undefined,
            !canControlCheckpoint(run, snapshot.data.auth) || !!progress?.busy);
          const message = progress?.message ?? (run.checkpoint?.reason ? snapshot.t(`projects.checkpoint.reason.${run.checkpoint.reason}`) : null);
          if (message) ctx.text(pane.content, message, textX, y + 54,
            { size: 10, color: GPU_COLORS.warning, width: textWidth, singleLine: true });
        }
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
