import { Container, Graphics } from 'pixi.js';
import { assayLabel, assayDetailLines } from '../../assayer-presentation.js';
import { formatDateTime } from '../../../client/date-format.js';
import { BUTTON_ICON_SPACE } from '../../button-icons.js';
import {
  assayerStats, assayerStatus, assayVerdictTone, sentinelTabs, sentinelWatchNotes, sentinelWatchStats, sentinelWatchStatus,
  type SentinelStat, type SentinelTab, type SentinelTone,
} from '../../sentinel-presentation.js';
import { drawLoadingNotice } from '../loading-notice.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';
import { drawJournalRow, journalRowHeight, SEVERITY_COLORS } from './journal-row.js';

/**
 * THE SENTINEL SCREEN — five tabs, one question each.
 *
 * The screen used to stack everything in one column of sentences: the watch's
 * timer, then the assayer's health and its whole evaluation list, then the
 * runs in flight, the rules and the findings, every fact a muted line of the
 * same size, every evaluation a sentence over a button (owner, 2026-10-23:
 * "totalement illisible"). Each of those is a different question, asked at a
 * different moment, so each gets a tab: WATCH (is this server watching, and
 * how is the tick doing), ASSAYER (recipe evaluations), IN FLIGHT (what would
 * be screened this second), RULES (what is looked for) and FINDINGS (what has
 * been flagged). A tab's name carries its count, so the strip itself answers
 * "anything to see?" before a click.
 *
 * Inside a tab the hierarchy is a headline (one state word, one sentence), a
 * row of figure tiles, then the list — the same shape Platform uses.
 *
 * WHAT IT MAY CLAIM, unchanged. The server hosts the tick, so it reports ITS
 * OWN timer and only its own: the scope sentence stays on the Watch tab in
 * every state, a stale incumbent renders as an age and a timestamp, and no
 * aggregate "nothing is watching" exists. And no control: a finding is a flag,
 * never a judgment, so every button here is a navigation — a tab, a run, an
 * evaluation to read.
 */

const TAB_HEIGHT = 32;
const TAB_ROW = TAB_HEIGHT + 10;
const TAB_GAP = 10;
const LIST_TOP = 8;
const SECTION_GAP = 16;
const SECTION_HEADING = 26;
const STAT_HEIGHT = 52;
const STAT_GAP = 10;
const COVERAGE_ROW_HEIGHT = 34;
const COVERAGE_ROW_HEIGHT_COMPACT = 56;
const RULE_ROW_HEIGHT = 46;
const RULE_ROW_HEIGHT_COMPACT = 74;
const ASSAY_ROW_HEIGHT = 40;
const ASSAY_ROW_HEIGHT_COMPACT = 60;
const ASSAY_ROW_GAP = 6;
/** Below this content width a finding keeps its three-line journal row; above, one line in columns. */
const FINDINGS_TABLE_MIN_WIDTH = 900;
const FINDING_ROW_HEIGHT = 30;
const FINDING_HEADER_HEIGHT = 24;

const CORPUS_COLORS: Record<string, number> = {
  operator: GPU_COLORS.cyan,
  project: GPU_COLORS.primary,
};

const TONE_COLORS: Record<SentinelTone, number> = {
  ok: GPU_COLORS.success,
  off: GPU_COLORS.muted,
  warning: GPU_COLORS.warning,
  bad: GPU_COLORS.error,
  muted: GPU_COLORS.muted,
};

export interface SentinelTabLayout extends SentinelTab {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** Measured tabs that wrap rather than squeeze, the same way the project sections do. */
export function sentinelSectionLayout(
  ctx: Pick<RendererCtx, 'measureText'>,
  tabs: readonly SentinelTab[],
  width: number
): { tabs: SentinelTabLayout[]; contentTop: number } {
  const frame = viewFrame(width, 0);
  const right = frame.innerX + frame.innerWidth;
  let x = frame.innerX;
  let y = frame.contentTop;
  const laid = tabs.map(tab => {
    const tabWidth = Math.min(frame.innerWidth,
      Math.ceil(ctx.measureText(tab.label, { size: 11, weight: '700' })) + 20 + BUTTON_ICON_SPACE);
    if (x > frame.innerX && x + tabWidth > right) { x = frame.innerX; y += TAB_ROW; }
    const placed = { ...tab, x, y, width: tabWidth };
    x += tabWidth + TAB_GAP;
    return placed;
  });
  return { tabs: laid, contentTop: y + TAB_ROW };
}

export function drawSentinel(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const { t } = snapshot;
  const locale = snapshot.state.locale;
  const payload = snapshot.data.adminSentinel;
  const assay = snapshot.data.assayer;
  const rules = payload?.rules ?? [];
  const live = payload?.live ?? [];
  const skipped = payload?.skipped ?? [];
  const findings = payload?.findings ?? [];
  const section = snapshot.state.sentinelSection;

  const frame = viewFrame(width, height);
  drawViewFrame(
    ctx,
    frame,
    t('sentinel.title'),
    [t('sentinel.rulesCount', { count: rules.length }), t('sentinel.liveRuns', { count: live.length })].join(', ')
  );

  // ---------------------------------------------------------------- tabs
  const layout = sentinelSectionLayout(ctx, sentinelTabs(payload, assay, t), width);
  for (const tab of layout.tabs) {
    ctx.button(ctx.root, `sentinel.section.${tab.id}`, 'tab', tab.label,
      tab.x, tab.y, tab.width, TAB_HEIGHT, section === tab.id, snapshot.onActivate);
  }

  const contentTop = layout.contentTop;
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.sentinel,
    bottomPadding: 24,
    // Raised tabs stand right above the pane, so no shadow may land there.
    air: { top: 0, bottom: VIEW_FRAME_PAD },
  });

  const x = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;
  const compact = innerWidth < 400;

  let cursor = LIST_TOP;

  const heading = (label: string): void => {
    ctx.text(pane.content, label, columnX, cursor, { size: 13, weight: '700', width: innerWidth });
    cursor += SECTION_HEADING;
  };

  const note = (text: string, color: number = GPU_COLORS.muted): void => {
    const drawn = ctx.text(pane.content, text, columnX, cursor, { size: 10, color, width: innerWidth });
    cursor += Math.max(14, drawn.height) + 12;
  };

  /** One state word with its dot, and the sentence that backs it. */
  const headline = (word: string, tone: SentinelTone, sentence: string): void => {
    const color = TONE_COLORS[tone];
    const dot = new Graphics();
    dot.circle(columnX + 5, cursor + 8, 5).fill({ color, alpha: 0.95 });
    dot.circle(columnX + 5, cursor + 8, 8).stroke({ color, width: 1, alpha: 0.35 });
    pane.content.addChild(dot);
    const label = ctx.text(pane.content, word, columnX + 20, cursor, { size: 14, weight: '700', color, width: Math.max(0, innerWidth - 20), singleLine: true });
    cursor += Math.max(20, label.height) + 4;
    const drawn = ctx.text(pane.content, sentence, columnX, cursor, { size: 11, width: innerWidth });
    cursor += Math.max(16, drawn.height) + 14;
  };

  /** Figure tiles in a measured grid: as many per row as 150px columns fit. */
  const stats = (rows: readonly SentinelStat[], prefix: string, accent: number): void => {
    if (rows.length === 0) return;
    const columns = Math.max(1, Math.min(rows.length, Math.floor((innerWidth + STAT_GAP) / (150 + STAT_GAP))));
    const tileWidth = (innerWidth - STAT_GAP * (columns - 1)) / columns;
    for (const [index, stat] of rows.entries()) {
      const tileX = columnX + index % columns * (tileWidth + STAT_GAP);
      const tileY = cursor + Math.floor(index / columns) * (STAT_HEIGHT + STAT_GAP);
      ctx.statCard(pane.content, `${prefix}.${stat.key}`, stat.label, stat.value, tileX, tileY, tileWidth, STAT_HEIGHT, accent);
      ctx.tooltip(pane.content, { x: tileX, y: tileY, width: tileWidth, height: STAT_HEIGHT, text: `${stat.label}: ${stat.value}` });
    }
    cursor += Math.ceil(rows.length / columns) * (STAT_HEIGHT + STAT_GAP) + 8;
  };

  if (section === 'watch') {
    // ------------------------------------------------------- this server
    const watch = payload?.watch ?? null;
    const status = sentinelWatchStatus(watch, t, locale);
    headline(status.headline, status.tone, status.sentence);
    stats(sentinelWatchStats(watch, t, locale), 'sentinel.stat', status.tone === 'ok' ? GPU_COLORS.success : GPU_COLORS.muted);
    // The scope sentence is not optional and not conditional: every state of
    // this panel is one process talking about itself.
    for (const line of sentinelWatchNotes(watch, t, locale)) note(line);
  } else if (section === 'assayer') {
    // ------------------------------------------------- recipe evaluations
    const status = assayerStatus(assay, t, locale);
    headline(status.headline, status.tone, t('assayer.scope'));
    for (const fact of status.facts) note(fact, GPU_COLORS.text);
    stats(assayerStats(assay, t, locale), 'assayer.stat', status.tone === 'ok' ? GPU_COLORS.success : GPU_COLORS.muted);
    heading(t('assayer.attempts'));
    if (!assay) {
      note(t('assayer.unavailable'));
    } else {
      if (assay.error) note(t('assayer.loadFailed'), GPU_COLORS.error);
      if (assay.loading && assay.assays.length === 0) {
        drawLoadingNotice(ctx, pane.content, t('loading.assayer'), columnX, cursor, { width: innerWidth });
        cursor += 42;
      } else if (!assay.error && assay.assays.length === 0) {
        note(t('assayer.empty'));
      }
      const rowHeight = compact ? ASSAY_ROW_HEIGHT_COMPACT : ASSAY_ROW_HEIGHT;
      const dateStyle = { size: 10, color: GPU_COLORS.muted } as const;
      const verdictStyle = { size: 10, weight: '700' } as const;
      // Reserved columns are measured from the copy the rows carry and
      // ceilinged as a share of the card, never a constant.
      const dateWidth = compact ? 0 : Math.min(innerWidth * 0.28, Math.max(0,
        ...assay.assays.map(row => Math.ceil(ctx.measureText(formatDateTime(row.endedAt, locale), dateStyle)))) + 12);
      const verdictLabel = (row: typeof assay.assays[number]) =>
        row.judgement ? t(`assayer.verdict.${row.judgement.verdict}`) : t('assayer.noJudgement');
      const verdictWidth = compact ? 0 : Math.min(innerWidth * 0.22, Math.max(0,
        ...assay.assays.map(row => Math.ceil(ctx.measureText(verdictLabel(row), verdictStyle)))) + 12);
      for (const row of assay.assays) {
        const selected = assay.selected?.summary.id === row.id;
        const rowTop = cursor;
        const tone = assayVerdictTone(row);
        const date = formatDateTime(row.endedAt, locale);
        const statusLabel = t(`assayer.status.${row.status}`);
        // Texts first into a detached layer so the card below can take the
        // measured height of an opened evaluation; hit targets come after
        // the layer is attached, since they project through their parent.
        const body = new Container();
        let inner = rowTop + 10;
        const textX = columnX + 12;
        if (compact) {
          ctx.text(body, date, textX, inner, { ...dateStyle, width: innerWidth - 24, singleLine: true });
          ctx.text(body, row.skillId, textX, inner + 16, { size: 11, weight: '600', width: innerWidth - 24, singleLine: true });
          ctx.text(body, `${statusLabel} · ${verdictLabel(row)}`, textX, inner + 32,
            { ...verdictStyle, color: TONE_COLORS[tone], width: innerWidth - 24, singleLine: true });
        } else {
          ctx.text(body, date, textX, inner + 2, { ...dateStyle, width: dateWidth - 12, singleLine: true });
          const skillX = textX + dateWidth;
          const verdictX = columnX + innerWidth - 12 - verdictWidth;
          const statusWidth = Math.min(140, Math.max(0, (verdictX - skillX) * 0.35));
          ctx.text(body, row.skillId, skillX, inner, { size: 11, weight: '600', width: Math.max(0, verdictX - skillX - statusWidth - 12), singleLine: true });
          ctx.text(body, statusLabel, verdictX - statusWidth, inner + 2,
            { size: 10, color: row.status === 'completed' ? GPU_COLORS.muted : GPU_COLORS.warning, width: statusWidth - 8, singleLine: true });
          ctx.text(body, verdictLabel(row), verdictX, inner + 1, { ...verdictStyle, color: TONE_COLORS[tone], width: verdictWidth, singleLine: true });
        }
        inner = rowTop + rowHeight;
        if (selected) {
          const rule = new Graphics();
          rule.rect(columnX + 12, inner, innerWidth - 24, 1).fill({ color: GPU_COLORS.border, alpha: 0.8 });
          body.addChild(rule);
          inner += 10;
          if (assay.selectedLoading) {
            drawLoadingNotice(ctx, body, t('loading.assayer'), textX, inner, { width: innerWidth - 24 });
            inner += 34;
          }
          for (const line of assayDetailLines(assay, t)) {
            const drawn = ctx.text(body, line, textX, inner, { size: 10, color: GPU_COLORS.muted, width: innerWidth - 24 });
            inner += Math.max(14, drawn.height) + 8;
          }
          inner += 4;
        }
        const cardHeight = inner - rowTop;
        ctx.panel(pane.content, columnX, rowTop, innerWidth, cardHeight,
          selected ? GPU_COLORS.panelRaised : GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 1);
        pane.content.addChild(body);
        // The row IS the control: it opens (or folds) the evaluation's evidence, a read.
        ctx.button(pane.content, `assayer.open.${row.id}`, 'button', '', columnX, rowTop, innerWidth, rowHeight,
          selected, snapshot.onActivate, GPU_COLORS.primary, false, false, undefined, undefined, t('assayer.details')).alpha = 0.001;
        ctx.tooltip(pane.content, { x: columnX, y: rowTop, width: innerWidth, height: rowHeight, text: assayLabel(row, t, locale) });
        cursor = rowTop + cardHeight + ASSAY_ROW_GAP;
      }
      if (assay.hasMore) {
        cursor += 6;
        ctx.button(pane.content, 'assayer.more', 'button', t('assayer.more'),
          columnX, cursor, Math.min(innerWidth, 210), 36, false, snapshot.onActivate, GPU_COLORS.primary, false,
          assay.loading && assay.assays.length > 0);
        cursor += 48;
      }
    }
  } else if (section === 'coverage') {
    // ------------------------------------------------------------- coverage
    heading(t('sentinel.coverage'));
    if (live.length === 0) {
      note(t('sentinel.coverageEmpty'));
    } else {
      const rowHeight = compact ? COVERAGE_ROW_HEIGHT_COMPACT : COVERAGE_ROW_HEIGHT;
      const listHeight = live.length * rowHeight + 12;
      ctx.panel(pane.content, x, cursor, panelWidth, listHeight, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
      let rowY = cursor + 8;
      for (const run of live) {
        if (pane.visible(rowY, rowY + rowHeight)) {
          ctx.text(pane.content, t(`sentinel.corpus.${run.corpus}`).toUpperCase(), columnX + 8, rowY, {
            size: 9, weight: '700', color: CORPUS_COLORS[run.corpus] ?? GPU_COLORS.muted, width: 72,
          });
          ctx.text(pane.content, truncate(run.label ?? run.runId, 48), columnX + 88, rowY, {
            size: 11, width: compact ? Math.max(0, innerWidth - 96) : Math.max(0, innerWidth - 300),
          });
          ctx.text(pane.content, run.runId, compact ? columnX + 8 : columnX + innerWidth - 210, rowY + (compact ? 18 : 1), {
            size: 8, color: GPU_COLORS.muted, mono: true, width: compact ? Math.max(0, innerWidth - 16) : 210,
          });
          // The row IS the control: opening the run is the only action this
          // screen offers, and it is a read.
          ctx.button(pane.content, `sentinel.run.${run.runId}`, 'button', '', columnX, rowY - 4,
            Math.max(0, innerWidth), rowHeight - 4, false, snapshot.onActivate).alpha = 0.001;
        }
        rowY += rowHeight;
      }
      cursor += listHeight + SECTION_GAP;
    }
    if (skipped.length > 0) {
      heading(t('sentinel.skipped'));
      for (const skip of skipped) note(`${skip.runId ?? '—'} · ${skip.reason}`);
      cursor += 4;
    }
  } else if (section === 'rules') {
    // ---------------------------------------------------------- rule table
    heading(t('sentinel.rules'));
    const ruleRowHeight = compact ? RULE_ROW_HEIGHT_COMPACT : RULE_ROW_HEIGHT;
    if (rules.length === 0) {
      note(t('sentinel.rulesEmpty'));
    } else {
      const rulesHeight = rules.length * ruleRowHeight + 12;
      ctx.panel(pane.content, x, cursor, panelWidth, rulesHeight, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
      let ruleY = cursor + 8;
      for (const rule of rules) {
        if (pane.visible(ruleY, ruleY + ruleRowHeight)) {
          ctx.text(pane.content, rule.id, columnX + 8, ruleY, {
            size: 10, weight: '600', mono: true, width: compact ? Math.max(0, innerWidth - 16) : 220,
          });
          ctx.text(pane.content, rule.kind, compact ? columnX + 8 : columnX + innerWidth - 150, ruleY + (compact ? 16 : 0), {
            size: 9, color: SEVERITY_COLORS[rule.kind === 'security.flagged' ? 'security' : 'warning'], mono: true,
            width: compact ? Math.max(0, innerWidth - 16) : 150,
          });
          // A rule with no catalog entry shows nothing rather than its key: the
          // id above it already names the rule.
          const prose = t(`sentinel.rule.${rule.id}`);
          ctx.text(pane.content, prose === `sentinel.rule.${rule.id}` ? '' : prose, columnX + 8, ruleY + (compact ? 32 : 16),
            { size: 10, color: GPU_COLORS.muted, width: Math.max(0, innerWidth - 16) });
        }
        ruleY += ruleRowHeight;
      }
      cursor += rulesHeight + SECTION_GAP;
    }
  } else {
    // ------------------------------------------------------------ findings
    heading(t('sentinel.findings'));
    note(t('sentinel.flagOnly'));
    if (findings.length === 0) {
      note(t('sentinel.findingsEmpty'));
    } else {
      const facts = findings.map(finding => {
        const detail = finding.detail ?? {};
        return {
          finding,
          ruleId: typeof detail['ruleId'] === 'string' ? detail['ruleId'] : '',
          corpus: typeof detail['corpus'] === 'string' ? detail['corpus'] : '',
        };
      });
      // What the flags are about, before the flags: one tile per rule, in
      // the order the catalog lists them, unknown rules last.
      const byRule = new Map<string, number>();
      for (const rule of rules) byRule.set(rule.id, 0);
      for (const fact of facts) byRule.set(fact.ruleId || '—', (byRule.get(fact.ruleId || '—') ?? 0) + 1);
      ctx.text(pane.content, t('sentinel.byRule'), columnX, cursor, { size: 11, weight: '600', color: GPU_COLORS.muted, width: innerWidth });
      cursor += 20;
      stats([...byRule].filter(([, count]) => count > 0).map(([ruleId, count]) => ({
        key: ruleId, label: ruleId, value: count.toLocaleString(locale),
      })), 'sentinel.finding', GPU_COLORS.warning);

      const wide = innerWidth >= FINDINGS_TABLE_MIN_WIDTH;
      const rowHeight = wide ? FINDING_ROW_HEIGHT : journalRowHeight(compact, true);
      const headerHeight = wide ? FINDING_HEADER_HEIGHT : 0;
      const listHeight = findings.length * rowHeight + headerHeight + 12;
      ctx.panel(pane.content, x, cursor, panelWidth, listHeight, GPU_COLORS.panel, GPU_COLORS.border, GPU_LAYOUT.radius, 2);
      let rowY = cursor + 8;
      if (wide) {
        // One line per finding, in columns MEASURED from the copy the rows
        // carry and ceilinged as a share of the card; the summary takes the rest.
        const mono = { size: 10, mono: true } as const;
        const whenStyle = { size: 10, color: GPU_COLORS.muted } as const;
        const measure = (values: string[], style: Parameters<typeof ctx.measureText>[1], cap: number) =>
          Math.min(innerWidth * cap, Math.max(0, ...values.map(value => Math.ceil(ctx.measureText(value, style)))) + 14);
        const whens = facts.map(fact => ctx.relativeTime(fact.finding.at, t, locale));
        const actors = facts.map(fact => fact.finding.actorId ?? fact.finding.actorType);
        const whenWidth = measure(whens, whenStyle, 0.16);
        const ruleWidth = measure(facts.map(fact => fact.ruleId), mono, 0.18);
        const corpusWidth = measure(facts.map(fact => t(`sentinel.corpus.${fact.corpus}`).toUpperCase()), { size: 9, weight: '700' }, 0.1);
        const runWidth = measure(facts.map(fact => fact.finding.runId ?? ''), mono, 0.24);
        const actorWidth = measure(actors, mono, 0.12);
        const columns = {
          when: columnX + 8,
          rule: columnX + 8 + whenWidth,
          corpus: columnX + 8 + whenWidth + ruleWidth,
          run: columnX + 8 + whenWidth + ruleWidth + corpusWidth,
          summary: columnX + 8 + whenWidth + ruleWidth + corpusWidth + runWidth,
          actor: columnX + innerWidth - 8 - actorWidth,
        };
        const summaryWidth = Math.max(0, columns.actor - columns.summary - 14);
        const headerStyle = { size: 9, weight: '600', color: GPU_COLORS.muted, singleLine: true } as const;
        ctx.text(pane.content, t('sentinel.col.when'), columns.when, rowY, { ...headerStyle, width: whenWidth - 14 });
        ctx.text(pane.content, t('sentinel.col.rule'), columns.rule, rowY, { ...headerStyle, width: ruleWidth - 14 });
        ctx.text(pane.content, t('sentinel.col.corpus'), columns.corpus, rowY, { ...headerStyle, width: corpusWidth - 14 });
        ctx.text(pane.content, t('sentinel.col.run'), columns.run, rowY, { ...headerStyle, width: runWidth - 14 });
        ctx.text(pane.content, t('sentinel.col.summary'), columns.summary, rowY, { ...headerStyle, width: summaryWidth });
        ctx.text(pane.content, t('sentinel.col.actor'), columns.actor, rowY, { ...headerStyle, width: actorWidth });
        const divider = new Graphics();
        divider.rect(columnX + 8, rowY + FINDING_HEADER_HEIGHT - 6, innerWidth - 16, 1).fill({ color: GPU_COLORS.border, alpha: 0.8 });
        pane.content.addChild(divider);
        rowY += FINDING_HEADER_HEIGHT;
        for (const [index, fact] of facts.entries()) {
          const { finding } = fact;
          if (pane.visible(rowY, rowY + rowHeight)) {
            const color = SEVERITY_COLORS[finding.severity] ?? GPU_COLORS.muted;
            const textY = rowY + 7;
            ctx.text(pane.content, whens[index] ?? '', columns.when, textY, { ...whenStyle, width: whenWidth - 14, singleLine: true });
            ctx.text(pane.content, fact.ruleId, columns.rule, textY, { ...mono, color, width: ruleWidth - 14, singleLine: true });
            ctx.text(pane.content, t(`sentinel.corpus.${fact.corpus}`).toUpperCase(), columns.corpus, textY + 1, {
              size: 9, weight: '700', color: CORPUS_COLORS[fact.corpus] ?? GPU_COLORS.muted, width: corpusWidth - 14, singleLine: true,
            });
            ctx.text(pane.content, finding.runId ?? '', columns.run, textY, { ...mono, color: GPU_COLORS.muted, width: runWidth - 14, singleLine: true });
            ctx.text(pane.content, finding.summary, columns.summary, textY, { size: 11, width: summaryWidth, singleLine: true });
            ctx.text(pane.content, actors[index] ?? '', columns.actor, textY, { ...mono, color: GPU_COLORS.muted, width: actorWidth, singleLine: true });
            // A one-line row is lossy: the bubble carries the exact instant,
            // the whole summary and the kind the row had no column for.
            ctx.tooltip(pane.content, { x: columnX, y: rowY, width: innerWidth, height: rowHeight,
              text: `${formatDateTime(finding.at, locale, { seconds: true })} · ${finding.kind} · ${finding.severity}\n${finding.summary}` });
            if (finding.runId) {
              ctx.button(pane.content, `sentinel.run.${finding.runId}`, 'button', '', columnX, rowY,
                Math.max(0, innerWidth), rowHeight, false, snapshot.onActivate).alpha = 0.001;
            }
          }
          rowY += rowHeight;
        }
      } else {
        for (const fact of facts) {
          const { finding } = fact;
          if (pane.visible(rowY, rowY + rowHeight)) {
            drawJournalRow(ctx, pane.content, finding, {
              x: columnX, y: rowY, innerWidth, compact,
              relative: { t, locale },
              extra: [fact.ruleId, fact.corpus, finding.runId ?? ''].filter(Boolean).join(' · '),
            });
            if (finding.runId) {
              ctx.button(pane.content, `sentinel.run.${finding.runId}`, 'button', '', columnX, rowY - 4,
                Math.max(0, innerWidth), rowHeight - 4, false, snapshot.onActivate).alpha = 0.001;
            }
          }
          rowY += rowHeight;
        }
      }
      cursor += listHeight + SECTION_GAP;
    }
  }

  pane.extend(cursor + 8);
  ctx.scrollMax.sentinel = pane.finish();
}
