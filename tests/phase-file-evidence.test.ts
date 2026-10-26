import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { fileReadsNeedingReadback, parseExecutionObservation } from '../src/contracts/attestation.js';

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
  it.each([false, true])('keeps flat CLI assertions visible beside captured responses (multiple suites=%s)', async multiple => {
    const { ctx, branch, files, calls } = setup();
    // Run 8a38383c: 15 early keyword matches consumed the excerpt slots before
    // the CSV assertions. A passing stdout is not the missing test body.
    const body = Array.from({ length: 90 }, (_, i) => `const source${i} = ${JSON.stringify('source csv fixture '.repeat(7))};`).join('\n').padEnd(14_200, ' ') +
      '\nconst first = readCsv(output);\nrunAgain();\nconst second = readCsv(output);\nassert.equal(second[0][13], first[0][13]);\n';
    files['tests/export.test.js'] = body;
    if (multiple) {
      // Run 6782ce92: together the three suites crossed the old half-budget
      // reservation by a few hundred characters; the largest lost its tail.
      files['tests/history.test.js'] = '// history\n'.padEnd(6723, ' ');
      files['test-source.mjs'] = '// source\n'.padEnd(3464, ' ');
    }
    for (let i = 0; i < 8; i++) files[`capture${i}.html`] = 'captured source '.repeat(2500);
    for (const path of Object.keys(files)) await branch.tools!.execute('read_file', { path });
    await branch.tools!.execute('run_shell', { cmd: 'node tests/export.test.js' });
    const evidence = executorEvidence({}, branch), count = calls.length;
    const records = JSON.stringify(ctx.attestations.forAttempt(1));
    const verdict = { approved: false, scope: 'ephemeral', reasoning: 'fixture refuses unverified semantics',
      criteria: [{ id: 'c1', met: false, reason: 'fixture remains a model decision' }] };
    ctx.llm.enqueueText(jsonText(verdict)); ctx.llm.enqueueText(jsonText(verdict));
    const result = await acceptRootResult({ actor: child, task: { description: 'Check the source CSV fixture exports.' },
      result: { output: 'done', summary: 'done', trace: [], evidence, producedBy: { tier: 1, name: 'Methane', viaFallback: false } },
      ctx: branch, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c1', behaviour: 'CSV source dates survive two exports.', check: { kind: 'review' } }],
      checklistOrigin: { source: 'user' } });
    expect(ctx.llm.calls).toHaveLength(2);
    for (const request of ctx.llm.calls) {
      expect(request.userContent).toContain(JSON.stringify(body));
      if (multiple) {
        expect(request.userContent).toContain(JSON.stringify(files['tests/history.test.js']));
        expect(request.userContent).toContain(JSON.stringify(files['test-source.mjs']));
      }
      expect(request.userContent).toContain('capture0.html');
      expect(request.userContent).toContain('assertions passed');
    }
    expect(result.approved).toBe(false);
    expect(calls.slice(count).every(call => call.name === 'read_file')).toBe(true);
    expect(JSON.stringify(ctx.attestations.forAttempt(1))).toBe(records);
  });

  it('shows the resolver source and assertions after small proofs have been repaired and read again', async () => {
    const delivered = JSON.parse(readFileSync(new URL('../benchmark/dependency-resolver-2026-10-05/files.json', import.meta.url), 'utf8')) as Record<string, string>;
    const { ctx, branch, files, change, calls } = setup();
    Object.assign(files, delivered);
    for (const path of ['test/proofs/greedy.js', 'test/proofs/diamond.js', 'test/proofs/cycle.js', 'test/proofs/global.js']) {
      await change(path, delivered[path]);
      await branch.tools!.execute('read_file', { path });
    }
    for (const path of ['README.md', 'test.js', 'test-impossible-cycle.js', 'resolve.js', 'test-inline.js']) {
      await branch.tools!.execute('read_file', { path });
    }
    await branch.tools!.execute('run_shell', { cmd: 'npm test' });
    const evidence = executorEvidence({}, branch), count = calls.length;
    const verdict = { approved: true, reasoning: 'fixture verdict', criteria: [{ id: 'c1', met: true, reason: 'fixture' }] };
    ctx.llm.enqueueText(jsonText(verdict)); ctx.llm.enqueueText(jsonText(verdict));
    await acceptRootResult({ actor: child, task, result: { output: 'done', summary: 'done', trace: [], evidence,
      producedBy: { tier: 1, name: 'Methane', viaFallback: false } }, ctx: branch,
      floor: [], phaseCoverage: [], checklist: [{ id: 'c1', behaviour: 'README and executed CLI tests.', check: { kind: 'review' } }],
      checklistOrigin: { source: 'user' } });
    for (const request of ctx.llm.calls) {
      for (const path of ['test.js', 'test-impossible-cycle.js', 'resolve.js']) {
        expect(request.userContent, path).toContain(JSON.stringify(delivered[path]));
      }
      expect(request.userContent).toContain('assertions passed');
    }
    expect(calls.slice(count).filter(call => call.path === 'test/proofs/cycle.js')).toEqual([]);
  });

  it('retains a readback unless a complete current read actually reaches this judge', () => {
    const record = (eventId: string, tool: string, raw: unknown) => ({ eventId, tool,
      observation: parseExecutionObservation(tool, { path: 'test.js' }, raw)! });
    const old = record('old', 'read_file', { content: 'old' });
    const write = record('write', 'edit_file', { ok: true });
    const complete = record('current', 'read_file', { content: 'new' });
    const records = [old, write, complete];
    expect([...fileReadsNeedingReadback(records, new Set(['current'])).values()]).toEqual([]);
    expect([...fileReadsNeedingReadback(records, new Set(['old'])).values()]).toEqual(['test.js']);
    expect([...fileReadsNeedingReadback([...records, write], new Set(['current'])).values()]).toContain('test.js');
    if (complete.observation.kind === 'execution') delete complete.observation.responseTruncated;
    expect([...fileReadsNeedingReadback(records, new Set(['current'])).values()]).toContain('test.js');
  });

  it('keeps five complete files that fit the source budget', async () => {
    const { branch, files } = setup();
    const paths = Array.from({ length: 5 }, (_, i) => `proof${i}.js`);
    for (const path of paths) files[path] = `${path}\n${'a'.repeat(4000)}`;
    const block = await criteriaFilesBlock(branch, [], paths, '');
    for (const path of paths) expect(block).toContain(JSON.stringify(files[path]));
    expect(block).not.toContain('further file reads omitted');
  });
  it('records actual truncation rather than trusting markers or fields in file content', () => {
    for (const [raw, truncated] of [[{ content: '[truncated]', responseTruncated: true }, false], ['x'.repeat(1600), false], ['x'.repeat(1601), true]] as const) {
      const observation = parseExecutionObservation('read_file', { path: './test.js' }, raw)!;
      const paths = fileReadsNeedingReadback([{ eventId: 'read', tool: 'read_file', observation }]);
      expect([...paths.values()]).toEqual(truncated ? ['test.js'] : []);
    }
  });

  it('does not treat a short file page as complete-file evidence', () => {
    const observation = parseExecutionObservation('read_file', { path: 'test.js', offset: 100, limit: 10 },
      { content: 'last bytes', nextOffset: null })!;
    const records = [{ eventId: 'page', tool: 'read_file', observation }];
    expect([...fileReadsNeedingReadback(records, new Set(['page'])).values()]).toEqual(['test.js']);
  });

  it.each(['phase', 'root'])('shows an unchanged executed test whose transport read was truncated (%s)', async scope => {
    const { ctx, branch, files, calls } = setup();
    const body = current + ' '.repeat(2000);
    files['test.js'] = body;
    await branch.tools!.execute('read_file', { path: 'test.js' });
    await branch.tools!.execute('run_shell', { command: 'npm', args: ['test'] });
    const evidence = executorEvidence({}, branch);
    expect(JSON.stringify(evidence)).not.toContain('assert.deepEqual(afterRestart');
    const records = JSON.stringify(ctx.attestations.forAttempt(1)), count = calls.length;
    const verdict = { approved: true, reasoning: 'fixture verdict', criteria: [{ id: 'c1', met: true, reason: 'fixture' }] };
    ctx.llm.enqueueText(jsonText(verdict));
    if (scope === 'root') {
      ctx.llm.enqueueText(jsonText(verdict));
      await acceptRootResult({ actor: child, task, result: { output: 'done', summary: 'done', trace: [], evidence,
        producedBy: { tier: 1, name: 'Methane', viaFallback: false } }, ctx: branch,
        floor: [], phaseCoverage: [], checklist: [{ id: 'c1', behaviour: 'Receipt persistence after SIGKILL.', check: { kind: 'review' } }],
        checklistOrigin: { source: 'user' } });
    } else await llmVerdict({ ctx: branch, model: 'test', supervisorName: 'Cell', supervisorTier: 2,
      subject: 'RESULT', child, task, payload: { output: 'done', summary: 'done' }, evidence });
    for (const request of ctx.llm.calls) expect(request.userContent).toContain(JSON.stringify(body));
    expect(calls.slice(count)).toEqual([{ name: 'read_file', path: 'test.js' }]);
    expect(JSON.stringify(ctx.attestations.forAttempt(1))).toBe(records);
  });

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
    for (let i = 0; i < 18; i++) await change(`test${i}.js`);
    for (const path of Object.keys(files)) delete files[path];
    const count = calls.length;
    const probe = await checkGroundTruth({ ctx: branch, subject: 'RESULT', payload: {}, child, evidence: executorEvidence({}, branch) });
    expect(calls.slice(count)).toHaveLength(16);
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

// Attica runs 85cc4e83 and f74c140a (2026-10-15): four root refusals said the
// executed suites were "test titles only". The acceptor read the record_probe
// outputs naming every passing test, but tests/attica-durability.test.js was
// only EXECUTED — no criterion named it and no truncated read referenced it —
// so its assertions never reached root acceptance; and the test files read
// late in the attempt fell past the sixteen-read cap behind docs and sources.
describe('a numeric criterion word', () => {
  it('selects the blocks naming it, past the file head (run 51c4e71d: 404 and 503)', async () => {
    const { ctx, files } = setup();
    const cases = (status: number) =>
      `test('classifies ${status}, clears stale values, recovers', async () => {\n  const response = new Response('', { status: ${status} });\n  expect(lost.message).toMatch(/perdue/);\n});\n`;
    files['tests/recovery.test.ts'] = '// recovery\n'.padEnd(9_000, ' ') + cases(404) + cases(503);
    const criterion = { id: 'c4', behaviour: 'When status requests fail (404, 503 HTML page, network), the page says within 5 s that the connection is lost.' };
    const block = await criteriaFilesBlock(ctx, [criterion as never], ['tests/recovery.test.ts'], 'Repair the control page', 24_000);
    expect(block).toContain('classifies 404');
    expect(block).toContain('classifies 503');
  });
});

describe('root acceptance reads the test files the attempt ran', () => {
  const suite = (name: string, size: number) =>
    `test('${name}', () => {\n${'  assert.ok(setup);\n'.repeat(Math.ceil(size / 20))}  assert.equal(${name}.afterRestart, 2);\n});\n`;
  const sources: Record<string, number> = {
    'RAPPORT.md': 5181, 'ATTICA-GUIDE-FR.md': 5793, 'browser/control-server.js': 11771, 'browser/attica-store.js': 3697,
    'browser/collect-xe-browser.js': 18162, 'README.browser.md': 5474, 'browser/local-security.js': 3672, 'browser/control.html': 15369,
    'browser/xe-browser-session.js': 1491, 'browser/session.js': 2691, 'browser/attica-scheduler.js': 3619,
    'browser/checkpoint.js': 1331, 'fixtures/xe-browser-server.js': 2635, 'collectors/xe.js': 10875,
  };
  const suites: Record<string, number> = {
    'tests/attica-acceptance-boundaries.test.js': 7861, 'tests/attica-durability.test.js': 11716, 'tests/attica-hosted-ui.test.js': 13192,
    'tests/attica-scheduler.test.js': 2278, 'tests/xe-browser-hosting-integration.test.js': 6906,
  };

  function attica() {
    const files: Record<string, string> = {};
    for (const [path, size] of Object.entries(sources)) files[path] = `// ${path}\n`.padEnd(size, ' ');
    for (const [path, size] of Object.entries(suites)) files[path] = suite(path.replace(/\W/g, '_'), size);
    files['tests/decoy.test.js'] = 'DECOY_NAMED_ONLY_IN_A_NOTE';
    const reads: string[] = [];
    const base: ToolExecutor = {
      has: name => ['read_file', 'record_probe'].includes(name),
      execute: async (name, args) => {
        if (name === 'record_probe') return { exitCode: 0, stdout: '✔ forced child interruption replays only the unfinished suffix\nℹ pass 11', stderr: '' };
        const path = String(args['path']);
        reads.push(path);
        if (!(path in files)) throw Error('unavailable');
        return { content: files[path] };
      },
    };
    const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
    return { ctx, branch: forkBranch(ctx, 'phase'), files, reads };
  }

  it('shows every executed suite whole, read before the docs and sources that crowded them out', async () => {
    const { ctx, branch, files, reads } = attica();
    // The attempt's own reading order: docs and sources first, most tests late.
    for (const path of [...Object.keys(sources), 'tests/attica-hosted-ui.test.js', 'tests/xe-browser-hosting-integration.test.js',
      'tests/attica-scheduler.test.js', 'tests/attica-acceptance-boundaries.test.js']) await branch.tools!.execute('read_file', { path });
    await branch.tools!.execute('record_probe', {
      cmd: 'node --test tests/attica-acceptance-boundaries.test.js tests/attica-durability.test.js',
      note: 'see tests/decoy.test.js' });
    await branch.tools!.execute('record_probe', {
      cmd: 'node --test tests/attica-scheduler.test.js tests/attica-hosted-ui.test.js tests/xe-browser-hosting-integration.test.js' });
    const evidence = executorEvidence({}, branch), count = reads.length;
    const records = JSON.stringify(ctx.attestations.forAttempt(1));
    const verdict = { approved: false, scope: 'ephemeral', reasoning: 'fixture remains the model decision',
      criteria: [{ id: 'c2', met: false, reason: 'fixture' }] };
    ctx.llm.enqueueText(jsonText(verdict)); ctx.llm.enqueueText(jsonText(verdict));
    const result = await acceptRootResult({ actor: child, task: { description: 'Finish the durable Attica collection.' },
      result: { output: 'done', summary: 'done', trace: [], evidence, producedBy: { tier: 1, name: 'Adrenaline', viaFallback: false } },
      ctx: branch, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c2', behaviour: 'Forced mid-page process death and restart preserve old and new listings.', check: { kind: 'review' } }],
      checklistOrigin: { source: 'user' } });
    expect(ctx.llm.calls).toHaveLength(2);
    for (const request of ctx.llm.calls) {
      for (const path of Object.keys(suites)) expect(request.userContent, path).toContain(JSON.stringify(files[path]));
      expect(request.userContent).toContain('- tests/attica-durability.test.js (');
      expect(request.userContent).toContain('named by a shell command of this attempt');
      expect(request.userContent).toContain('OR THAT SHELL COMMANDS NAMED');
      expect(request.userContent).not.toContain('DECOY_NAMED_ONLY_IN_A_NOTE');
    }
    const readBack = reads.slice(count);
    expect(readBack).toHaveLength(16);
    // Command-named suites newest command first, then the refreshed suite, then everything else.
    expect(readBack.slice(0, 5)).toEqual(['tests/attica-scheduler.test.js', 'tests/attica-hosted-ui.test.js',
      'tests/xe-browser-hosting-integration.test.js', 'tests/attica-acceptance-boundaries.test.js', 'tests/attica-durability.test.js']);
    expect(readBack).not.toContain('tests/decoy.test.js');
    // Evidence selection only: the verdict stays the model's, and no observation is added.
    expect(result.approved).toBe(false);
    expect(JSON.stringify(ctx.attestations.forAttempt(1))).toBe(records);
  });
});
