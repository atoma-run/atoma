import type { VizLedgerEvent } from '../../../client/types.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS, GPU_LAYOUT } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';
import { drawViewFrame, viewFrame, VIEW_FRAME_PAD } from '../view-frame.js';
import { relativeTime, timestampTooltip } from '../relative-time.js';

/**
 * THE CATALOGUE LEDGER's tail — a SEPARATE record from the platform journal,
 * and deliberately never merged with it.
 *
 * The two answer different questions: the journal records what happened on the
 * DEPLOYMENT (who logged in, which organisation appeared), while
 * `lifecycle_events` records what the CATALOGUE learned — trust counters,
 * promotions, demotions. They also have different consumers: this one keeps
 * its own integrity checker (`ledger check`), which a merge would break.
 *
 * They used to share one tab, which read as one record with two headings.
 * Separate screens make the separation the interface states.
 *
 * A row is TWO LINES. It was one — stamp, kind, and the raw entity cut at 48
 * characters — which for a skill spent the whole budget on the owner's atom
 * id and left the recipe name as an ellipsis, while the detail and scope the
 * payload already carried (who credited it, which version, why, which run)
 * were never drawn (owner report, 2026-09-27). The subject now takes every
 * pixel the row has left, and the facts line says what the event meant.
 */

const LIST_TOP = 8;
/** Two lines: when, what and whom; then the facts the row carries. */
const ROW_HEIGHT = 36;
/** Compact splits the first line in two. */
const ROW_HEIGHT_COMPACT = 52;
const STAMP_WIDTH = 118;
const KIND_WIDTH = 170;
/** Characters of a run, project or actor id shown before the bubble carries the rest. */
const SHORT_ID = 8;

type Translate = GpuRenderSnapshot['t'];

/**
 * Kind → colour, by what the event did to trust. Read with a FALLBACK: the
 * server's vocabulary can be newer than this bundle, and an unknown kind
 * keeps its raw label in the neutral colour rather than hiding its row.
 */
const KIND_COLORS: Record<string, number> = {
  'type-success': GPU_COLORS.success,
  'skill-success': GPU_COLORS.success,
  promote: GPU_COLORS.success,
  'skill-save': GPU_COLORS.primary,
  'type-failure': GPU_COLORS.error,
  'skill-failure': GPU_COLORS.error,
  'direct-failure': GPU_COLORS.error,
  demote: GPU_COLORS.warning,
  'promotion-refused': GPU_COLORS.warning,
  'type-trust-reset': GPU_COLORS.warning,
  'counters-reset': GPU_COLORS.warning,
  'type-counter-compensation': GPU_COLORS.warning,
  'skill-counter-compensation': GPU_COLORS.warning,
  'skill-drop': GPU_COLORS.magenta,
  'skill-merge': GPU_COLORS.magenta,
  'type-merge': GPU_COLORS.magenta,
};

/**
 * WHAT the row is about, readable. A skill's namespace is its owner's atom
 * id, which the server resolves to the molecule's name, so
 * `4c1e…/build-responsive` reads `Water · build-responsive`. An entity the
 * server could not resolve shows raw.
 */
export function ledgerSubject(entry: VizLedgerEvent): string {
  if (!entry.owner) return entry.entity;
  const slash = entry.entity.indexOf('/');
  return slash > 0 ? `${entry.owner} · ${entry.entity.slice(slash + 1)}` : entry.owner;
}

function factValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    const items = value.map(factValue).filter((item): item is string => item !== null);
    return items.length > 0 ? items.join(', ') : null;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return truncate(JSON.stringify(value) ?? '', 60) || null;
}

function shortId(id: string): string {
  return id.length > SHORT_ID + 1 ? `${id.slice(0, SHORT_ID)}…` : id;
}

/**
 * The facts line: who credited or blamed it, which version, why, through
 * which run. Known detail keys read as phrases; an UNKNOWN key from a newer
 * writer shows as `key: value` rather than vanishing — the tolerance kinds
 * get too.
 */
export function ledgerFacts(entry: VizLedgerEvent, t: Translate): string[] {
  const facts: string[] = [];
  for (const [key, raw] of Object.entries(entry.detail ?? {})) {
    if (key === 'created' || key === 'namespace') {
      if (raw === true) facts.push(t(`admin.ledgerFact.${key}`));
      continue;
    }
    const value = factValue(raw);
    if (value === null) continue;
    switch (key) {
      case 'by':
        facts.push(
          t(
            entry.kind === 'type-success'
              ? 'admin.ledgerFact.creditedBy'
              : entry.kind === 'type-failure'
                ? 'admin.ledgerFact.blamedBy'
                : 'admin.ledgerFact.by',
            { value }
          )
        );
        break;
      case 'via':
        // A recipe run in its own namespace says nothing the subject does not.
        if (value !== entry.owner) facts.push(t('admin.ledgerFact.via', { value }));
        break;
      case 'reason':
      case 'streak':
      case 'mechanism':
      case 'language':
      case 'absorbed':
        facts.push(t(`admin.ledgerFact.${key}`, { value }));
        break;
      case 'expectedVersion':
        facts.push(t('admin.ledgerFact.version', { value }));
        break;
      case 'kind':
        facts.push(t('admin.ledgerFact.recipe', { value }));
        break;
      case 'generation':
      case 'compiledGeneration':
        facts.push(t('admin.ledgerFact.generation', { value }));
        break;
      case 'successes':
      case 'failures':
        facts.push(
          t(`admin.ledgerFact.${key}`, {
            value: typeof raw === 'number' && raw > 0 ? `+${raw}` : value,
          })
        );
        break;
      default:
        facts.push(`${key}: ${truncate(value, 60)}`);
    }
  }
  const scope = entry.scope;
  if (scope?.runId) facts.push(t('admin.ledgerFact.run', { value: shortId(scope.runId) }));
  if (scope?.projectId) facts.push(t('admin.ledgerFact.project', { value: shortId(scope.projectId) }));
  if (scope?.actorType) {
    facts.push(
      scope.actorId
        ? t('admin.ledgerFact.actor', { type: scope.actorType, id: shortId(scope.actorId) })
        : scope.actorType
    );
  }
  return facts;
}

/** Everything the row abbreviates, in full, for the subject's hover bubble. */
function ledgerBubble(entry: VizLedgerEvent): string {
  const lines = [entry.entity];
  if (entry.entityId && entry.entityId !== entry.entity) lines.push(entry.entityId);
  const scope = entry.scope;
  if (scope?.runId) lines.push(`run ${scope.runId}`);
  if (scope?.projectId) lines.push(`project ${scope.projectId}`);
  if (scope?.orgId) lines.push(`org ${scope.orgId}`);
  if (scope?.actorId) lines.push(`${scope.actorType ?? 'actor'} ${scope.actorId}`);
  return lines.join('\n');
}

export function drawLedger(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  width: number,
  height: number
): void {
  const ledger = snapshot.data.adminLedger ?? [];
  const frame = viewFrame(width, height);
  drawViewFrame(
    ctx,
    frame,
    snapshot.t('admin.ledger'),
    snapshot.t('admin.ledgerSummary', { count: ledger.length })
  );

  const contentTop = frame.contentTop;
  const pane = createScrollPane(ctx.root, {
    x: frame.x,
    y: contentTop,
    width: frame.width,
    height: Math.max(0, frame.bottom - VIEW_FRAME_PAD - contentTop),
    scrollY: snapshot.state.scrollY.ledger,
    bottomPadding: 24,
  });

  const x = VIEW_FRAME_PAD;
  const panelWidth = frame.innerWidth;
  const columnX = x + 18;
  const innerWidth = panelWidth - 36;
  const compact = innerWidth < 400;
  const rowHeight = compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;

  let cursor = LIST_TOP;
  // Measured, not assumed: the hint wraps on a narrow column, and a fixed
  // advance would lay the list over its second line.
  const hint = ctx.text(pane.content, snapshot.t('admin.ledgerHint'), columnX, cursor, {
    size: 10,
    color: GPU_COLORS.muted,
    width: innerWidth,
  });
  cursor += Math.max(14, hint.height) + 12;

  if (ledger.length === 0) {
    ctx.text(pane.content, snapshot.t('admin.ledgerEmpty'), columnX, cursor, {
      size: 11,
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    pane.extend(cursor + 32);
    ctx.scrollMax.ledger = pane.finish();
    return;
  }

  const listHeight = ledger.length * rowHeight + 12;
  ctx.panel(
    pane.content,
    x,
    cursor,
    panelWidth,
    listHeight,
    GPU_COLORS.panel,
    GPU_COLORS.border,
    GPU_LAYOUT.radius,
    2
  );
  const rowX = columnX + 8;
  const rowRight = columnX + innerWidth - 8;
  const kindX = rowX + STAMP_WIDTH + 14;
  const subjectX = compact ? rowX : kindX + KIND_WIDTH + 10;
  const subjectWidth = Math.max(0, rowRight - subjectX);
  let rowY = cursor + 8;
  for (const entry of ledger) {
    if (pane.visible(rowY, rowY + rowHeight)) {
      ctx.text(
        pane.content,
        // Same tolerance as a journal row: an unparseable stamp shows raw.
        relativeTime(entry.at, snapshot.t, snapshot.state.locale) || truncate(entry.at, 19),
        rowX,
        rowY,
        { size: 9, color: GPU_COLORS.muted, width: STAMP_WIDTH, singleLine: true }
      );
      const exactAt = timestampTooltip(entry.at, snapshot.state.locale);
      if (exactAt) {
        ctx.tooltip(pane.content, { x: rowX, y: rowY, width: STAMP_WIDTH, height: 13, text: exactAt });
      }
      ctx.text(pane.content, entry.kind, kindX, rowY, {
        size: 9,
        color: KIND_COLORS[entry.kind] ?? GPU_COLORS.muted,
        mono: true,
        width: compact ? Math.max(0, rowRight - kindX) : KIND_WIDTH,
        singleLine: true,
      });
      const subjectY = rowY + (compact ? 16 : 0);
      ctx.text(pane.content, ledgerSubject(entry), subjectX, subjectY, {
        size: 10,
        color: GPU_COLORS.text,
        width: subjectWidth,
        singleLine: true,
      });
      ctx.tooltip(pane.content, {
        x: subjectX,
        y: subjectY,
        width: subjectWidth,
        height: 14,
        text: ledgerBubble(entry),
      });
      const facts = ledgerFacts(entry, snapshot.t);
      if (facts.length > 0) {
        ctx.text(pane.content, facts.join(' · '), subjectX, rowY + (compact ? 32 : 16), {
          size: 9,
          color: GPU_COLORS.muted,
          width: subjectWidth,
          singleLine: true,
        });
      }
    }
    rowY += rowHeight;
  }
  cursor += listHeight + 12;

  pane.extend(cursor + 8);
  ctx.scrollMax.ledger = pane.finish();
}
