import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestModule, TestSpecification, Vitest } from 'vitest/node';
import { BaseSequencer } from 'vitest/node';
import { DiscoveryReporter } from '../vitest.config.js';

/**
 * THE GATE MUST NOT SAY "PASSED" ABOUT FILES IT NEVER RAN.
 *
 * Measured on a Windows host, 2026-08-30: vitest collected 238 test files,
 * reported results for 237, and exited green — one file's 31 tests silently
 * did not run. `DiscoveryReporter` closes that class by requiring every
 * queued specification to come back as a reported module.
 *
 * The real drop crossed a worker boundary that cannot be reproduced
 * deterministically, so the end-to-end half here injects the loss at the
 * reporter's own seam (a specification that no worker will ever report)
 * inside a REAL child vitest run — proving the load-bearing claim that an
 * error thrown by a user reporter turns the child run's exit code red.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_ENTRY = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function specificationOf(moduleId: string): TestSpecification {
  return { moduleId } as unknown as TestSpecification;
}

function moduleOf(moduleId: string): TestModule {
  return { moduleId } as unknown as TestModule;
}

describe('DiscoveryReporter — queued files must report back', () => {
  it('stays silent when every queued file reports', async () => {
    const reporter = new DiscoveryReporter();
    await reporter.onTestRunStart([specificationOf('/a.test.ts'), specificationOf('/b.test.ts')]);
    expect(() =>
      reporter.onTestRunEnd([moduleOf('/a.test.ts'), moduleOf('/b.test.ts')], [], 'passed')
    ).not.toThrow();
  });

  it('throws on a green run that lost a file, naming it', async () => {
    const reporter = new DiscoveryReporter();
    await reporter.onTestRunStart([specificationOf('/a.test.ts'), specificationOf('/lost.test.ts')]);
    expect(() => reporter.onTestRunEnd([moduleOf('/a.test.ts')], [], 'passed')).toThrow(
      /1 queued test file\(s\) never reported a result: \/lost\.test\.ts/
    );
  });

  it('lets an interrupted run go: Ctrl+C is not a discovery defect', async () => {
    const reporter = new DiscoveryReporter();
    await reporter.onTestRunStart([specificationOf('/a.test.ts'), specificationOf('/b.test.ts')]);
    expect(() => reporter.onTestRunEnd([moduleOf('/a.test.ts')], [], 'interrupted')).not.toThrow();
  });

  it('under --shard, expects exactly the files the configured sequencer gives this shard', async () => {
    // CI runs three shards (2026-10-24). Vitest hands the FULL list to
    // onTestRunStart and only this shard's modules to onTestRunEnd; the
    // reporter narrows its queue with the same `shard()` vitest applies, so
    // a healthy shard stays green and one that lost its own file reddens.
    const files = ['/a.test.ts', '/b.test.ts', '/c.test.ts', '/d.test.ts', '/e.test.ts'];
    const shardOf = async (index: number, count: number): Promise<string[]> => {
      const vitest = {
        config: { root: '/', shard: { index, count }, sequence: { sequencer: BaseSequencer } },
      } as unknown as Vitest;
      const specs = files.map(specificationOf);
      const mine = (await new BaseSequencer(vitest).shard([...specs])).map((s) => s.moduleId);
      const reporter = new DiscoveryReporter();
      reporter.onInit(vitest);
      await reporter.onTestRunStart(specs);
      expect(() => reporter.onTestRunEnd(mine.map(moduleOf), [], 'passed')).not.toThrow();
      const [lost, ...kept] = mine;
      expect(() => reporter.onTestRunEnd(kept.map(moduleOf), [], 'passed')).toThrow(
        new RegExp(`1 queued test file\\(s\\) never reported a result: ${lost!}`)
      );
      return mine;
    };
    const shards = [await shardOf(1, 2), await shardOf(2, 2)];
    // The two shards partition the suite: nothing shared, nothing dropped.
    expect([...shards[0]!, ...shards[1]!].sort()).toEqual([...files].sort());
    expect(shards[0]!.length).toBeGreaterThan(0);
    expect(shards[1]!.length).toBeGreaterThan(0);
  });

  it('only diagnoses on a run that is already failing', async () => {
    // A second thrown error would bury the failure that made the run red;
    // the missing files are still named on stderr.
    const reporter = new DiscoveryReporter();
    await reporter.onTestRunStart([specificationOf('/a.test.ts'), specificationOf('/lost.test.ts')]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => reporter.onTestRunEnd([moduleOf('/a.test.ts')], [], 'failed')).not.toThrow();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('/lost.test.ts'));
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * A fixture OUTSIDE the repo (vite would externalize test files placed under
 * node_modules and hand raw TypeScript to node), with a node_modules link
 * back into this repo so the child vitest and the fixture's imports resolve
 * this repo's own dependencies. A junction keeps the link admin-free on
 * Windows; on POSIX the type is ignored and an ordinary symlink is made.
 */
function fixture(configBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-discovery-'));
  fixtures.push(dir);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  // ESM, like this repo — without it Vite loads the fixture config as
  // CommonJS and warns about it on stderr.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'discovery-fixture', private: true, type: 'module' }) + '\n'
  );
  writeFileSync(join(dir, 'vitest.config.ts'), configBody);
  const passing = "import { expect, it } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n";
  writeFileSync(join(dir, 'a.test.ts'), passing);
  writeFileSync(join(dir, 'b.test.ts'), passing);
  return dir;
}

/** This repo's vitest.config.ts as an import specifier the fixture can use. */
const REPORTER_IMPORT = `${REPO_ROOT.split('\\').join('/')}/vitest.config.ts`;

function runNestedVitest(root: string, args: string[] = []): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0' };
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST')) env[key] = value;
  }
  // The 120s vitest budget on the callers is a timer on the SAME event loop
  // this synchronous call blocks, so it can never preempt a wedged nested
  // run — the bound has to live here, inside the call itself.
  const child = spawnSync(process.execPath, [VITEST_ENTRY, 'run', '--root', root, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 110_000,
    killSignal: 'SIGKILL',
  });
  return { status: child.status, output: `${child.stdout}\n${child.stderr}` };
}

describe('DiscoveryReporter — inside a real vitest run', () => {
  it('a complete run stays green with the reporter armed', () => {
    const dir = fixture(
      [
        "import { defineConfig } from 'vitest/config';",
        `import { DiscoveryReporter } from '${REPORTER_IMPORT}';`,
        'export default defineConfig({',
        "  test: { include: ['*.test.ts'], reporters: ['default', new DiscoveryReporter()] },",
        '});',
        '',
      ].join('\n')
    );
    const run = runNestedVitest(dir);
    expect(run.output).toContain('2 passed');
    expect(run.status).toBe(0);
  }, 120_000);

  it('a queued file that never reports turns the run red and is named', () => {
    const dir = fixture(
      [
        "import { defineConfig } from 'vitest/config';",
        "import type { TestSpecification } from 'vitest/node';",
        `import { DiscoveryReporter } from '${REPORTER_IMPORT}';`,
        'class PhantomQueue extends DiscoveryReporter {',
        '  override onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {',
        '    super.onTestRunStart([',
        '      ...specifications,',
        "      { moduleId: '/phantom-never-reported.test.ts' } as unknown as TestSpecification,",
        '    ]);',
        '  }',
        '}',
        'export default defineConfig({',
        "  test: { include: ['*.test.ts'], reporters: ['default', new PhantomQueue()] },",
        '});',
        '',
      ].join('\n')
    );
    const run = runNestedVitest(dir);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('discovery: 1 queued test file(s) never reported a result');
    expect(run.output).toContain('/phantom-never-reported.test.ts');
  }, 120_000);

  it('a shard stays green with the files it was given, and red when its own file is lost', () => {
    const armed = [
      "import { defineConfig } from 'vitest/config';",
      `import { DiscoveryReporter } from '${REPORTER_IMPORT}';`,
      'export default defineConfig({',
      "  test: { include: ['*.test.ts'], reporters: ['default', new DiscoveryReporter()] },",
      '});',
      '',
    ].join('\n');
    // One of two files per shard: the full list is queued, half of it reports.
    const half = runNestedVitest(fixture(armed), ['--shard=1/2']);
    expect(half.output).toContain('1 passed');
    expect(half.status).toBe(0);
    // Narrowing is the sequencer's: a shard that drops one of its OWN files
    // is still caught (count 1 keeps every file, the phantom included).
    const phantom = fixture(
      [
        "import { defineConfig } from 'vitest/config';",
        "import type { TestSpecification } from 'vitest/node';",
        `import { DiscoveryReporter } from '${REPORTER_IMPORT}';`,
        'class PhantomQueue extends DiscoveryReporter {',
        '  override onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void | Promise<void> {',
        '    return super.onTestRunStart([',
        '      ...specifications,',
        "      { moduleId: '/phantom-never-reported.test.ts' } as unknown as TestSpecification,",
        '    ]);',
        '  }',
        '}',
        'export default defineConfig({',
        "  test: { include: ['*.test.ts'], reporters: ['default', new PhantomQueue()] },",
        '});',
        '',
      ].join('\n')
    );
    const lost = runNestedVitest(phantom, ['--shard=1/1']);
    expect(lost.status).not.toBe(0);
    expect(lost.output).toContain('discovery: 1 queued test file(s) never reported a result');
  }, 240_000);
});
