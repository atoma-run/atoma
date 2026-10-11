import type Database from 'better-sqlite3';
import { learningReceiptSchema, type LearningReceipt } from '../contracts/skillLearning.js';
import type { LearningQueueRow } from './learningQueue.js';

/** Read-only projections must not load the queue's process and provider machinery. */
export function learningReceipt(db: Database.Database, runId: string): LearningReceipt | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_learning_jobs'").get()) return;
  const row = db.prepare('SELECT status, lesson_count, completed, calls, input_tokens, output_tokens, cost_usd, error, updated_at, retries FROM skill_learning_jobs WHERE run_id = ?').get(runId) as LearningQueueRow | undefined;
  if (!row) return;
  return learningReceiptSchema.parse({ status: row.status, lessons: row.lesson_count,
    completedLessons: (JSON.parse(row.completed) as number[]).length, llmCalls: row.calls,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: row.cost_usd,
    error: row.error, updatedAt: row.updated_at, retries: JSON.parse(row.retries) });
}

export function learningReceipts(db: Database.Database): Array<{ runId: string; receipt: LearningReceipt }> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'skill_learning_jobs'").get()) return [];
  return (db.prepare('SELECT run_id FROM skill_learning_jobs ORDER BY updated_at DESC LIMIT 100').all() as { run_id: string }[])
    .map(row => ({ runId: row.run_id, receipt: learningReceipt(db, row.run_id)! }));
}
