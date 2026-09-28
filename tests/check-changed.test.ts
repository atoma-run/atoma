import { describe, expect, it } from 'vitest';
import { changedCheckSteps } from '../scripts/check-changed.mjs';

/**
 * The mender's harness check (`npm run check:changed`). Measured 2026-09-28 in
 * the mender's container at the production revision: the whole-tree lint
 * aborted at its 1536 MiB heap (3.5 GiB resident unbounded), so the full
 * `npm run check` had never been able to pass there, and the suite alone took
 * 18 minutes on its one worker. This keeps what the harness still runs whole,
 * and what it scopes to the change.
 */
describe('the check scoped to a change', () => {
  const exists = (file: string): boolean => !file.includes('deleted');

  it('runs the docs check and the typecheck whole, then lints and tests the change', () => {
    expect(changedCheckSteps(['src/tools/probe.ts', 'tests/probe.test.ts', 'docs/incidents/x.md'], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
      ['npx', ['eslint', 'src/tools/probe.ts', 'tests/probe.test.ts']],
      ['npx', ['vitest', 'run', 'tests/probe.test.ts']],
    ]);
  });

  it('lints a changed test helper without running it as a test', () => {
    expect(changedCheckSteps(['tests/helpers.ts', 'src/a.mjs'], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
      ['npx', ['eslint', 'tests/helpers.ts', 'src/a.mjs']],
    ]);
  });

  it('skips a deleted path and a repeated one, and keeps the whole-tree steps for an empty change', () => {
    expect(changedCheckSteps(['src/deleted.ts', 'tests/a.test.ts', 'tests/a.test.ts'], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
      ['npx', ['eslint', 'tests/a.test.ts']],
      ['npx', ['vitest', 'run', 'tests/a.test.ts']],
    ]);
    expect(changedCheckSteps([], exists)).toEqual([
      ['npm', ['run', 'docs:check']],
      ['npm', ['run', 'typecheck']],
    ]);
  });
});
