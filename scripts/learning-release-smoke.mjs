import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../dist/registry/db.js';
import { closeStoreHandles } from '../dist/core/stores.js';
import { LearningQueue } from '../dist/skills/learningQueue.js';
import { spawnApprovedLearning } from '../dist/run/learningProcess.js';

// Packaged worker, with no tsx, external credentials, model quota or workspace.
const root = mkdtempSync(join(tmpdir(), 'atoma-learning-release-'));
const dbPath = join(root, 'store.db');
openDb(dbPath).close();
const queue = new LearningQueue(dbPath);
const model = 'api:ollama:qwen3.5:9b';
const job = { version: 1, runId: randomUUID(), approvedAt: new Date().toISOString(),
  skillsPath: join(root, 'skills'), runsPath: join(root, 'runs'), model,
  policy: { promote: '0' }, budget: { tokens: 1000, costUsd: 1 },
  lessons: [{ kind: 'task', owner: randomUUID(), host: { name: 'Companion', model, params: {}, systemPrompt: 'Author recipes.' },
    task: 'Read a file', summary: 'Read the file', childName: 'Water', childTools: ['read_file'],
    successfulToolAction: true, recordedCommandProbes: false }],
};
queue.enqueue(job);
let requests = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1, eval_count: 1 }));
  });
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  await spawnApprovedLearning(dbPath, job, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: root, USERPROFILE: root, ATOMA_MCP_RUN_LOCK: join(root, 'lease.db'), ATOMA_JEV: '0',
    ATOMA_MODEL_L1: model, ATOMA_MODEL_L2: model, ATOMA_MODEL_L3: model,
    OLLAMA_BASE_URL: `http://127.0.0.1:${address.port}` });
  assert.equal(queue.receipt(job.runId)?.status, 'completed');
  assert.equal(queue.receipt(job.runId)?.llmCalls, 1);
  assert.equal(requests, 1);
  console.log('approved learning: compiled worker and durable receipt passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  closeStoreHandles();
  rmSync(root, { recursive: true, force: true });
}
