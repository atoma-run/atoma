import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import type { Reporter, TestModule, TestRunEndReason, TestSpecification, Vitest } from 'vitest/node';
import type { SerializedError } from 'vitest';

/**
 * Every test file vitest QUEUED must come back with a result. A worker that
 * dies without reporting shrinks the suite while the run stays green — the
 * gate then says "passed" about files it never executed (measured on a
 * Windows host, 2026-08-30: 237 of 238 collected files reported and the
 * missing file's 31 tests silently did not run). Vitest propagates an error
 * thrown by a user reporter out of `start()`, which is what turns the
 * mismatch into a red run. Comparing against `onTestRunStart`'s own queue —
 * rather than a directory glob — keeps filtered invocations
 * (`vitest run tests/one.test.ts`) honest for free.
 *
 * `--shard` hands the FULL pre-shard specification list to onTestRunStart
 * and then, by design, only this shard's modules to onTestRunEnd. CI runs
 * the suite as three shards (2026-10-24), so the queue is narrowed with the
 * configured sequencer's own `shard()` — the function vitest applies — and
 * a shard that loses one of its OWN files still reddens. An earlier guard
 * simply switched the reporter off under `--shard`, which would have left
 * every CI shard unprotected.
 */
export class DiscoveryReporter implements Reporter {
  private queued: string[] = [];
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void | Promise<void> {
    const vitest = this.vitest;
    if (vitest?.config.shard == null) {
      this.queued = specifications.map((specification) => specification.moduleId);
      return;
    }
    const sequencer = new vitest.config.sequence.sequencer(vitest);
    return Promise.resolve(sequencer.shard([...specifications])).then((shard) => {
      this.queued = shard.map((specification) => specification.moduleId);
    });
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason
  ): void {
    if (reason === 'interrupted') return;
    const reported = new Set(testModules.map((module) => module.moduleId));
    const missing = this.queued.filter((moduleId) => !reported.has(moduleId));
    if (missing.length === 0) return;
    const message =
      `${missing.length} queued test file(s) never reported a result: ${missing.join(', ')}`;
    if (reason === 'failed') {
      // The run is already red; name the dropped files without burying the
      // failure that made it red.
      console.error(`discovery: ${message}`);
      return;
    }
    throw new Error(`discovery: ${message}`);
  }
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Order matters: the store isolation hooks below register at file level
    // and must be in place before any test file's own hooks.
    setupFiles: ['tests/setup-tier-pins.ts', 'tests/setup-store-isolation.ts'],
    reporters: ['default', new DiscoveryReporter()],
    // Isolate the lifecycle ledger: without this, every registry-touching
    // test appends events to the developer's real ./atoma-ledger.jsonl
    // (observed: 575 garbage events after one suite run). Tests that
    // exercise the ledger itself override the var per-test with a temp
    // path; this default only has to keep the noise out of the repo root.
    env: {
      // The ledger is a TABLE in the store now (src/core/ledger.ts), so the
      // isolation pin had to follow it from a file path to a DB path. Same
      // reason as before: without it, every registry-touching test appends
      // lifecycle events to the developer's real store (observed: 575 garbage
      // events after one suite run). AtomRegistry no longer needs this — it
      // writes through its own handle, so a `:memory:` fixture is isolated by
      // construction — but SkillRegistry has no store handle and still
      // resolves a default.
      ATOMA_LEDGER_DB: './node_modules/.atoma-test-ledger.db',
      // The product store itself, for the same reason: `storeDbPath()` falls
      // back to `./atoma.db`, so an unpinned reader or writer (the MCP
      // readers, `platformLimitsFor()`) would create or read the developer's
      // real store. tests/setup-store-isolation.ts replaces both with a fresh
      // file per test; this pin only covers code outside a test's hooks.
      ATOMA_DB_PATH: './node_modules/.atoma-test-store.db',
      // Same isolation story for the prefilter decision cache — and OFF, not
      // just relocated: mock-driven tests enqueue prefilter responses and
      // assert exact LLM call counts, so a shared cache would make test
      // order change which calls fire. Cache tests re-enable it per-test.
      ATOMA_PREFILTER_CACHE: '0',
      // Trigger evaluation is on everywhere in the product; mocked suites
      // that enqueue exact replies opt in per test.
      ATOMA_SKILL_TRIGGER_EVAL: '0',
      // Mock LLMs live in this process. Ordinary fixtures retain inline learning;
      // the worker regressions opt in explicitly and use only local fake servers.
      ATOMA_DEFER_LEARNING: '0',
    },
    // Process-bound fixtures start their own Node/Python workers and real
    // Chrome instances. A worker per CPU once oversubscribed their deadlines,
    // which is why this was capped at 4. Re-measured 2026-10-23 on a 14-CPU,
    // 24 GB developer machine: 4 workers → 299 s wall for 1044 s of file
    // time; 12 workers → 112 s and 118 s over two runs, 7960 tests, zero
    // failures, and the four longest files (65–87 s each, browser- and
    // process-bound) slowed by 3–8 s, nowhere near a timeout. Two cores stay
    // free for the child processes the fixtures spawn: 14 workers on that
    // machine took 127 s with one timing failure, 16 took 171 s with four.
    // The floor of 4 keeps CI runners (2–4 cores) at the behaviour they had
    // under the old cap. With the loopback-bound static server and the
    // checkpoint suite split in three, the same suite ran in 95 s.
    maxWorkers: Math.max(4, availableParallelism() - 2),
    environment: 'node',
    globals: false,
    testTimeout: 15_000,
  },
});
