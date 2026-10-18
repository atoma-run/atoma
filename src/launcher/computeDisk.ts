import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
export const COMPUTE_DISK_RESERVE_BYTES = 1024 ** 3;
/** Fixed launcher-owned container and filesystem, never a remote path or script. */
export async function computeFreeDisk(container: string): Promise<number> {
  const { stdout } = await exec('docker', ['exec', '--user', '10001:10001', container, 'node', '-e',
    "const s=require('node:fs').statfsSync('/workspace');process.stdout.write(String(s.bavail*s.bsize))"],
  { timeout: 10_000, maxBuffer: 1024 });
  return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(Number(stdout.trim()));
}
