import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

// Async scope follows the run's branches without affecting another library run.
// This is a write-ahead recovery barrier, not fail-open telemetry.
const scope = new AsyncLocalStorage<{ before?: (db: Database.Database) => void }>();
export function withRecoveryEffects<T>(run: () => T): T { return scope.run({}, run); }
export function setRecoveryEffectHandler(before: (db: Database.Database) => void): void {
  const current = scope.getStore();
  if (current) current.before = before;
}
export function beforeDurableMutation(db: Database.Database): void { scope.getStore()?.before?.(db); }
export function beforeDurableFileMutation(open: () => Database.Database): void {
  if (scope.getStore()?.before) beforeDurableMutation(open());
}
