import { z } from 'zod';
import { HAYSTACK_LAUNCH_ENV, haystackLaunchSchema, readHaystackLaunch, type HaystackLaunch } from './retrievalHaystack.js';

export const COMPUTE_HAYSTACK_CONFIG_ENV = 'ATOMA_COMPUTE_HAYSTACK_CONFIG';
export const COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV = 'ATOMA_COMPUTE_HAYSTACK_CONFIG_BY_DEVICE';
/** Host-owned device overrides reuse the complete pinned runtime contract. */
const computeHaystackDeviceIdSchema = z.string().uuid();
export const computeHaystackByDeviceSchema = z.unknown()
  // Validate raw keys before record parsing can discard object metakeys.
  .refine(value => value === null || typeof value !== 'object' ||
    Object.keys(value).every(key => computeHaystackDeviceIdSchema.safeParse(key).success), 'expected device UUID keys')
  .pipe(z.record(computeHaystackDeviceIdSchema, haystackLaunchSchema));

/** Select by the immutable execution receipt, never a tenant-provided runtime. */
export function readComputeHaystackLaunch(env: NodeJS.ProcessEnv, deviceId: string): HaystackLaunch {
  const raw = env[COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV];
  if (raw !== undefined) {
    try {
      if (!raw || Buffer.byteLength(raw) > 64 * 1024) throw new Error('missing or oversized');
      const configured = computeHaystackByDeviceSchema.parse(JSON.parse(raw));
      const selected = Object.hasOwn(configured, deviceId) ? configured[deviceId] : undefined;
      if (selected) return selected;
    } catch { throw new Error('project retrieval requires a valid ATOMA_COMPUTE_HAYSTACK_CONFIG_BY_DEVICE configuration'); }
  }
  // Older admitted clients retain their configured runtime. Updating one
  // device cannot silently change the runtime expected from another one.
  const legacy = env[COMPUTE_HAYSTACK_CONFIG_ENV];
  return readHaystackLaunch(legacy ? { [HAYSTACK_LAUNCH_ENV]: legacy } : env);
}
