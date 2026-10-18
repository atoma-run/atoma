import { z } from 'zod';
export const computeTargetSchema = z.enum(['mac-arm64', 'mac-x64', 'mac', 'windows-x64', 'unsupported', 'unknown']);
export type ComputeTarget = z.infer<typeof computeTargetSchema>;
/** Browser hints select instructions only; they are never an admission authority.
 * Intel in a Mac user agent does not identify the physical chip. */
export function detectComputeTarget(ua: string, platform = '', architecture = '', touchPoints = 0): ComputeTarget {
  if (/Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(ua) && touchPoints > 1)) return 'unsupported';
  if (/Windows|Win32|Win64/i.test(platform || ua)) return /arm/i.test(architecture) || /ARM64/i.test(ua) ? 'unsupported' : 'windows-x64';
  if (/macOS|Macintosh|MacIntel|Mac OS X/i.test(platform || ua)) return /arm/i.test(architecture) ? 'mac-arm64' : /x86|x64/i.test(architecture) ? 'mac-x64' : 'mac';
  return /Linux|Chrome OS|CrOS/i.test(platform || ua) ? 'unsupported' : 'unknown';
}
export const computePreparationSchema = z.object({
  target: computeTargetSchema, osVersion: z.string().max(80),
  stage: z.enum(['checking', 'unsupported', 'os-update', 'wsl-required', 'virtualization', 'install-required', 'installer-download', 'installer-open', 'starting', 'ready', 'start-failed', 'download-failed']),
  downloadedBytes: z.number().nonnegative().default(0), totalBytes: z.number().positive().nullable().default(null),
});
export type ComputePreparation = z.infer<typeof computePreparationSchema>;
export const DOCKER_DOWNLOADS = {
  'mac-arm64': 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
  'mac-x64': 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
  'windows-x64': 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
} as const;

export const computeImageProgressSchema = z.object({ elapsedSeconds: z.number().int().nonnegative(), layers: z.number().int().min(0).max(256), readyLayers: z.number().int().min(0).max(256) });
export type ComputeImageProgress = z.infer<typeof computeImageProgressSchema>;
