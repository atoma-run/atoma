import { readFileSync } from 'node:fs';

/**
 * HOW MUCH MEMORY THIS HOST CAN STILL GIVE.
 * =========================================
 *
 * `MemAvailable` from `/proc/meminfo`: the kernel's own estimate of what can
 * be allocated without swapping, page cache included. `os.freemem()` is not
 * used: depending on the libuv version it reports MemFree, which ignores the
 * reclaimable cache and reads a healthy host as nearly full.
 *
 * LINUX ONLY, and `null` everywhere else. darwin has no equivalent figure a
 * process can read cheaply, and runs execute on darwin only as a development
 * host; a caller treats `null` as "no reading", never as "no memory".
 */
export interface HostMemory {
  readonly availableBytes: number;
  readonly totalBytes: number;
  readonly swapTotalBytes: number;
  readonly swapFreeBytes: number;
}

export function parseMeminfo(text: string): HostMemory | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const availableBytes = field('MemAvailable');
  const totalBytes = field('MemTotal');
  if (availableBytes === null || totalBytes === null) return null;
  return { availableBytes, totalBytes, swapTotalBytes: field('SwapTotal') ?? 0, swapFreeBytes: field('SwapFree') ?? 0 };
}

export function readHostMemory(meminfoPath = '/proc/meminfo'): HostMemory | null {
  if (process.platform !== 'linux') return null;
  try { return parseMeminfo(readFileSync(meminfoPath, 'utf8')); } catch { return null; }
}

export const MIB = 1024 * 1024;

/** What project-run admission last saw (`src/projects/coordinator.ts`), for the pressure watch. */
export interface RunMemoryAdmission {
  readonly reserveMb: number;
  readonly activeRuns: number;
  readonly deferrals: number;
  readonly lastDeferral: { readonly at: string; readonly availableMb: number; readonly requiredMb: number } | null;
}
