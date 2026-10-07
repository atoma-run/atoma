/** Host resource budgets, shared by import, delivery and repository sync.
 * File count bounds metadata; bytes bound content. Neither is a change count.
 */
export const WORKSPACE_LIMITS = Object.freeze({
  maxFiles: 100_000,
  maxEntries: 400_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathChars: 512,
});
