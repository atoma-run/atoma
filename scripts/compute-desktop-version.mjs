/** Native installers need ordered SemVer, not build metadata (ignored by the
 * updater). The workflow run number is shared by all three platform builds. */
export function computeDesktopVersion(base, buildNumber) {
  if (buildNumber === undefined) return base;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match || !/^[1-9]\d*$/.test(buildNumber)) throw new Error('Invalid Compute desktop build version');
  const patch = Number(match[3]) + Number(buildNumber);
  // Windows version components are unsigned 16-bit integers.
  if (!Number.isSafeInteger(patch) || patch > 65535) throw new Error('Compute desktop patch version exceeds the native limit');
  return `${match[1]}.${match[2]}.${patch}`;
}
