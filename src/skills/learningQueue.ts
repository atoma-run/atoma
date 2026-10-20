import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import { estimateCostUsd, pricesFor, type LlmCallMetrics } from '../core/metrics.js';
import { learningJobSchema, type LearningJob, type LearningReceipt } from '../contracts/skillLearning.js';
import { learningReceipt, learningReceipts } from './learningReceipts.js';
export { learningReceipt, learningReceipts } from './learningReceipts.js';
import { processFingerprint, recordedProcessLive } from '../mcp/runLock.js';
import { billableTokensOf } from '../core/runBudget.js';

const DDL = `
CREATE TABLE IF NOT EXISTS skill_learning_jobs (
  run_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)),
  lesson_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', pid INTEGER, fingerprint TEXT, in_flight INTEGER NOT NULL DEFAULT 0,
  active_lessons TEXT NOT NULL DEFAULT '[]',
  completed TEXT NOT NULL DEFAULT '[]', calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT, updated_at TEXT NOT NULL, retries TEXT NOT NULL DEFAULT '[]'
);
`;
export type LearningQueueRow = { run_id: string; payload: string; lesson_count: number; status: LearningReceipt['status']; pid: number | null; fingerprint: string | null;
  in_flight: number; active_lessons: string; completed: string; calls: number; tokens: number; input_tokens: number;
  output_tokens: number; cost_usd: number; error: string | null; updated_at: string; retries: string };

/** The primary product store owns the outbox. Bodies, prompts and costs survive the run child. */
export class LearningQueue {
  readonly db: Database.Database;
  constructor(path: string) { this.db = openStoreHandle(path, DDL); }

  enqueue(input: LearningJob): void {
    const job = learningJobSchema.parse(input);
    this.db.prepare('INSERT INTO skill_learning_jobs(run_id, payload, lesson_count, updated_at) VALUES (?, ?, ?, ?)')
      .run(job.runId, JSON.stringify(job), job.lessons.length, new Date().toISOString());
  }

  get(runId: string): LearningJob | undefined {
    const row = this.db.prepare('SELECT payload FROM skill_learning_jobs WHERE run_id = ?').get(runId) as { payload: string } | undefined;
    return row ? learningJobSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  setBudget(runId: string, budget: LearningJob['budget']): void {
    this.db.prepare("UPDATE skill_learning_jobs SET payload = json_set(payload, '$.budget', json(?)), updated_at = ? WHERE run_id = ? AND status = 'pending'")
      .run(JSON.stringify(budget), new Date().toISOString(), runId);
  }

  receipt(runId: string): LearningReceipt | undefined { return learningReceipt(this.db, runId); }

  /** Never repay a call whose response died with its process. Unstarted work can resume automatically. */
  recover(isAlive: (pid: number, fingerprint: string | null) => boolean = (pid, fingerprint) => recordedProcessLive(pid, fingerprint ?? '')): void {
    const rows = this.db.prepare("SELECT run_id, pid, fingerprint, in_flight, active_lessons FROM skill_learning_jobs WHERE status = 'running'").all() as LearningQueueRow[];
    for (const row of rows) {
      if (row.pid !== null && isAlive(row.pid, row.fingerprint)) continue;
      const uncertain = row.in_flight > 0 || (JSON.parse(row.active_lessons) as number[]).length > 0;
      this.db.prepare("UPDATE skill_learning_jobs SET status = ?, pid = NULL, error = ?, updated_at = ? WHERE run_id = ? AND status = 'running' AND pid IS ?")
        .run(uncertain ? 'interrupted' : 'pending', uncertain ? 'Learning was interrupted during a lesson; its usage or writes may be incomplete. Explicit retry required.' : null,
          new Date().toISOString(), row.run_id, row.pid);
    }
  }

  /** Account credentials remain in use when another executor owns learning. */
  hasActivePrincipal(principalId: string): boolean {
    const owners = this.db.prepare("SELECT pid, fingerprint FROM skill_learning_jobs WHERE status = 'running' AND json_extract(payload, '$.scope.principalId') = ?")
      .all(principalId) as Pick<LearningQueueRow, 'pid' | 'fingerprint'>[];
    return owners.some(owner => owner.pid !== null && recordedProcessLive(owner.pid, owner.fingerprint ?? ''));
  }

  pending(): LearningJob[] {
    return (this.db.prepare("SELECT payload FROM skill_learning_jobs WHERE status = 'pending' ORDER BY updated_at, run_id").all() as { payload: string }[])
      .map(row => learningJobSchema.parse(JSON.parse(row.payload)));
  }

  list(): Array<{ runId: string; receipt: LearningReceipt }> {
    return learningReceipts(this.db);
  }

  /** One learner at a time across processes; it may parallelize different owners within its batch. */
  claim(runId: string, pid = process.pid): boolean {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM skill_learning_jobs WHERE status = 'running' LIMIT 1").get()) return false;
      return this.db.prepare("UPDATE skill_learning_jobs SET status = 'running', pid = ?, fingerprint = ?, error = NULL, updated_at = ? WHERE run_id = ? AND status = 'pending'")
        .run(pid, processFingerprint(pid), new Date().toISOString(), runId).changes === 1;
    }).immediate();
  }

  completed(runId: string): number[] {
    const row = this.db.prepare('SELECT completed FROM skill_learning_jobs WHERE run_id = ?').get(runId) as { completed: string };
    return JSON.parse(row.completed) as number[];
  }

  startLesson(runId: string, index: number): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT active_lessons FROM skill_learning_jobs WHERE run_id = ?').get(runId) as { active_lessons: string };
      const active = JSON.parse(row.active_lessons) as number[];
      this.db.prepare('UPDATE skill_learning_jobs SET active_lessons = ? WHERE run_id = ? AND pid = ?')
        .run(JSON.stringify([...active, index]), runId, process.pid);
    }).immediate();
  }

  completeLesson(runId: string, index: number): void {
    this.db.transaction(() => {
      const done = this.completed(runId);
      if (!done.includes(index)) done.push(index);
      const row = this.db.prepare('SELECT active_lessons FROM skill_learning_jobs WHERE run_id = ?').get(runId) as { active_lessons: string };
      const active = (JSON.parse(row.active_lessons) as number[]).filter(value => value !== index);
      this.db.prepare('UPDATE skill_learning_jobs SET completed = ?, active_lessons = ?, updated_at = ? WHERE run_id = ? AND pid = ?')
        .run(JSON.stringify(done), JSON.stringify(active), new Date().toISOString(), runId, process.pid);
    }).immediate();
  }

  callStarted(runId: string): void {
    this.db.prepare("UPDATE skill_learning_jobs SET in_flight = in_flight + 1, updated_at = ? WHERE run_id = ? AND status = 'running' AND pid = ?")
      .run(new Date().toISOString(), runId, process.pid);
  }
  callEnded(runId: string): void {
    this.db.prepare('UPDATE skill_learning_jobs SET in_flight = in_flight - 1, updated_at = ? WHERE run_id = ? AND pid = ?')
      .run(new Date().toISOString(), runId, process.pid);
  }
  recordCall(runId: string, call: LlmCallMetrics): void {
    this.db.prepare(`UPDATE skill_learning_jobs SET calls = calls + 1, input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?, tokens = tokens + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE run_id = ? AND pid = ?`)
      .run(call.inputTokens, call.outputTokens,
        billableTokensOf(call),
        estimateCostUsd(call, pricesFor(call.model)), new Date().toISOString(), runId, process.pid);
  }
  consumed(runId: string): { tokens: number; costUsd: number } {
    return this.db.prepare('SELECT tokens, cost_usd AS costUsd FROM skill_learning_jobs WHERE run_id = ?').get(runId) as { tokens: number; costUsd: number };
  }
  finish(runId: string, status: 'completed' | 'failed' | 'pending', error: string | null = null): void {
    this.db.prepare('UPDATE skill_learning_jobs SET status = ?, pid = NULL, error = ?, updated_at = ? WHERE run_id = ? AND pid = ?')
      .run(status, error, new Date().toISOString(), runId, process.pid);
  }
  block(runId: string, error: string): void {
    this.db.prepare("UPDATE skill_learning_jobs SET status = 'blocked', error = ?, updated_at = ? WHERE run_id = ? AND status = 'pending'")
      .run(error, new Date().toISOString(), runId);
  }
  retry(runId: string): boolean {
    const now = new Date().toISOString();
    return this.db.prepare("UPDATE skill_learning_jobs SET status = 'pending', in_flight = 0, active_lessons = '[]', error = NULL, updated_at = ?, retries = json_insert(retries, '$[#]', json(?)) WHERE run_id = ? AND status IN ('pending', 'interrupted', 'failed', 'blocked')")
      .run(now, JSON.stringify({ at: now, actorType: 'cli' }), runId).changes === 1;
  }
}
