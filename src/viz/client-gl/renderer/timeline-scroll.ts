import { timelineItemHolds, type TimelineLayout } from '../../client/timeline-layout.js';

/** Keep the same recorded action at the same fractional row after live inserts. */
export function anchoredTimelineRow(
  previousIds: readonly string[], timeline: TimelineLayout, row: number, rowOffset = 1
): number {
  if (row <= 0 || previousIds.length === 0) return row;
  const index = Math.max(0, Math.min(previousIds.length - 1, Math.floor(row) - rowOffset));
  // Batches can absorb a former row: membership, rather than card identity,
  // keeps that action reachable. A removed anchor falls back to a neighbour.
  for (let distance = 0; distance < previousIds.length; distance++) {
    for (const candidate of distance === 0 ? [index] : [index + distance, index - distance]) {
      const id = previousIds[candidate];
      if (!id) continue;
      const next = timeline.items.findIndex(item => timelineItemHolds(item, id));
      if (next >= 0) return Math.max(0, row + next - candidate);
    }
  }
  return row;
}

export function anchoredTimelineScroll(
  previousIds: readonly string[], timeline: TimelineLayout, scrollY: number,
  topPadding: number, rowHeight: number
): number {
  if (scrollY <= 0) return 0;
  const row = (scrollY - topPadding) / rowHeight;
  return Math.max(0, scrollY + Math.round(anchoredTimelineRow(previousIds, timeline, row) - row) * rowHeight);
}
