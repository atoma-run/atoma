import { z } from 'zod';

/** check:changed's process boundary. Diagnostics are data, never instructions. */
const commandShape = {
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(2048),
};
export const supervisorCheckStepSchema = z.union([
  z.object({
    ...commandShape,
    status: z.enum(['passed', 'failed']),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(100).nullable(),
    error: z.string().max(24_000).nullable(),
    durationMs: z.number().finite().nonnegative(),
    stdout: z.string().max(24_000),
    stderr: z.string().max(24_000),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  }).strict(),
  z.object({ ...commandShape, status: z.literal('skipped'), reason: z.literal('previous-check-failed') }).strict(),
]);
export type SupervisorCheckStep = z.infer<typeof supervisorCheckStepSchema>;

export const supervisorCheckReportSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['passed', 'failed']),
  exitCode: z.number().int().min(0).max(255),
  steps: z.array(supervisorCheckStepSchema).min(1).max(32),
}).strict().superRefine((report, ctx) => {
  let failed = false;
  let exitCode = 0;
  for (const step of report.steps) {
    if (step.status === 'skipped') {
      if (!failed) ctx.addIssue({ code: 'custom', message: 'skipped step before any failure' });
      continue;
    }
    const succeeded = step.exitCode === 0 && step.signal === null && step.error === null;
    if (failed || succeeded !== (step.status === 'passed')) {
      ctx.addIssue({ code: 'custom', message: 'inconsistent step result or fail-fast order' });
    }
    if (step.status === 'failed') {
      failed = true;
      exitCode = step.exitCode !== null && step.exitCode > 0 && step.exitCode <= 255 ? step.exitCode : 1;
    }
  }
  if (report.status !== (failed ? 'failed' : 'passed') || report.exitCode !== exitCode) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent aggregate check result' });
  }
});
export type SupervisorCheckReport = z.infer<typeof supervisorCheckReportSchema>;

export const EXAMPLE_SUPERVISOR_CHECK_REPORT: SupervisorCheckReport = supervisorCheckReportSchema.parse({
  schemaVersion: 1, status: 'passed', exitCode: 0,
  steps: ['docs:check', 'typecheck'].map((name) => ({
    command: 'npm', args: ['run', name], status: 'passed', exitCode: 0,
    signal: null, error: null, durationMs: 10, stdout: '', stderr: '',
    stdoutTruncated: false, stderrTruncated: false,
  })),
});
