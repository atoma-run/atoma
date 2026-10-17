import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseRunLog } from '../../src/cli/burnin.js';
import { parentTestSuiteDigest, type ParentTestSuite } from '../../src/contracts/parentTests.js';
import type { PersistedParentTestObservation } from '../../src/contracts/parentTestRecord.js';
import type { RunStats } from '../../src/contracts/runStats.js';
import {
  suiteDisputeCountedEntry,
  suiteDisputeLaterEntry,
  type SuiteDisputeEntry,
} from '../../src/contracts/suiteDisputeRecord.js';
import { projectRunHostLayout } from '../../src/projects/coordinator.js';
import { TraceRecorder } from '../../src/viz/trace.js';
import type { projectRetrievalFixture } from './projectRetrievalLaunch.js';

/**
 * Project runs whose traces the REAL `TraceRecorder` writes, with a suite
 * dispute record and run stats of the test's choosing: the corpus the
 * suite-dispute report reads in production.
 */

type Fixture = ReturnType<typeof projectRetrievalFixture>;

export function disputeSuite(requirement: string, marker = requirement): ParentTestSuite {
  return { requirement, cwd: '.', source: `import { test, expect } from 'vitest';\n// ${marker}\ntest('holds', () => { expect(1).toBe(2); });` };
}

export function countedFor(suite: ParentTestSuite, at: number, options: { excerpt?: string; task?: string; attempt?: number } = {}) {
  return suiteDisputeCountedEntry({
    key: { id: randomUUID(), at, suiteDigest: parentTestSuiteDigest(suite), attempt: options.attempt ?? 1, branchId: randomUUID() },
    owner: { name: 'Tracheid', tier: 2 }, failingChild: 'Methane', phase: 'repeat', task: options.task ?? 'TASK-TEXT write the module',
    suite, excerpt: options.excerpt ?? '[{"name":"holds","failure":"EXCERPT-TEXT expected 1 to be 2"}]', counts: { observations: 3, subjects: 3 },
    observations: ['a', 'b', 'c'].map((subject, index) => ({
      observation: { observedAt: at - 10 + index, subjectDigest: subject.repeat(64), workspaceDigest: 'w'.repeat(64), status: 'failed' as const,
        cause: 'ran' as const, passed: 0, failed: 1, skipped: 0 },
      sameSet: true,
    })),
  });
}

export function laterFor(counted: SuiteDisputeEntry, at: number, status: 'passed' | 'failed') {
  return suiteDisputeLaterEntry({
    key: { id: randomUUID(), at, suiteDigest: counted.suiteDigest }, countId: counted.id,
    producedBy: { name: 'Methane', tier: 1, viaFallback: false },
    observation: { observedAt: at, subjectDigest: 'd'.repeat(64), workspaceDigest: 'w'.repeat(64), status, cause: 'ran',
      passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1, skipped: 0 },
    sameSet: false,
  });
}

export function record(suite: ParentTestSuite, status: 'passed' | 'failed', observedAt: number): PersistedParentTestObservation {
  return {
    suiteDigest: parentTestSuiteDigest(suite), workspaceDigest: 'w'.repeat(64), status, cause: 'ran',
    passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1, skipped: 0, observedAt,
    requirement: suite.requirement.slice(0, 600), details: '[]',
  };
}

const base = parseRunLog('✓ build finished');

export function disputeStats(outcome: 'delivered' | 'partial' | 'failed', suiteDisputes: number): RunStats {
  return { ...base, outcome, suiteDisputes, ...(outcome === 'partial' ? { landingReasons: ['refused at delivery'] } : {}) };
}

/** One project run, its trace written through the recorder, ending as `status`. */
export function addDisputeRun(f: Fixture, options: {
  readonly status: 'running' | 'partial' | 'delivered' | 'failed';
  /** The run stats' count; null leaves the run without stats (running). */
  readonly disputes: number | null;
  readonly goal?: string;
  readonly entries?: readonly SuiteDisputeEntry[];
  /** Raw items appended past the recorder's types: what an older or broken writer left. */
  readonly raw?: readonly unknown[];
  readonly parentTests?: readonly PersistedParentTestObservation[];
  readonly output?: string;
  readonly removeTrace?: boolean;
}): string {
  const runId = randomUUID();
  const layout = projectRunHostLayout(f.root, f.viewer.orgId, f.project.projectId, runId);
  const goal = options.goal ?? 'GOAL-TEXT repair the module';
  f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId,
    request: { idempotencyKey: runId, goal }, projectRunId: runId,
    hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath } });
  f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: runId, from: 'queued', to: 'running' });
  const recorder = new TraceRecorder(layout.runsPath);
  recorder.beginRun({ description: goal }, 'run', { runId });
  for (const entry of options.entries ?? []) recorder.recordSuiteDispute(entry);
  for (const item of options.raw ?? []) recorder.recordSuiteDispute(item as SuiteDisputeEntry);
  const result = { summary: 'done', output: options.output ?? 'OUTPUT-TEXT', producedBy: { tier: 3 as const, name: 'Meristem', viaFallback: false },
    ...(options.parentTests ? { parentTests: [...options.parentTests] } : {}) };
  if (options.status === 'running') recorder.flushPartial();
  else recorder.endRun(options.status === 'failed' ? { error: 'failed' } : { result });
  if (options.removeTrace) rmSync(join(layout.runsPath, `${runId}.json`));
  if (options.status !== 'running') {
    f.projects.transitionProjectRun({ orgId: f.viewer.orgId, projectRunId: runId, from: 'running', to: options.status, traceId: runId,
      stats: disputeStats(options.status, options.disputes ?? 0), ...(options.status === 'failed' ? { error: 'failed' } : {}) });
  }
  return runId;
}
