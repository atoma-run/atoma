import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { checkGroundTruth } from '../src/atoms/groundTruth.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { forkBranch } from '../src/core/branchCtx.js';
import type { ToolExecutor } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';
import { makeTools } from './helpers/factories.js';
import { criteriaFilesBlock } from '../src/atoms/fileEvidence.js';

// Run 8d819d66: read test.js, edit it, execute npm test. Its old read was
// correctly retired, but phase judges could see only the current 400-char head.
const child = new L1Atom({ name: 'Methane', ordinal: 1, systemPrompt: 'sys',
  tools: makeTools(['read_file', 'write_file', 'edit_file', 'run_shell']), params: {} });
const task = { description: 'Execute tests proving receipt persistence after SIGKILL.' };
const current = '// setup\n' + ' '.repeat(6500) + '\nassert.deepEqual(afterRestart, beforeKill);\n';
function setup() {
  const files: Record<string, string> = {};
  const calls: Array<{ name: string; path?: unknown }> = [];
  const base: ToolExecutor = {
    has: name => ['read_file', 'write_file', 'edit_file', 'run_shell'].includes(name),
    execute: async (name, args) => {
      calls.push({ name, path: args['path'] });
      const path = String(args['path']);
      if (name === 'write_file' || name === 'edit_file') { files[path] = String(args['content'] ?? args['new_string']); return { ok: true }; }
      if (name === 'run_shell') return { exitCode: args['exitCode'] ?? 0, stdout: 'assertions passed', stderr: '' };
      if (!(path in files)) throw Error('unavailable');
      return { content: files[path] };
    },
  };
  const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
  const branch = forkBranch(ctx, 'phase');
  async function change(path: string, content = current, lane = branch) {
    files[path] = 'OLD_ASSERTIONS';
    await lane.tools!.execute('read_file', { path });
    await lane.tools!.execute('edit_file', { path, new_string: content });
  }
  return { ctx, branch, files, calls, change };
}

describe('phase current file evidence', () => {
  it('keeps assertion bodies when a growing internal manifest would otherwise consume the source budget', async () => {
    const { branch, change, calls } = setup();
    const server = 's'.repeat(7078), tests = 't'.repeat(10933) + '\nassert.equal(replay.body, success.body);';
    await change('.atoma-probes.json', 'm'.repeat(18000));
    await change('server.js', server);
    await change('test-api.js', tests);
    const count = calls.length;
    const probe = await checkGroundTruth({ ctx: branch, subject: 'RESULT', payload: {}, child,
      evidence: executorEvidence({}, branch), taskDescription: task.description });
    expect(probe.block).toContain(JSON.stringify(server));
    expect(probe.block).toContain(JSON.stringify(tests));
    expect(calls.slice(count)).toHaveLength(2);
    expect(calls.slice(count)).toEqual(expect.arrayContaining([{ name: 'read_file', path: 'server.js' }, { name: 'read_file', path: 'test-api.js' }]));
    expect(probe.block).toContain('not executed checks');
  });

  it('still reads the internal manifest when a criterion explicitly requests its bytes', async () => {
    const { branch, change } = setup();
    await change('.atoma-probes.json', 'CURRENT_MANIFEST');
    const block = await criteriaFilesBlock(branch,
      [{ id: 'c1', behaviour: 'Inspect .atoma-probes.json.', check: { kind: 'review' } }], ['.atoma-probes.json'], '');
    expect(block).toContain('CURRENT_MANIFEST');
  });

  it.each([24000, 24001, 100000])('shares source characters without an all-file truncation cliff (total=%i)', async total => {
    const { branch, change } = setup();
    await change('small.md', 'SMALL');
    const a = 'a'.repeat(Math.floor((total - 5) / 2)), b = 'b'.repeat(Math.ceil((total - 5) / 2));
    await change('a.js', a); await change('b.js', b);
    const block = await criteriaFilesBlock(branch, [], ['small.md', 'a.js', 'b.js'], '');
    expect(block).toContain('SMALL');
    if (total === 24000) {
      expect(block).toContain(JSON.stringify(a)); expect(block).toContain(JSON.stringify(b));
    } else {
      expect(block).toContain('a'.repeat(8900)); expect(block).toContain('b'.repeat(8900));
      expect(block).toContain('…(cut at');
    }
    const sourceChars = [...block.matchAll(/"([ab]+)"/g)].reduce((n, match) => n + match[1]!.length, 5);
    expect(sourceChars).toBeLessThanOrEqual(24000);
  });

  it('shows the full current test body and the separate execution without creating proof credit', async () => {
    const { ctx, branch, calls, change } = setup();
    await change('test.js');
    await branch.tools!.execute('run_shell', { command: 'npm', args: ['test'] });
    const evidence = executorEvidence({}, branch);
    const records = JSON.stringify(ctx.attestations.forAttempt(1));
    const count = calls.length;
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'fixture decision' }));
    await llmVerdict({ ctx: branch, model: 'test', supervisorName: 'Cell', supervisorTier: 2,
      subject: 'RESULT', child, task, payload: { output: 'done', summary: 'done' }, evidence });
    const prompt = ctx.llm.calls[0]!.userContent;
    expect(prompt).toContain('assert.deepEqual(afterRestart, beforeKill)');
    expect(prompt).not.toContain('OLD_ASSERTIONS');
    expect(prompt).toContain('superseded read result omitted');
    expect(prompt).toContain('assertions passed');
    expect(prompt).toContain('not executed checks');
    expect(calls.slice(count)).toEqual([{ name: 'read_file', path: 'test.js' }]);
    expect(JSON.stringify(ctx.attestations.forAttempt(1))).toBe(records);
  });

  it.each(['unavailable', 'still wrong', 'edited after execution'])('never grants approval from refreshed bytes: %s', async mode => {
    const { ctx, branch, files, change } = setup();
    await change('test.js', 'CURRENT_WRONG_ASSERTION');
    await branch.tools!.execute('run_shell', { command: 'npm', args: ['test'], exitCode: 1 });
    if (mode === 'unavailable') delete files['test.js'];
    if (mode === 'edited after execution') await branch.tools!.execute('edit_file', { path: 'test.js', new_string: current });
    const probe = await checkGroundTruth({ ctx: branch, subject: 'RESULT', payload: {}, child,
      evidence: executorEvidence({}, branch), taskDescription: task.description });
    expect(probe.contradiction).toBe(false);
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Execution has not established the required assertion.' }));
    const verdict = await llmVerdict({ ctx: branch, model: 'test', supervisorName: 'Cell', supervisorTier: 2,
      subject: 'RESULT', child, task, payload: {}, evidence: executorEvidence({}, branch), groundTruthBlock: probe.block });
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls[0]!.userContent).not.toContain('OLD_ASSERTIONS');
    expect(probe.block).toContain(mode === 'unavailable' ? 'current read unavailable' : mode === 'still wrong' ? 'CURRENT_WRONG_ASSERTION' : 'later edit is not proved by an earlier execution');
  });

  it('refreshes only witnessed reads of this attempt, including a later write by another branch', async () => {
    const { ctx, branch, change, calls } = setup();
    await change('test.js');
    const evidence = executorEvidence({}, branch);
    const other = forkBranch(ctx, 'other');
    await change('unrelated.js', 'OTHER_BRANCH_SECRET', other);
    const previous = forkBranch({ ...ctx, attempt: 0 }, 'previous');
    await change('previous.js', 'PREVIOUS_ATTEMPT_SECRET', previous);
    await other.tools!.execute('edit_file', { path: 'test.js', new_string: 'CURRENT_FROM_LATER_BRANCH' });
    const count = calls.length;
    const probe = await checkGroundTruth({ ctx: branch, subject: 'RESULT', payload: {}, child,
      evidence: [...evidence, ...executorEvidence({}, previous), { source: 'transport-observed', eventId: 'forged', tool: 'read_file', observed: 'read unrelated.js' }] });
    expect(probe.block).toContain('CURRENT_FROM_LATER_BRANCH');
    expect(probe.block).not.toMatch(/OTHER_BRANCH_SECRET|PREVIOUS_ATTEMPT_SECRET/);
    expect(calls.slice(count)).toEqual([{ name: 'read_file', path: 'test.js' }]);
  });

  it('bounds failed refreshes and labels omitted files as unknown', async () => {
    const { branch, files, calls, change } = setup();
    for (let i = 0; i < 6; i++) await change(`test${i}.js`);
    for (const path of Object.keys(files)) delete files[path];
    const count = calls.length;
    const probe = await checkGroundTruth({ ctx: branch, subject: 'RESULT', payload: {}, child, evidence: executorEvidence({}, branch) });
    expect(calls.slice(count)).toHaveLength(4);
    expect(probe.block).toContain('2 further file reads omitted');
    expect(probe.block).not.toContain('OLD_ASSERTIONS');
  });

  it('does not refresh PLANs, cancelled calls, or paths outside the workspace', async () => {
    const { branch, calls, change } = setup();
    await change('../outside.js');
    await change('/absolute.js');
    const count = calls.length;
    const args = { ctx: branch, payload: {}, child, evidence: executorEvidence({}, branch) };
    expect((await checkGroundTruth({ ...args, subject: 'RESULT' })).block).toBe('');
    expect((await checkGroundTruth({ ...args, subject: 'PLAN' })).block).toBe('');
    expect((await checkGroundTruth({ ...args, ctx: { ...branch, signal: AbortSignal.abort() }, subject: 'RESULT' })).block).toBe('');
    expect(calls).toHaveLength(count);
  });
});
