import { clientQuestionFixture } from '../helpers/clientQuestion.js';
// Separate process: only the provider is mocked; runner, supervision, tools,
// registry credit, checkpoint persistence and final acceptance are production code.
import { mock } from 'node:test';
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as backends from '../../src/run/toolBackend.js';
const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };
import * as providers from '../../src/run/providers.js';
import type { LlmCompletionRequest } from '../../src/core/types.js';
import { ensureCanonicalFullStack } from '../../src/atoms/capability.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../../src/atoms/cost.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { AtomRegistry } from '../../src/registry/atomRegistry.js';
import { RunCheckpointStore, SequentialCheckpoint } from '../../src/run/checkpoint.js';

const root = process.env['CHECKPOINT_TEST_ROOT']!;
let cellName = '';
let leafName = '';
const calls: string[] = [];
const recipe = { id: 'checkpoint-write-file', description: 'Write the requested file',
  whenToUse: 'When asked to write a file', kind: 'llm' as const,
  body: 'Write the file named by the task using write_file and read it back.' };
const complete = async (req: LlmCompletionRequest) => {
  calls.push(`${req.role}:${req.actor?.tier}:${req.actor?.name}`);
  let reply: unknown;
  if (req.actor?.name === 'run-client-question') {
    const phase = process.env['CHECKPOINT_TEST_QUESTION_PHASE'];
    reply = { question: phase !== undefined && req.userContent.includes(`Completed phase count: ${phase}\n`) ? clientQuestionFixture() : null };
  }
  else if (req.actor?.name === 'run-router') reply = { action: 'reuse', name: 'Meristem', reasoning: 'Fixture' };
  else if (req.role === 'draft-checklist') reply = [];
  else if (req.role === 'prefilter' && req.systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT) {
    reply = { kind: 'reuse', target: recipe.id, confidence: 'high', reasoning: 'File recipe' };
  } else if (req.role === 'prefilter') {
    reply = { kind: 'reuse', target: req.actor?.tier === 3 ? cellName : leafName, confidence: 'high', reasoning: 'Reuse' };
  } else if (req.role === 'validate-plan' || req.role === 'validate-result') {
    reply = { approved: true, reasoning: 'Fixture approved', activeSkillFollowed: true };
  } else if (req.role === 'plan' && req.actor?.tier === 3) {
    const questionPhase = process.env['CHECKPOINT_TEST_QUESTION_PHASE'];
    const answering = process.env['CHECKPOINT_TEST_EXPECT_ANSWER'] === '1';
    if (answering && (!req.userContent.includes('Keep both login methods') || !req.userContent.includes('checkpointContinuation'))) {
      throw new Error('Remaining plan did not receive the client answer and continuation scope');
    }
    const files = ['one', 'two'].slice(answering ? Number(questionPhase) : 0);
    const subtasks = files.map(n => ({ description: `Write phase-${n}.txt`, preferredChild: cellName, outputs: [`phase-${n}.txt`] }));
    // Reproduce the production planner that stops its plan at a clarification.
    if (questionPhase !== undefined && !answering) subtasks.splice(Number(questionPhase), subtasks.length,
      { description: 'Ask the client which login methods to keep before writing more files', preferredChild: cellName, outputs: [] });
    reply = [
      { strategy: 'reuse', target: cellName, reasoning: 'Ordered work' },
      { reasoning: 'Remaining phases', delivery: questionPhase === '0' && !answering ? 'text' : 'files',
        subtasks, aggregation: { mode: 'sequential' }, expectedOutput: 'Two files' },
    ];
  }
  else if (req.role === 'plan') reply = { reasoning: 'Write requested file', proposedAction: 'Write file', expectedOutput: 'File' };
  else if (req.role === 'execute') {
    const path = /^Task: Write (phase-(?:one|two)\.txt)/m.exec(req.userContent)?.[1];
    if (!path) throw new Error(`Unexpected fixture task: ${req.userContent.slice(0, 500)}`);
    if (process.env['CHECKPOINT_TEST_EXPECT_ANSWER'] === '1') {
      if (!req.userContent.includes('Keep both login methods')) throw new Error('Client answer was lost before execution');
      writeFileSync(join(root, 'answer-prompt.txt'), req.userContent);
    }
    appendFileSync(join(root, 'effects.log'), `${path}\n`);
    if (process.env['CHECKPOINT_TEST_CRASH'] === 'phase' && path === 'phase-two.txt') process.kill(process.pid, 'SIGKILL');
    if (process.env['CHECKPOINT_TEST_CRASH'] === 'external' && path === 'phase-two.txt') await req.executor!.execute('run_shell', { cmd: 'printf external > effect.txt' });
    const args = { path, content: path };
    const result = await req.executor!.execute('write_file', args);
    req.onToolInvocation?.({ name: 'write_file', args, result, startedAt: Date.now(), durationMs: 0 });
    reply = { output: { files: [path] }, summary: `Wrote ${path}` };
  } else throw new Error(`Unexpected fixture call ${req.role}`);
  return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
};

mock.module(new URL('../../src/run/providers.ts', import.meta.url).href, {
  namedExports: { ...providers, buildTierClients: () => ({ ollama: { complete } }) },
});
if (process.env['CHECKPOINT_TEST_TENANT'] === '1') {
  mock.module(new URL('../../src/run/toolBackend.ts', import.meta.url).href, {
    namedExports: { ...backends, containerToolBackend: async (opts: { workspaceRoot: string }) =>
      backends.localToolBackend({ workspaceRoot: opts.workspaceRoot, logger: nullLogger }) },
  });
}
if (process.env['CHECKPOINT_TEST_REQUEST_PAUSE'] === '1') {
  const planned = SequentialCheckpoint.prototype.planned;
  SequentialCheckpoint.prototype.planned = function (...args) {
    planned.apply(this, args);
    new RunCheckpointStore(process.env['ATOMA_DB_PATH']!).requestPause(this.data.id, this.data.scope!.orgId);
  };
}
if (process.env['CHECKPOINT_TEST_CRASH'] === 'replanned') {
  const planned = SequentialCheckpoint.prototype.planned;
  SequentialCheckpoint.prototype.planned = function (...args) {
    planned.apply(this, args);
    process.kill(process.pid, 'SIGKILL');
  };
}
if (process.env['CHECKPOINT_TEST_CRASH'] === 'boundary') {
  const after = SequentialCheckpoint.prototype.afterPhase;
  SequentialCheckpoint.prototype.afterPhase = async function(index, result) {
    await after.call(this, index, result);
    if (index === 0) process.kill(process.pid, 'SIGKILL');
  };
}
if (['safe', 'external'].includes(process.env['CHECKPOINT_TEST_CRASH'] ?? '')) {
  const client = SequentialCheckpoint.prototype.client;
  SequentialCheckpoint.prototype.client = function(inner) {
    const wrapped = client.call(this, inner);
    return { ...wrapped, complete: async req => {
      const result = await wrapped.complete(req);
      if (req.role === 'execute' && /^Task: Write phase-two\.txt/m.test(req.userContent)) process.kill(process.pid, 'SIGKILL');
      return result;
    } };
  };
}
if (process.env['CHECKPOINT_TEST_CRASH'] === 'credit') {
  const credit = AtomRegistry.prototype.recordSuccess;
  AtomRegistry.prototype.recordSuccess = function(...args) {
    credit.apply(this, args);
    if (existsSync(join(root, 'effects.log')) && readFileSync(join(root, 'effects.log'), 'utf8').includes('phase-two')) process.kill(process.pid, 'SIGKILL');
  };
}
const { startTask } = await import('../../src/run/runner.js');
try {
  const handle = await startTask(process.argv.slice(2), { seedCatalog(seed, canonical) {
    canonical(seed);
    const leaf = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 1)!;
    leafName = leaf.name;
    cellName = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 2)!.name;
    const skills = new SkillRegistry(process.env['ATOMA_SKILLS_DIR']);
    if (process.env['CHECKPOINT_TEST_NO_SKILL'] !== '1' && skills.loadFor(leaf.atomId).length === 0) skills.save(leaf.atomId, recipe);
  } });
  const outcome = await handle.settled;
  await handle.shutdown();
  writeFileSync(join(root, 'report.json'), JSON.stringify({ ...outcome, checkpointId: handle.checkpointId, calls }));
  process.exit(outcome.outcome === 'failed' ? 1 : 0);
} catch (error) {
  console.error(error);
  process.exit(2);
}
