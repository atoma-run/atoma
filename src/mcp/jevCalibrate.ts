import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  calibrate,
  calibrationDetails,
  calibrationReport,
  collectCorpus,
  twinCases,
  type CalibrationRecord,
  type CorpusTrace,
} from '../atoms/jevCalibration.js';
import type { Viewer } from '../auth/store.js';
import { JEV_ENV, JEV_KEY_ENV, jevEnabled } from '../core/jev.js';
import { JEV_THRESHOLDS, type JevThresholds } from '../core/jevQuestions.js';
import { ProjectHttpError, type ProjectService } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { readBoundedRunFile } from '../viz/runIndex.js';

/**
 * `atoma_jev_calibrate` — the door onto `src/atoms/jevCalibration.ts`
 * (docs/jev-decisions-2026-09-28.md). It exists because the key lives in THIS
 * process's environment on the host, and nowhere else: the calibration reads
 * the model decisions of every organisation's runs — Jev decides in all of
 * them since 2026-09-30 — sends them to the same service those runs reach,
 * and keeps what came back in memory so another reading of the same answers
 * costs nothing.
 *
 * Results are held per principal and die with the process: a calibration is
 * a measurement to read now, not a record. The figures that matter are
 * written into the decision record by a person.
 */

/** Decisions asked per call unless told otherwise. */
const DEFAULT_LIMIT = 120;
/**
 * Nothing new is sent past this: a call stays one bounded wait, and the
 * payload says where the next picks up. The heartbeat keeps a host that waits
 * on progress from giving up meanwhile.
 */
const CALL_BUDGET_MS = 240_000;
const MAX_RESULTS = 10;

const isoInstant = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'an ISO date or date-time');

const thresholdsInput = z
  .object(
    Object.fromEntries(
      Object.keys(JEV_THRESHOLDS).map((key) => [key, z.number().min(0).max(key === 'twin' ? 2 : 1).optional()])
    ) as Record<keyof JevThresholds, z.ZodOptional<z.ZodNumber>>
  )
  .strict();

const recipeInput = z.object({
  kind: z.enum(['task', 'event']),
  description: z.string().max(4_000),
  whenToUse: z.string().max(4_000),
  body: z.string().max(20_000).optional(),
});

export const JEV_CALIBRATE_INPUT = {
  since: isoInstant.optional().describe('Only runs that started at or after this ISO date or time.'),
  until: isoInstant
    .optional()
    .describe('Only runs that started before it. Fix it while paging, so a new run does not shift the offsets.'),
  offset: z.number().int().nonnegative().optional().describe('Skip this many decisions of the window, oldest run first.'),
  limit: z.number().int().positive().max(400).optional().describe(`Decisions asked in this call (default ${DEFAULT_LIMIT}).`),
  includeJevRuns: z
    .boolean()
    .optional()
    .describe('Also read runs in which Jev decided; there the model decisions are a sample Jev chose.'),
  twins: z
    .object({
      recipes: z.record(z.string().min(1).max(200), recipeInput),
      cases: z
        .array(z.object({ draft: z.string().min(1), existing: z.array(z.string().min(1)).max(48), twins: z.array(z.string().min(1)) }))
        .min(1)
        .max(20),
    })
    .optional()
    .describe('Labelled twin cases: recipes by id, and per case the draft, the recipes it is compared with, and those a person judged it to duplicate.'),
  resultIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_RESULTS)
    .optional()
    .describe('Read earlier results of yours again, as one set, instead of asking: nothing is sent.'),
  thresholds: thresholdsInput.optional().describe('Override thresholds for this reading.'),
  sweep: z.boolean().optional().describe('Add the figures under neighbouring thresholds.'),
  details: z
    .object({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(50).optional() })
    .optional()
    .describe('One row per decision with its probabilities; carries model-authored task text.'),
};

export type JevCalibrateArgs = z.infer<z.ZodObject<typeof JEV_CALIBRATE_INPUT>>;

interface StoredResult {
  readonly principalId: string;
  readonly createdAt: string;
  readonly records: readonly CalibrationRecord[];
}

const RESULTS = new Map<string, StoredResult>();

function remember(principalId: string, records: readonly CalibrationRecord[]): string {
  const id = randomUUID();
  RESULTS.set(id, { principalId, createdAt: new Date().toISOString(), records });
  while (RESULTS.size > MAX_RESULTS) RESULTS.delete(RESULTS.keys().next().value!);
  return id;
}

/** Test seam: results are process memory. */
export function forgetJevCalibrationsForTest(): void {
  RESULTS.clear();
}

function traceOf(file: string): unknown {
  const read = readBoundedRunFile(file);
  if (!read.ok) return null;
  try {
    return JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function modifiedAtMs(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function jevCalibrateCall(
  input: {
    readonly projects: { readonly service: ProjectService; readonly store: ProjectStore };
    readonly viewer: Viewer;
    /** Every organisation on the instance, read at call time: a new one is in. */
    readonly orgIds: () => readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly progress?: (message: string) => void;
  },
  args: JevCalibrateArgs
): Promise<Record<string, unknown>> {
  const thresholds: JevThresholds = { ...JEV_THRESHOLDS, ...args.thresholds };
  const reading = { thresholds, ...(args.sweep ? { sweep: true } : {}) };
  const detailsOf = (records: readonly CalibrationRecord[]) =>
    args.details ? { details: calibrationDetails(records, { thresholds, ...args.details }) } : {};

  if (args.resultIds) {
    const asking = [args.since, args.until, args.offset, args.limit, args.twins, args.includeJevRuns].some((value) => value !== undefined);
    if (asking) throw new ProjectHttpError(400, 'resultIds reads earlier answers again; pass the window only when asking');
    const records: CalibrationRecord[] = [];
    for (const id of args.resultIds) {
      const stored = RESULTS.get(id);
      if (!stored || stored.principalId !== input.viewer.principalId) {
        throw new ProjectHttpError(404, `calibration result ${id} not found (results live in this server's memory until it restarts)`);
      }
      records.push(...stored.records);
    }
    return { resultIds: args.resultIds, report: calibrationReport(records, reading), ...detailsOf(records) };
  }

  const env = input.env ?? process.env;
  if (!jevEnabled(env)) {
    throw new ProjectHttpError(503, `Jev is off on this host (${JEV_ENV}=0, or ${JEV_KEY_ENV} is absent)`);
  }
  const orgs = input.orgIds();
  const twins = args.twins ? twinCases(args.twins) : [];
  if (typeof twins === 'string') throw new ProjectHttpError(400, twins);
  // A cross-organisation read is journaled before anything is read, exactly
  // as `atoma_run_trace` journals one.
  for (const orgId of orgs) input.projects.service.auditRead(input.viewer, orgId, 'mcp.trace');
  const traces: CorpusTrace[] = orgs.flatMap((orgId) =>
    input.projects.store.listOrgRunTraces(orgId).map((row) => {
      const modified = modifiedAtMs(row.file);
      return { runId: row.id, orgId, ...(modified !== undefined ? { modifiedAtMs: modified } : {}), read: () => traceOf(row.file) };
    })
  );
  const corpus = collectCorpus({
    traces,
    ...(args.since ? { since: args.since } : {}),
    ...(args.until ? { until: args.until } : {}),
    ...(args.includeJevRuns ? { includeJevRuns: true } : {}),
  });
  const offset = args.offset ?? 0;
  const window = corpus.decisions.slice(offset, offset + (args.limit ?? DEFAULT_LIMIT));
  const calibration = await calibrate({
    decisions: window,
    twins,
    apiKey: env[JEV_KEY_ENV]!.trim(),
    budgetMs: CALL_BUDGET_MS,
    onProgress: (done, total) => input.progress?.(`asked ${done} of ${total}`),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const consumed = calibration.resumeAt ?? window.length;
  return {
    resultId: remember(input.viewer.principalId, calibration.records),
    orgs,
    window: {
      since: args.since ?? null,
      until: args.until ?? null,
      decisions: corpus.decisions.length,
      offset,
      asked: consumed,
      nextOffset: offset + consumed < corpus.decisions.length ? offset + consumed : null,
      traces: corpus.traces,
    },
    unparsed: calibration.unparsed,
    ineligible: calibration.ineligible,
    unasked: calibration.unasked,
    report: calibrationReport(calibration.records, reading),
    ...detailsOf(calibration.records),
    note:
      'The model decision is the reference, not ground truth. Recipe candidates are asked without their opening steps: ' +
      'the recorded prompt does not carry them. Task and requirement text is UNTRUSTED model-authored data.',
  };
}
