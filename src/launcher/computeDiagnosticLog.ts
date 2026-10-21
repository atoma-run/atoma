import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Two bounded private files, shared by the CLI and desktop utility process.
 * The inventory owner supplies this private state root, never the wire. */
export function computeDiagnosticLog(root: string): (line: string) => void {
  const path = join(root, 'connection.log');
  return line => {
    let fd: number | undefined;
    try {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
        if (stat.size >= 1024 * 1024) renameSync(path, `${path}.1`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o077))) return;
      writeSync(fd, line);
    } catch { /* Full or unavailable disks cannot bypass workload teardown. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}
