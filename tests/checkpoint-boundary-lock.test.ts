import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every walk of the checkpoint opens the workspace root through this spy, which
// records whether the store's write transaction was open at that moment. The
// root's OPEN is counted, not its listing: on Linux the walker lists the pinned
// `/proc/self/fd/<n>` path, which never equals the root.
const walks = vi.hoisted(() => ({ root: '', db: undefined as { inTransaction: boolean } | undefined, inside: 0, outside: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const openSync = ((path: Parameters<typeof fs.openSync>[0], ...rest: unknown[]) => {
    if (walks.root && String(path) === walks.root) {
      if (walks.db?.inTransaction) walks.inside += 1; else walks.outside += 1;
    }
    return (fs.openSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.openSync;
  return { ...fs, default: { ...fs, openSync }, openSync };
});

const { RunCheckpointStore } = await import('../src/run/checkpoint.js');
const { closeStoreHandles } = await import('../src/core/stores.js');

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); walks.root = ''; walks.db = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('sealing a phase boundary', () => {
  // Code review 2026-10-09 2.9: the boundary walked the whole workspace
  // twice inside the shared store's write transaction, 10.8 s at the
  // admitted limits, past the other writers' 5 s busy timeout.
  it('holds the shared store\'s write lock for one walk of the workspace, not two', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-boundary-lock-'))); roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'index.html'), '<p>hi</p>');
    const store = new RunCheckpointStore(join(root, 'atoma.db'));
    const id = randomUUID();
    const data: { workspaceDigest: string | null } & Record<string, unknown> = {
      version: 1, id, scope: { orgId: 'o', projectId: 'p', principalId: 'u', runId: id }, goal: 'g', workspace,
      policy: '{}', actor: { name: 'Meristem', atomId: 'a', version: 1 }, checklist: [], root: null, completed: [],
      workspaceDigest: null, processes: [], consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null,
    };
    const owner = store.claim(data as never, true);
    walks.root = workspace;
    walks.db = (store as unknown as { db: Database.Database }).db;
    store.boundary(data as never, owner);
    expect(walks).toMatchObject({ inside: 1, outside: 1 });
    expect(data.workspaceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
