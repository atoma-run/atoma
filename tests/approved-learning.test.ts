import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningQueue } from '../src/skills/learningQueue.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { withPartialUsage } from '../src/core/metrics.js';
import { openDb } from '../src/registry/db.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { executeApprovedLearning } from '../src/run/learning.js';
import { spawnApprovedLearning } from '../src/run/learningProcess.js';
import { deploymentBlockers } from '../src/cli/deploy-preflight.js';
import { registerDeploymentPending } from '../src/mcp/runLock.js';
import type { LearningJob } from '../src/contracts/skillLearning.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(twoOwners = false) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-approved-learning-'));
  roots.push(root);
  const dbPath = join(root, 'store.db');
  openDb(dbPath).close();
  const model = 'api:ollama:qwen3.5:9b';
  const job: LearningJob = { version: 1, runId: randomUUID(), approvedAt: new Date().toISOString(),
    skillsPath: join(root, 'skills'), runsPath: join(root, 'runs'), model,
    policy: { promote: '1' }, budget: { tokens: 10000, costUsd: 1 },
    lessons: [{ kind: 'task', owner: randomUUID(), host: { name: 'Companion', model, params: {}, systemPrompt: 'Author recipes.' },
      task: 'Read the entry file', summary: 'Read and checked the entry file',
      childName: 'Water', childTools: ['read_file'], hostTools: ['read_file'],
      successfulToolAction: true, recordedCommandProbes: false }],
  };
  if (twoOwners) job.lessons.push({ ...job.lessons[0]!, owner: randomUUID() });
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'],
    ATOMA_MODEL_L1: model, ATOMA_MODEL_L2: model, ATOMA_MODEL_L3: model, ATOMA_JEV: '0',
    ATOMA_MCP_RUN_LOCK: join(root, 'lease.db'), HOME: root, USERPROFILE: root };
  const queue = new LearningQueue(dbPath);
  queue.enqueue(job);
  return { root, dbPath, job, env, queue };
}

const recipe = { id: 'read-entry-file', description: 'Read an entry file', when_to_use: 'Read an entry file', body: '1. read_file <entry>.' };

describe('approved learning outside delivery', () => {
  it('reads project storage in a fresh process without importing the learning worker or providers', () => {
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        if (/\\/(?:learningQueue|learningProcess|providers)\\.(?:ts|js)$/.test(resolved.url)) {
          throw new Error('Project storage loaded execution machinery: ' + resolved.url);
        }
        return resolved;
      } });
      const { ProjectStore } = await import(${JSON.stringify(new URL('../src/projects/store.ts', import.meta.url).href)});
      if (typeof ProjectStore !== 'function') throw new Error('ProjectStore did not load');
    `;
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script],
      { encoding: 'utf8', timeout: 10_000 })).not.toThrow();
  });

  it('crosses the real worker boundary, persists usage and keeps compilation at learn', async () => {
    const { root, dbPath, job, env, queue } = fixture();
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(requests.length === 1 ? recipe : { promotable: false, reason: 'Fixture: needs interpretation' }) },
          done: true, prompt_eval_count: 11, eval_count: 7 }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture listener');
    try {
      await spawnApprovedLearning(dbPath, job, { ...env, OLLAMA_BASE_URL: `http://127.0.0.1:${address.port}` });
      expect(queue.receipt(job.runId)).toMatchObject({ status: 'completed', completedLessons: 1, llmCalls: 2, inputTokens: 22, outputTokens: 14 });
      const db = openDb(dbPath);
      try {
        const skills = new SkillRegistry(job.skillsPath, { db }).loadFor(job.lessons[0]!.owner);
        expect(skills).toHaveLength(1);
        expect(skills[0]).toMatchObject({ kind: 'llm', promotionRefusedReason: 'Fixture: needs interpretation',
          provenance: { learning: { runId: job.runId, lessonIndex: 0 } } });
      } finally { db.close(); }
      const traces = readdirSync(join(job.runsPath, 'learning')).filter(name => name.endsWith('.json') && name !== 'index.json');
      const trace = JSON.parse(readFileSync(join(job.runsPath, 'learning', traces[0]!), 'utf8')) as { events: Array<{ kind: string; role?: string }> };
      expect(trace.events.filter(event => event.kind === 'llm').map(event => event.role)).toEqual(['skill', 'skill']);
      expect(deploymentBlockers({ dbPath, runLockPath: join(root, 'lease.db') })).toEqual([]);
      await spawnApprovedLearning(dbPath, job, env);
      expect(requests).toHaveLength(2); // Completed jobs are never paid a second time.
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('recovers unstarted work, retains uncertain lessons, and requires an explicit retry', () => {
    const { root, dbPath, job, queue } = fixture();
    expect(queue.claim(job.runId)).toBe(true);
    expect(deploymentBlockers({ dbPath, runLockPath: join(root, 'lease.db') })).toContain('1 approved learning job(s) are running');
    queue.recover(() => false);
    expect(queue.receipt(job.runId)?.status).toBe('pending');
    expect(queue.claim(job.runId)).toBe(true);
    queue.startLesson(job.runId, 0);
    queue.callStarted(job.runId);
    queue.recover(() => false);
    expect(queue.receipt(job.runId)).toMatchObject({ status: 'interrupted', completedLessons: 0 });
    expect(queue.pending()).toEqual([]);
    expect(queue.get(job.runId)).toEqual(job);
    expect(queue.retry(job.runId)).toBe(true);
    expect(queue.receipt(job.runId)?.retries).toEqual([{ at: expect.any(String), actorType: 'cli' }]);
    expect(queue.pending()).toEqual([job]);
  });

  it('never changes a saved model or payer and retains the refused job', async () => {
    const { dbPath, job, env, queue } = fixture();
    const complete = vi.fn();
    await expect(executeApprovedLearning(dbPath, job.runId, { ...env, ATOMA_MODEL_L2: 'api:openai:gpt-5.6-sol' }, { client: { complete } }))
      .rejects.toThrow('original model and payer');
    expect(complete).not.toHaveBeenCalled();
    expect(queue.receipt(job.runId)?.status).toBe('pending');
  });

  it('blocks learning until final run accounting authorizes a remaining budget', async () => {
    const { dbPath, job, env, queue } = fixture();
    vi.stubEnv('ATOMA_MCP_RUN_LOCK', env['ATOMA_MCP_RUN_LOCK']);
    queue.setBudget(job.runId, { tokens: 0, costUsd: 0 });
    const complete = vi.fn();
    await executeApprovedLearning(dbPath, job.runId, env, { client: { complete } });
    expect(complete).not.toHaveBeenCalled();
    expect(queue.receipt(job.runId)?.status).toBe('blocked');
  });

  it.each(['pending', 'frozen'] as const)('yields if deployment becomes %s between admission and the claim', async state => {
    const { root, dbPath, job, env, queue } = fixture();
    vi.stubEnv('ATOMA_MCP_RUN_LOCK', env['ATOMA_MCP_RUN_LOCK']);
    env['ATOMA_DEPLOY_LOCK_PATH'] = join(root, 'deploy.lock');
    let pending: ReturnType<typeof registerDeploymentPending> | undefined;
    const complete = vi.fn();
    try {
      await executeApprovedLearning(dbPath, job.runId, env, { client: { complete }, onClaim: () => {
        expect(queue.receipt(job.runId)?.status).toBe('running');
        if (state === 'pending') pending = registerDeploymentPending('deployment:fixture', env['ATOMA_MCP_RUN_LOCK']);
        else writeFileSync(env['ATOMA_DEPLOY_LOCK_PATH']!, 'deploying');
      } });
      expect(complete).not.toHaveBeenCalled();
      expect(queue.receipt(job.runId)).toMatchObject({ status: 'pending', completedLessons: 0, llmCalls: 0 });
    } finally { pending?.release(); }
  });

  it('retains an interrupted lesson after the actual worker is killed, without a second request', async () => {
    const { dbPath, job, env, queue } = fixture();
    let reached!: () => void;
    const requestStarted = new Promise<void>(resolve => { reached = resolve; });
    let requests = 0;
    const server = createServer(req => {
      req.resume();
      req.on('end', () => { requests++; reached(); }); // A paid request may outlive its caller.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture listener');
    let childPid: number | undefined;
    const finished = spawnApprovedLearning(dbPath, job, { ...env, OLLAMA_BASE_URL: `http://127.0.0.1:${address.port}` })
      .catch(error => error as Error);
    try {
      await requestStarted;
      childPid = (queue.db.prepare('SELECT pid FROM skill_learning_jobs WHERE run_id = ?').get(job.runId) as { pid: number }).pid;
      process.kill(childPid, 'SIGKILL');
      await finished;
      childPid = undefined;
      expect(queue.receipt(job.runId)).toMatchObject({ status: 'interrupted', completedLessons: 0 });
      await spawnApprovedLearning(dbPath, job, env);
      expect(requests).toBe(1);
      expect(queue.get(job.runId)).toEqual(job);
    } finally {
      if (childPid !== undefined) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already reaped */ } }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await finished;
    }
  });

  it('retains a failed call and its partial usage without affecting a delivery', async () => {
    const { dbPath, job, env, queue } = fixture();
    vi.stubEnv('ATOMA_MCP_RUN_LOCK', env['ATOMA_MCP_RUN_LOCK']);
    const complete = vi.fn().mockRejectedValue(withPartialUsage(new Error('Fixture transport failed'), { inputTokens: 13, outputTokens: 7 }));
    await executeApprovedLearning(dbPath, job.runId, env, { client: { complete } });
    expect(queue.receipt(job.runId)).toMatchObject({ status: 'failed', completedLessons: 0, llmCalls: 1, inputTokens: 13, outputTokens: 7 });
    expect(queue.get(job.runId)?.approvedAt).toBe(job.approvedAt);
    expect(queue.pending()).toEqual([]);
  });

  it('keeps sibling lanes and their accounting open after another owner fails', async () => {
    const { dbPath, job, env, queue } = fixture(true);
    vi.stubEnv('ATOMA_MCP_RUN_LOCK', env['ATOMA_MCP_RUN_LOCK']);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const complete = vi.fn()
      .mockRejectedValueOnce(withPartialUsage(new Error('First owner failed'), { inputTokens: 3, outputTokens: 2 }))
      .mockImplementationOnce(async () => {
        await waiting;
        return { text: '', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 4 } };
      });
    const learning = executeApprovedLearning(dbPath, job.runId, env, { client: { complete } });
    try {
      await vi.waitFor(() => expect(queue.receipt(job.runId)?.llmCalls).toBe(1));
      expect(complete).toHaveBeenCalledTimes(2);
      expect(queue.receipt(job.runId)?.status).toBe('running');
    } finally { release(); await learning; }
    expect(queue.receipt(job.runId)).toMatchObject({ status: 'failed', completedLessons: 1, llmCalls: 2, inputTokens: 10, outputTokens: 6 });
  });

  it('keeps an operator job alive while another learner owns the store', async () => {
    const { dbPath, job, env, queue } = fixture();
    vi.stubEnv('ATOMA_MCP_RUN_LOCK', env['ATOMA_MCP_RUN_LOCK']);
    expect(queue.claim(job.runId)).toBe(true);
    const next = { ...job, runId: randomUUID() };
    queue.enqueue(next);
    const complete = vi.fn().mockResolvedValue({ text: '', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    const learning = executeApprovedLearning(dbPath, next.runId, env, { client: { complete } });
    expect(complete).not.toHaveBeenCalled();
    queue.finish(job.runId, 'completed');
    await learning;
    expect(complete).toHaveBeenCalledOnce();
    expect(queue.receipt(next.runId)?.status).toBe('completed');
  });
});
