import { Rectangle } from 'pixi.js';
import { fmtCost, runActorActivity, type AtomView } from '../../../client/run-utils.js';
import type { VizRun } from '../../../client/types.js';
import { taxonomyForTier } from '../../../../core/taxonomy.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { createScrollPane } from '../scroll-pane.js';

/**
 * Right-pane detail for a name the Runs view shows WITHOUT a registry
 * snapshot behind it — the placeholder `buildAtomMap` builds carries a name
 * and a tier and nothing else.
 *
 * It is NOT `drawAtomDetail` with blanks. Drawn through that sheet, the
 * placeholder read as an agent type: `run-root` showed "L3 Tissue · #0 · v0",
 * "Created · ·" and an empty system prompt, which is four invented facts and
 * an empty one (owner question, 2026-10-06). A run actor gets what it is —
 * a call the run makes itself, its role, what it did in THIS run from its own
 * events — and an unsnapshotted agent type says the trace cannot show it.
 */

const HEADING_GAP = 8;
const SECTION_GAP = 16;

export function drawAtomStubDetail(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  run: VizRun,
  atom: AtomView & { stub: NonNullable<AtomView['stub']> },
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const { name, tier } = atom.snapshot;
  const runActor = atom.stub.kind === 'run-actor' ? atom.stub.key : undefined;
  ctx.text(ctx.root, name, x + 18, y + 16, { size: 16, weight: '700' });
  const rank = runActor || !(tier === 1 || tier === 2 || tier === 3)
    ? ''
    : `L${tier} ${snapshot.t(`rank.${taxonomyForTier(tier).rank}`)} · `;
  ctx.text(
    ctx.root,
    rank + snapshot.t(runActor ? 'registry.runActor.badge' : 'registry.unrecorded.badge'),
    x + 18,
    y + 43,
    { size: 10, color: GPU_COLORS.muted }
  );

  const paneTop = y + 70;
  const pane = createScrollPane(ctx.root, {
    x,
    y: paneTop,
    width,
    height: y + height - paneTop,
    scrollY: ctx.detailScrollY,
  });
  const innerWidth = width - 36;
  let cursor = 0;
  const heading = (label: string): void => {
    ctx.text(pane.content, label.toUpperCase(), 18, cursor, {
      size: 9,
      weight: '700',
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += 14 + HEADING_GAP;
  };
  const body = (value: string, options: { mono?: boolean; muted?: boolean } = {}): void => {
    const drawn = ctx.text(pane.content, value, 18, cursor, {
      size: options.mono ? 10 : 12,
      ...(options.mono ? { mono: true } : {}),
      color: options.muted ? GPU_COLORS.muted : GPU_COLORS.text,
      width: innerWidth,
    });
    cursor += Math.max(12, drawn.height) + SECTION_GAP;
  };

  if (!runActor) {
    body(snapshot.t('registry.unrecorded.body'));
  } else {
    body(snapshot.t(`registry.runActor.${runActor}`));

    const activity = runActorActivity(run, name);
    heading(snapshot.t('registry.runActor.activityHeading'));
    if (activity.calls === 0) {
      body(snapshot.t('registry.runActor.noCalls'), { muted: true });
    } else {
      body(
        [
          snapshot.t('registry.runActor.calls', { count: activity.calls, cost: fmtCost(activity.costUsd) }),
          ...activity.models.map((entry) =>
            snapshot.t('registry.runActor.modelCalls', { model: entry.model, count: entry.calls })),
        ].join('\n'),
        { mono: true }
      );
    }
    if (activity.verdicts.length > 0) {
      heading(snapshot.t('registry.runActor.verdictsHeading'));
      body(
        activity.verdicts
          .map((verdict) => snapshot.t('registry.runActor.verdict', {
            attempt: verdict.attempt,
            outcome: snapshot.t(verdict.approved ? 'outcome.approved' : 'outcome.rejected'),
          }))
          .join('\n'),
        { mono: true }
      );
    }

    heading(snapshot.t('registry.runActor.whyHeading'));
    body(
      [snapshot.t('registry.runActor.why'), snapshot.t('registry.runActor.tier', { tier })].join('\n\n'),
      { muted: true }
    );
  }

  pane.extend(cursor);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
  pane.content.position.y = -ctx.detailScrollY;
  ctx.detailBounds = new Rectangle(x, y, width, height);
}
