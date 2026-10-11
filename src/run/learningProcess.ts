import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LearningJob } from '../contracts/skillLearning.js';
import { LearningQueue } from '../skills/learningQueue.js';

/** Separate process group: the run launcher reaps the delivery's entire group. */
export function spawnApprovedLearning(dbPath: string, job: LearningJob, env: NodeJS.ProcessEnv): Promise<void> {
  const source = import.meta.url.endsWith('.ts');
  const worker = fileURLToPath(new URL(source ? './learningWorker.ts' : './learningWorker.js', import.meta.url));
  const logDir = join(job.runsPath, 'learning');
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, `${job.runId}.log`), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), worker, job.runId], {
      env: { ...env, ATOMA_DB_PATH: resolve(dbPath) }, detached: true, windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return new Promise((resolveDone, reject) => {
      child.once('error', reject);
      child.once('exit', code => {
        new LearningQueue(dbPath).recover();
        if (code === 0) resolveDone(); else reject(new Error('Learning worker exited before completion'));
      });
    });
  } finally { closeSync(fd); }
}
