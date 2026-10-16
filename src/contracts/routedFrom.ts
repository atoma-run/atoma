import { z } from 'zod';

/**
 * THE HOST'S MARK ON A SPLIT CHECKPOINT PART — set only by
 * `routeCrossBucketVerification` (src/atoms/L3Atom.ts) when it splits a
 * planner checkpoint into a browser part and an exact-shell part.
 *
 * `index` is the PLANNER's subtask index, `role` which part this is, and
 * `criteria` whether the checkpoint's acceptance criteria are this part's
 * requirements (`binding`) or only context it hears (`context`). A split
 * checkpoint has at most one binding part: the one routed to a cell holding
 * validate_html, run_shell and start_node_server, the only cell type that can
 * produce both the browser and the command evidence a criterion may need. A
 * part that cannot prove both was judged on every criterion before 2026-10-16
 * (group G5) — the README loop of records/incidents/first-refusals-2026-10-10.md.
 *
 * It is NOT in `subtaskSpecSchema`, so model JSON cannot carry it; a resumed
 * root restores it from the raw checkpoint (`restoreRoutingMarks`). Strict:
 * a malformed mark is dropped, and the part's criteria then bind, which was
 * the behaviour before the mark existed.
 */
export const routedFromSchema = z.object({
  index: z.number().int().nonnegative(),
  role: z.enum(['browser-verification', 'shell-verification']),
  criteria: z.enum(['binding', 'context']),
}).strict();

export type RoutedFrom = z.infer<typeof routedFromSchema>;
