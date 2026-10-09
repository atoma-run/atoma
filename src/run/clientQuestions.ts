import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { answerClientQuestionSchema, clientQuestionRecordSchema, clientAnswerContextSchema, CLIENT_ANSWERS_MAX_CHARS,
  type AnswerClientQuestion, type ClientQuestion, type ClientQuestionRecord } from '../contracts/clientQuestion.js';
import type { RunCheckpoint } from '../contracts/runCheckpoint.js';

export class ClientQuestionConflict extends Error {}
export function initializeClientQuestions(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS run_client_questions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
    principal_id TEXT NOT NULL, phase INTEGER NOT NULL, question_json TEXT NOT NULL, created_at TEXT NOT NULL,
    answer_json TEXT, request_key TEXT, request_json TEXT);
    CREATE TRIGGER IF NOT EXISTS client_question_immutable BEFORE UPDATE ON run_client_questions
    WHEN OLD.id IS NOT NEW.id OR OLD.run_id IS NOT NEW.run_id OR OLD.org_id IS NOT NEW.org_id
      OR OLD.project_id IS NOT NEW.project_id OR OLD.principal_id IS NOT NEW.principal_id
      OR OLD.phase IS NOT NEW.phase OR OLD.question_json IS NOT NEW.question_json OR OLD.created_at IS NOT NEW.created_at
      OR (OLD.answer_json IS NOT NULL AND (OLD.answer_json IS NOT NEW.answer_json OR OLD.request_key IS NOT NEW.request_key OR OLD.request_json IS NOT NEW.request_json))
    BEGIN SELECT RAISE(ABORT, 'client questions and recorded answers are immutable'); END;`);
}
type Row = { id: string; run_id: string; org_id: string; project_id: string; principal_id: string; phase: number;
  question_json: string; created_at: string; answer_json: string | null; request_key: string | null; request_json: string | null };
function project(row: Row): ClientQuestionRecord {
  return clientQuestionRecordSchema.parse({ questionId: row.id, runId: row.run_id, projectId: row.project_id, phase: row.phase,
    question: JSON.parse(row.question_json), createdAt: row.created_at, answer: row.answer_json ? JSON.parse(row.answer_json) : null });
}
export function readClientQuestion(db: Database.Database, orgId: string, runId: string): ClientQuestionRecord | null {
  const row = db.prepare('SELECT * FROM run_client_questions WHERE org_id=? AND run_id=?').get(orgId, runId) as Row | undefined;
  return row ? project(row) : null;
}
/** Called inside the same transaction that seals the paused checkpoint. */
export function recordClientQuestion(db: Database.Database, data: RunCheckpoint, question: ClientQuestion): void {
  if (!data.scope) throw new ClientQuestionConflict('Client questions require a project run');
  const id = randomUUID();
  db.prepare('INSERT INTO run_client_questions (id,run_id,org_id,project_id,principal_id,phase,question_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, data.id, data.scope.orgId, data.scope.projectId, data.scope.principalId, data.completed.length, JSON.stringify(question), new Date().toISOString());
  data.clientQuestionId = id;
}
export function answerClientQuestion(db: Database.Database, orgId: string, runId: string, principalId: string, raw: AnswerClientQuestion) {
  const input = answerClientQuestionSchema.parse(raw);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM run_client_questions WHERE id=? AND run_id=? AND org_id=?').get(input.questionId, runId, orgId) as Row | undefined;
    if (!row || row.principal_id !== principalId) throw new ClientQuestionConflict('Client question is unavailable to this requester');
    if (row.answer_json) {
      if (row.request_key !== input.idempotencyKey || row.request_json !== JSON.stringify(input)) throw new ClientQuestionConflict('This question already has a different answer');
      return { question: project(row), created: false };
    }
    const boundary = db.prepare('SELECT state,released,payload FROM run_checkpoints WHERE id=?').get(runId) as { state: string; released: number; payload: string } | undefined;
    if (boundary?.state !== 'ready' || boundary.released !== 1) throw new ClientQuestionConflict('The run has not finished pausing at a safe boundary');
    const question = project(row);
    if (input.answer.optionId && !question.question.options.some(option => option.id === input.answer.optionId)) throw new ClientQuestionConflict('Choose an offered option or supply a free-text answer');
    const answer = { principalId, at: new Date().toISOString(), value: input.answer };
    db.prepare('UPDATE run_client_questions SET answer_json=?,request_key=?,request_json=? WHERE id=? AND answer_json IS NULL')
      .run(JSON.stringify(answer), input.idempotencyKey, JSON.stringify(input), input.questionId);
    try { applyClientAnswer(db, JSON.parse(boundary.payload) as RunCheckpoint); }
    catch { throw new ClientQuestionConflict(`Answer cannot be recorded in this checkpoint; shorten it if the ${CLIENT_ANSWERS_MAX_CHARS}-character history budget is exhausted`); }
    return { question: { ...question, answer }, created: true };
  }).immediate();
}
/** An unanswered question blocks every continuation path, including a direct CLI resume. */
export function applyClientAnswer(db: Database.Database, data: RunCheckpoint): void {
  if (!data.clientQuestionId) return;
  const row = db.prepare('SELECT * FROM run_client_questions WHERE id=?').get(data.clientQuestionId) as Row | undefined;
  if (!row || !data.scope || row.org_id !== data.scope.orgId || row.project_id !== data.scope.projectId || row.principal_id !== data.scope.principalId) {
    throw new ClientQuestionConflict('Checkpoint client question scope mismatch');
  }
  const record = project(row);
  if (!record.answer) throw new ClientQuestionConflict('A client answer is required before resuming');
  if (!data.root || record.phase !== data.completed.length) throw new ClientQuestionConflict('Checkpoint question phase mismatch');
  const prior = clientAnswerContextSchema.parse(data.root.inputs?.['clientAnswers'] ?? []);
  const selected = record.question.options.find(option => option.id === record.answer!.value.optionId);
  const answers = prior.some(item => item.questionId === record.questionId) ? prior : clientAnswerContextSchema.parse([...prior, {
    questionId: record.questionId, question: record.question.question, selectedOption: selected ? { label: selected.label, consequence: selected.consequence } : null,
    text: record.answer.value.text ?? null, principalId: record.answer.principalId, at: record.answer.at,
  }]);
  data.root.inputs = { ...data.root.inputs, clientAnswers: answers };
}
