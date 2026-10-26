import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { checkGroundTruth } from '../src/atoms/groundTruth.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { forkBranch } from '../src/core/branchCtx.js';
import type { Result, RunContext, ToolExecutor } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { makeTools } from './helpers/factories.js';

/**
 * Shell evidence of a molecule that holds no command recorder (production
 * molecule Sucrose, run f91cdb19, 2026-10-25). Its run_shell executions never
 * reach the probe manifest, so the manifest's row for a command can be older
 * than the command's latest run: a pre-edit 25/25 PASS row stood beside a
 * post-edit run of the same suite that was killed.
 */
const SUITE = 'npm exec vitest -- run --config vitest.browser.config.ts';
const SUCROSE = makeTools(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'validate_html', 'start_node_server']);

function workspace(manifest: object, exits: number[]): { ctx: RunContext; base: ToolExecutor } {
  const queue = [...exits];
  const base: ToolExecutor = {
    has: (name) => ['read_file', 'write_file', 'run_shell', 'record_probe'].includes(name),
    execute: async (name, args) => {
      if (name === 'read_file') {
        if (args['path'] === '.atoma-probes.json') return { path: args['path'], content: JSON.stringify(manifest) };
        throw new Error('ENOENT');
      }
      const exitCode = queue.shift() ?? 0;
      return exitCode === 0
        ? { exitCode, stdout: 'Tests 25 passed (25)', stderr: '' }
        : { exitCode, stdout: '', stderr: '', error: 'run_shell: timed out after 30000ms (process group killed)' };
    },
  };
  return { ctx: { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() }, base };
}

function result(partial: Partial<Result> = {}): Result {
  return { output: {}, summary: 'done', trace: [], producedBy: { tier: 1, name: 'Sucrose', viaFallback: false }, ...partial };
}

describe('a stored shell row a later host execution superseded', () => {
  const child = new L1Atom({ name: 'Sucrose', ordinal: 1, systemPrompt: 'sys', tools: SUCROSE, params: {} });
  const payload = { output: { probes: [{ cmd: SUITE, exitCode: 0 }] }, summary: 'suite ran' };
  const review = async (manifest: object, exits: number[], calls: (branch: RunContext) => Promise<void>): Promise<string> => {
    const { ctx } = workspace(manifest, exits);
    const branch = forkBranch(ctx, 'sucrose');
    await calls(branch);
    return (await checkGroundTruth({ ctx: branch, subject: 'RESULT', payload, child, evidence: [] })).block;
  };

  it('labels a passing row when the same command, run later, was killed', async () => {
    const block = await review({ version: 1, entries: [{ cmd: SUITE, exitCode: 0 }] }, [1], async (branch) => {
      await branch.tools!.execute('run_shell', { cmd: SUITE, timeoutMs: 30000 });
    });
    expect(block).toContain(`PRESENT in .atoma-probes.json: {"cmd":${JSON.stringify(SUITE)},"exitCode":0}`);
    expect(block).toContain(`- ${JSON.stringify(SUITE)} (stored exitCode=0): SUPERSEDED for this result. This result's latest host execution of this exact command (run_shell, branch sucrose) exited 1; that receipt, not the stored row, is this result's outcome.`);
  });

  it('labels a failing row when the same command later passed, and reads the LATEST execution', async () => {
    const block = await review({ version: 1, entries: [{ cmd: SUITE, exitCode: 1 }] }, [1, 0], async (branch) => {
      await branch.tools!.execute('run_shell', { cmd: SUITE });
      await branch.tools!.execute('run_shell', { cmd: SUITE });
    });
    expect(block).toContain(`(stored exitCode=1): SUPERSEDED for this result. This result's latest host execution of this exact command (run_shell, branch sucrose) exited 0;`);
  });

  it('says nothing for another command, the same exit code, or a later record of the row itself', async () => {
    const other = await review({ version: 1, entries: [{ cmd: SUITE, exitCode: 0 }] }, [1], async (branch) => {
      await branch.tools!.execute('run_shell', { cmd: `${SUITE} tests/control-button-ui.vitest.test.ts` });
    });
    expect(other).not.toContain('SUPERSEDED');
    const same = await review({ version: 1, entries: [{ cmd: SUITE, exitCode: 0 }] }, [0], async (branch) => {
      await branch.tools!.execute('run_shell', { cmd: SUITE });
    });
    expect(same).not.toContain('SUPERSEDED');
    // A killed run_shell, then the record_probe that wrote the row: the record is the latest.
    const recorded = await review({ version: 1, entries: [{ cmd: SUITE, exitCode: 0 }] }, [1, 0], async (branch) => {
      await branch.tools!.execute('run_shell', { cmd: SUITE });
      await branch.tools!.execute('record_probe', { cmd: SUITE });
    });
    expect(recorded).not.toContain('SUPERSEDED');
  });

  it('never labels a row with a sibling branch\'s later run, which is not this result\'s outcome (run 51c4e71d)', async () => {
    const { ctx } = workspace({ version: 1, entries: [{ cmd: SUITE, exitCode: 0 }] }, [0, 1]);
    const judged = forkBranch(ctx, 'judged');
    const sibling = forkBranch(ctx, 'sibling');
    await judged.tools!.execute('record_probe', { cmd: SUITE });
    await sibling.tools!.execute('run_shell', { cmd: SUITE });
    const own = await checkGroundTruth({ ctx: judged, subject: 'RESULT', payload, child, evidence: [] });
    expect(own.block).not.toContain('SUPERSEDED');
    // The trunk owns the whole attempt: there, the sibling's run is the latest outcome.
    const trunk = await checkGroundTruth({ ctx, subject: 'RESULT', payload, child, evidence: [] });
    expect(trunk.block).toContain('SUPERSEDED for this result. This result\'s latest host execution of this exact command (run_shell, branch sibling) exited 1');
  });
  it('reads the latest of the judged branch\'s OWN runs: a sibling\'s later pass does not hide its kill', async () => {
    const { ctx } = workspace({ version: 1, entries: [{ cmd: SUITE, exitCode: 0 }] }, [1, 0]);
    const judged = forkBranch(ctx, 'judged');
    const sibling = forkBranch(ctx, 'sibling');
    await judged.tools!.execute('run_shell', { cmd: SUITE });
    await sibling.tools!.execute('run_shell', { cmd: SUITE });
    const own = await checkGroundTruth({ ctx: judged, subject: 'RESULT', payload, child, evidence: [] });
    expect(own.block).toContain('SUPERSEDED for this result. This result\'s latest host execution of this exact command (run_shell, branch judged) exited 1');
    // The trunk owns the whole attempt: the sibling's pass is the latest there, equal to the row.
    const trunk = await checkGroundTruth({ ctx, subject: 'RESULT', payload, child, evidence: [] });
    expect(trunk.block).not.toContain('SUPERSEDED');
  });
  it('never calls this result\'s older receipt the attempt\'s current outcome over a sibling\'s newer row', async () => {
    // judged recorded a pass, then a sibling's record_probe exited 1 and rewrote the row.
    const { ctx } = workspace({ version: 1, entries: [{ cmd: SUITE, exitCode: 1 }] }, [0, 1]);
    const judged = forkBranch(ctx, 'judged');
    const sibling = forkBranch(ctx, 'sibling');
    await judged.tools!.execute('record_probe', { cmd: SUITE });
    await sibling.tools!.execute('record_probe', { cmd: SUITE });
    const { block } = await checkGroundTruth({ ctx: judged, subject: 'RESULT', payload, child, evidence: [] });
    expect(block).toContain('which is not among this result\'s receipts');
    expect(block).toContain('SUPERSEDED for this result. This result\'s latest host execution of this exact command (record_probe, branch judged) exited 0');
    expect(block).not.toContain('This attempt\'s latest');
    expect(block).not.toContain('current outcome');
  });
});

describe('the required-command gate for a child without record_probe', () => {
  const HARNESS = 'node test-api.js';
  const task = { description: `Fix the API. Running ${HARNESS} must exit 0.` };
  const stale = { version: 1, entries: [{ cmd: HARNESS, exitCode: 1 }] };
  const gate = async (toolNames: readonly string[], exits: number[], run: boolean) => {
    const { ctx } = workspace(stale, exits);
    const branch = forkBranch(ctx, 'leaf');
    if (run) await branch.tools!.execute('run_shell', { command: 'node', args: ['test-api.js'] });
    return runResultGates(buildResultGateEnv({ task, result: result(), childName: 'Sucrose', childToolNames: toolNames, ctx: branch }), new Set());
  };
  const recorderless = SUCROSE.map((tool) => tool.name);

  it('is met by the exact command\'s latest host receipt, whatever another molecule\'s row says', async () => {
    const outcome = await gate(recorderless, [0], true);
    expect(outcome.rejection).toBeNull();
    expect(outcome.reviewFindings).toEqual([]);
  });

  it('is refused, coached to quote the host receipt, on a failing receipt or none at all', async () => {
    const failing = await gate(recorderless, [1], true);
    expect(failing.rejection).toMatchObject({ gateId: 'required-command-manifest' });
    expect(failing.rejection!.reasoning).toBe(`the task requires ${HARNESS} to pass, but its latest host receipt exited 1`);
    // Sucrose holds validate_html, a recorder that runs no command: the
    // coaching must not send it to "the recording tool you hold".
    expect(failing.rejection!.coaching).not.toContain('record_probe');
    expect(failing.rejection!.coaching).not.toContain('recording tool');
    expect(failing.rejection!.coaching).toContain('Run that same command until it exits 0 and quote its host receipt');
    const none = await gate(recorderless, [], false);
    expect(none.rejection!.reasoning).toBe(`the task requires ${HARNESS} to pass, but this attempt holds no host receipt of that exact command`);
    expect(none.rejection!.coaching).toBe(failing.rejection!.coaching);
  });

  it('coaches a child without record_probe to the receipt even where no attestation log reads its runs', async () => {
    const { ctx } = workspace(stale, []);
    const bare = { ...forkBranch(ctx, 'leaf'), attestations: undefined };
    const outcome = await runResultGates(buildResultGateEnv({ task, result: result(), childName: 'Sucrose', childToolNames: recorderless, ctx: bare }), new Set());
    expect(outcome.rejection!.reasoning).toBe(`the task requires ${HARNESS} to pass, but its latest recorded exit code is 1`);
    expect(outcome.rejection!.coaching).not.toContain('record_probe');
    expect(outcome.rejection!.coaching).toContain('quote its host receipt');
  });

  it('is not met by a sibling branch\'s passing run of the command', async () => {
    const { ctx } = workspace(stale, [0]);
    const sibling = forkBranch(ctx, 'sibling');
    const leaf = forkBranch(ctx, 'leaf');
    await sibling.tools!.execute('run_shell', { cmd: HARNESS });
    const outcome = await runResultGates(buildResultGateEnv({ task, result: result(), childName: 'Sucrose', childToolNames: recorderless, ctx: leaf }), new Set());
    expect(outcome.rejection!.reasoning).toBe(`the task requires ${HARNESS} to pass, but this attempt holds no host receipt of that exact command`);
  });

  it('keeps the manifest rule for a holder of record_probe', async () => {
    const holder = await gate(['write_file', 'read_file', 'run_shell', 'record_probe'], [0], true);
    expect(holder.rejection!.reasoning).toBe(`the task requires ${HARNESS} to pass, but its latest recorded exit code is 1`);
    expect(holder.rejection!.coaching).toContain('Run that same command through record_probe until it exits 0');
  });
});
