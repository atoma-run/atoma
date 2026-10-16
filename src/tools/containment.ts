import { sep } from 'node:path';

const SEP_BYTE = sep.charCodeAt(0);

/**
 * `real` is `root` or lies below it; byte-wise, so a non-UTF-8 name cannot
 * read as inside. The one containment check, re-exported by `sandbox.ts`. Its
 * own module, free of side effects at import, because the parent-test
 * coordinator imports it under `--permission`, where `sandbox.ts`'s probe of
 * `/proc/self/fd` is refused.
 */
export function containedIn(real: Buffer, root: Buffer): boolean {
  if (real.equals(root)) return true;
  if (real.length <= root.length || !real.subarray(0, root.length).equals(root)) return false;
  return root[root.length - 1] === SEP_BYTE || real[root.length] === SEP_BYTE;
}
