/** L3 runs at the root, so no parent awards it result trust credits. */
export function trustCountsLabel(atom: { tier: number; successes: number; failures: number }): string | null {
  return atom.tier === 3 ? null : `✓${atom.successes}/✗${atom.failures}`;
}
