/**
 * THE ORDER of every run list, newest `startedAt` first, then id.
 *
 * Here, outside `client/` and away from `runIndex.ts` (which reads files),
 * because both sides apply it: the server sorts and cuts pages with it, and
 * the browser merges those pages with a project's own list without
 * reordering a row the server placed (see `liveness.ts` for why shared code
 * cannot live under `client/`).
 */
export function compareRunIndex(
  a: { readonly startedAt: string; readonly id: string },
  b: { readonly startedAt: string; readonly id: string }
): number {
  const tb = Date.parse(b.startedAt);
  const ta = Date.parse(a.startedAt);
  if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) return tb - ta;
  return b.id.localeCompare(a.id);
}
