import { mockOtherProofReview } from '../helpers/delegationReview.js';
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
import { startWorkspaceProcess } from '../../src/run/workspaceProcess.js';

const root = process.env['CHECKPOINT_TEST_ROOT']!;
let cellName = '';
let leafName = '';
const calls: string[] = [];
// The root delegation reviews (tier-3 actor reviewing its own plan), apart
// from `calls`, so existing call assertions are untouched.
let rootReviews = 0;
let historicalRead = false;
const PERSISTING_SERVER = "const s=require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT)||0,function(){console.log('LISTENING_ON_PORT='+this.address().port)});" +
  "process.on('SIGTERM',()=>{require('fs').writeFileSync('notes.json','[]');process.exit(0)});";
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
  } else if (req.role === 'validate-plan' && req.actor?.tier === 3 && req.child?.tier === 3) {
    rootReviews++;
    const refuse = process.env['CHECKPOINT_TEST_REFUSE_ROOT_REVIEW'];
    const proof = mockOtherProofReview(req);
    if (refuse === 'always' || (refuse === 'first' && rootReviews === 1)) {
      reply = { approved: false, reasoning: 'Fixture refuses the saved plan', scope: 'ephemeral', modifications: {} };
    } else if (process.env['CHECKPOINT_TEST_ROOT_FAN_OUT'] === '1' && 'delegationReview' in proof) {
      reply = { approved: true, reasoning: 'Fixture finds independent work', delegationReview: { ...proof.delegationReview, independentWork: true } };
    } else {
      reply = { approved: true, reasoning: 'Fixture approved', ...proof };
    }
  } else if (req.actor?.name === 'run-root' && process.env['CHECKPOINT_TEST_ROOT_BAD_READ'] === '1') {
    reply = { readEvidence: [{ eventId: 'unknown' }], approved: true, reasoning: 'Invalid mixed reply' };
  } else if (req.actor?.name === 'run-root' && process.env['CHECKPOINT_TEST_READ_HISTORY'] === '1' && req.userContent.includes('"recordedBeforeRestart":true')) {
    if (req.userContent.includes('CHECKPOINT_FULL_PROOF')) {
      historicalRead = true;
      if (!req.userContent.includes('not current execution or current file contents')) throw new Error('Historical body lost its freshness warning');
      reply = { approved: true, reasoning: 'Historical context read; current delivery judged separately.' };
    } else {
      const entries = req.userContent.split('\n').filter(line => line.startsWith('{"inventory":'))
        .flatMap(line => (JSON.parse(line) as { inventory: Array<{ eventId: string; recordedBeforeRestart: boolean }> }).inventory);
      const prior = entries.find(entry => entry.recordedBeforeRestart);
      if (!prior) throw new Error('Checkpoint archive was not offered');
      reply = { readEvidence: [{ eventId: prior.eventId, find: 'CHECKPOINT_FULL_PROOF', length: 200 }] };
    }
  } else if (req.role === 'validate-plan' || req.role === 'validate-result') {
    reply = { approved: true, reasoning: 'Fixture approved', activeSkillFollowed: true, ...mockOtherProofReview(req) };
  } else if (req.role === 'plan' && req.actor?.tier === 3) {
    const questionPhase = process.env['CHECKPOINT_TEST_QUESTION_PHASE'];
    const answering = process.env['CHECKPOINT_TEST_EXPECT_ANSWER'] === '1';
    if (answering && (!req.userContent.includes('Keep both login methods') || !req.userContent.includes('checkpointContinuation'))) {
      throw new Error('Remaining plan did not receive the client answer and continuation scope');
    }
    // A continuation replans only the phases after the completed prefix.
    const continued = req.userContent.includes('checkpointContinuation')
      ? Number(/"completedPhaseCount":(\d+)/.exec(req.userContent)?.[1] ?? 'NaN') : 0;
    if (Number.isNaN(continued)) throw new Error('Continuation plan request did not carry its completed phase count');
    const files = ['one', 'two'].slice(answering ? Number(questionPhase) : continued);
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
    const args = { path, content: process.env['CHECKPOINT_TEST_LARGE_EVIDENCE'] === '1' && path === 'phase-one.txt'
      ? path + 'a'.repeat(210000) + 'CHECKPOINT_FULL_PROOF' : path };
    const result = await req.executor!.execute('write_file', args);
    if (process.env['CHECKPOINT_TEST_SERVER'] === '1' && path === 'phase-one.txt') {
      // The phase leaves a real server that persists its state on SIGTERM (code review 2026-10-09, 1.1).
      await req.executor!.execute('write_file', { path: 'server.js', content: PERSISTING_SERVER });
      const started = JSON.stringify(await req.executor!.execute('start_node_server', { entry: 'server.js' }));
      if (!started.includes('http://')) throw new Error(`Fixture server did not start: ${started}`);
    }
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
      ({ ...backends.localToolBackend({ workspaceRoot: opts.workspaceRoot, logger: nullLogger }),
        ...(process.env['CHECKPOINT_TEST_CAPTURE_COMPUTE'] === '1' ? { provenance: 'customer-device' as const } : {}) }) },
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
const workspaceService = process.env['CHECKPOINT_TEST_WORKSPACE_PROCESS'] === '1'
  ? startWorkspaceProcess({ root: process.env['ATOMA_BUILD_WORKSPACE']! }) : undefined;
try {
  const handle = await startTask(process.argv.slice(2), { workspaceRuntime: workspaceService?.runtime, seedCatalog(seed, canonical) {
    canonical(seed);
    const leaf = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 1)!;
    leafName = leaf.name;
    cellName = ensureCanonicalFullStack(seed.registry, seed.toolDecls, 2)!.name;
    const skills = new SkillRegistry(process.env['ATOMA_SKILLS_DIR']);
    if (process.env['CHECKPOINT_TEST_NO_SKILL'] !== '1' && skills.loadFor(leaf.atomId).length === 0) skills.save(leaf.atomId, recipe);
  } });
  const outcome = await handle.settled;
  await handle.shutdown();
  await workspaceService?.close();
  writeFileSync(join(root, 'report.json'), JSON.stringify({ ...outcome, checkpointId: handle.checkpointId, calls, rootReviews, historicalRead }));
  process.exit(outcome.outcome === 'failed' ? 1 : 0);
} catch (error) {
  await workspaceService?.close();
  console.error(error);
  writeFileSync(join(root, 'error-report.json'), JSON.stringify({ calls, rootReviews }));
  process.exit(2);
}
