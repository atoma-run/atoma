import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { checkGroundTruth } from '../src/atoms/groundTruth.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { forkBranch } from '../src/core/branchCtx.js';
import type { ToolExecutor } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { makeTools } from './helpers/factories.js';

// Run 51c4e71d (2026-10-26): two cells wrote in parallel on one workspace.
// One ran `npm run lint` while its sibling's files were mid-edit, the probe
// manifest kept that exit 1 as the command's latest result, and the tissue
// refused the SIBLING's phase on "the latest npm run lint is exitCode 1".
const child = new L1Atom({ name: 'Methane', ordinal: 1, systemPrompt: 'sys',
  tools: makeTools(['read_file', 'write_file', 'record_probe', 'run_shell']), params: {} });

describe('a failing manifest entry a parallel branch recorded', () => {
  it('is attributed to that branch for the sibling\'s validator, never for its own or for the trunk', async () => {
    const manifest = JSON.stringify({ version: 1, entries: [
      { cmd: 'npm run lint', exitCode: 1, stdout: '', stderr: '3 problems' },
      { cmd: 'npm run check', exitCode: 1, stdout: '', stderr: 'lint failed' },
    ] });
    const base: ToolExecutor = {
      has: name => ['read_file', 'write_file', 'record_probe', 'run_shell'].includes(name),
      execute: async (name, args) => name === 'read_file'
        ? { path: args['path'], content: manifest }
        : { exitCode: 1, stdout: '', stderr: '3 problems' },
    };
    const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
    const sibling = forkBranch(ctx, 'sibling');
    const judged = forkBranch(ctx, 'judged');
    await judged.tools!.execute('record_probe', { cmd: 'npm run check', note: 'own check' });
    await sibling.tools!.execute('record_probe', { cmd: 'npm run lint', note: 'mid-edit' });
    const payload = { output: { probes: [{ cmd: 'npm run check', exitCode: 1 }] }, summary: 'checked' };

    const own = await checkGroundTruth({ ctx: judged, subject: 'RESULT', payload, child, evidence: executorEvidence({}, judged) });
    expect(own.block).toContain('"npm run lint" (exitCode=1): this stored outcome was recorded by branch');
    // Its own failing command is its own: no attribution line.
    expect(own.block).not.toContain('"npm run check" (exitCode=1): this stored outcome was recorded by branch');

    // From the sibling's side the roles swap: its own lint is its own, the judged branch's check is the parallel one.
    const self = await checkGroundTruth({ ctx: sibling, subject: 'RESULT', payload, child, evidence: executorEvidence({}, sibling) });
    expect(self.block).not.toContain('"npm run lint" (exitCode=1): this stored outcome was recorded by branch');
    expect(self.block).toContain('"npm run check" (exitCode=1): this stored outcome was recorded by branch');

    const trunk = await checkGroundTruth({ ctx, subject: 'RESULT', payload, child, evidence: executorEvidence({}, judged) });
    expect(trunk.block).not.toContain('recorded by branch');
  });

  it('never blames a sibling for a shell rerun or an outcome its record does not hold', async () => {
    const manifest = JSON.stringify({ version: 1, entries: [{ cmd: 'npm run lint', exitCode: 1, stdout: '', stderr: '3 problems' }] });
    let exit = 1;
    const base: ToolExecutor = {
      has: name => ['read_file', 'write_file', 'record_probe', 'run_shell'].includes(name),
      execute: async (name, args) => name === 'read_file' ? { path: args['path'], content: manifest } : { exitCode: exit, stdout: '', stderr: '' },
    };
    const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
    const sibling = forkBranch(ctx, 'sibling');
    const judged = forkBranch(ctx, 'judged');
    const payload = { output: { probes: [{ cmd: 'npm run lint', exitCode: 1 }] }, summary: 'linted' };
    // The judged branch wrote the failing entry; the sibling only re-ran it through run_shell.
    await judged.tools!.execute('record_probe', { cmd: 'npm run lint' });
    exit = 0;
    await sibling.tools!.execute('run_shell', { cmd: 'npm run lint' });
    const rerun = await checkGroundTruth({ ctx: judged, subject: 'RESULT', payload, child, evidence: [] });
    expect(rerun.block).not.toContain('recorded by branch');
    // A sibling record_probe whose exit code differs from the stored entry is not its author.
    await sibling.tools!.execute('record_probe', { cmd: 'npm run lint' });
    const mismatch = await checkGroundTruth({ ctx: judged, subject: 'RESULT', payload, child, evidence: [] });
    expect(mismatch.block).not.toContain('recorded by branch');
  });
});
