import { describe, expect, it } from 'vitest';
import { buildTimelineLayout } from '../src/viz/client/timeline-layout.js';
import type { VizEvent } from '../src/viz/client/types.js';
import { anchoredTimelineRow, anchoredTimelineScroll } from '../src/viz/client-gl/renderer/timeline-scroll.js';

const filters = { kind: 'all', role: 'all', branchId: 'all' } as const;
const tool = (id: string, ts: number): VizEvent => ({ id, ts, kind: 'tool', name: 'read_file' });
const layout = (events: VizEvent[]) => buildTimelineLayout(events, filters, { newestFirst: true });

describe('live timeline reading anchors', () => {
  it('does not move either pane when an existing tool batch grows', () => {
    const before = layout([tool('first', 1), tool('second', 2)]);
    const after = layout([tool('first', 1), tool('second', 2), tool('third', 3)]);
    const ids = before.items.map(item => item.event.id);
    expect(after.items).toHaveLength(1);
    expect(anchoredTimelineScroll(ids, after, 63, 18, 40)).toBe(63);
    expect(anchoredTimelineRow(ids, after, 1.5)).toBe(1.5);
    // An anchor still belongs to its batch if it is no longer its representative.
    expect(anchoredTimelineRow(['second'], after, 1.5)).toBe(1.5);
  });

  it('counts display rows, rather than the number of newly received tool calls', () => {
    const before = layout([{ id: 'plan', kind: 'llm', ts: 0 }]);
    const after = layout([{ id: 'plan', kind: 'llm', ts: 0 }, tool('first', 1), tool('second', 2)]);
    expect(anchoredTimelineScroll(before.items.map(item => item.event.id), after, 63, 18, 40)).toBe(103);
  });

  it('follows new events at the top, and tolerates empty or replaced traces', () => {
    const next = layout([tool('new', 1)]);
    expect(anchoredTimelineScroll(['old'], next, 0, 18, 40)).toBe(0);
    expect(anchoredTimelineRow(['old'], next, 10.5)).toBe(10.5);
    expect(anchoredTimelineRow([], next, 10.5)).toBe(10.5);
  });
});
