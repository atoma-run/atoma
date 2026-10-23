import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordedProcessLive } from '../mcp/runLock.js';

export function executorForOwner(active: string, pid: number): string | undefined {
  for (const name of readdirSync(dirname(active))) {
    if (!/^[a-f0-9]{40}\.sock\.json$/.test(name)) continue;
    const socket = join(dirname(active), name.slice(0, -5));
    try {
      const receipt = JSON.parse(readFileSync(`${socket}.json`, 'utf8')) as { pid: number; fingerprint: string };
      if (receipt.pid === pid && recordedProcessLive(receipt.pid, receipt.fingerprint)) return socket;
    } catch { /* An exiting generation can remove its receipt during the inventory. */ }
  }
  return undefined;
}

/** Host-private health snapshot, not a new product-state or task record. */
export function executorSnapshot<T>(active: string): T | null {
  try {
    const receipt = JSON.parse(readFileSync(`${realpathSync(active)}.json`, 'utf8')) as { pid: number; fingerprint: string; snapshot?: T };
    return recordedProcessLive(receipt.pid, receipt.fingerprint) ? receipt.snapshot ?? null : null;
  } catch { return null; }
}

/** Live generations, including those draining work after the admission symlink moved. */
export function executorSnapshots<T>(active: string): Array<{ socket: string; selected: boolean; snapshot: T }> {
  let selected: string | null = null;
  try { selected = realpathSync(active); } catch { /* A draining generation may still exist. */ }
  let names: string[];
  let root: string;
  try { root = realpathSync(dirname(active)); names = readdirSync(root); } catch { return []; }
  return names.filter(name => /^[a-f0-9]{40}\.sock\.json$/.test(name)).flatMap(name => {
    const socket = join(root, name.slice(0, -5));
    const snapshot = executorSnapshot<T>(socket);
    return snapshot === null ? [] : [{ socket, selected: socket === selected, snapshot }];
  });
}
