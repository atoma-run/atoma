/**
 * Why `superviseLoop` stopped asking the child. `review` is the one phase no
 * judgement of the child caused: the plan reviewer itself failed
 * `MAX_PLAN_REVIEW_FAULTS` times, so the loop blames and branches nothing.
 */
export type EscalationPhase = 'plan' | 'exec' | 'repeat' | 'review';

export class EscalationSignal extends Error {
  constructor(public readonly phase: EscalationPhase) {
    super(`escalation:${phase}`);
    this.name = 'EscalationSignal';
  }
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

export class RegistryFullError extends Error {
  constructor(tier: number) {
    super(`registry tier ${tier} is full (taxonomy exhausted)`);
    this.name = 'RegistryFullError';
  }
}

export class RegistryNotFoundError extends Error {
  constructor(name: string) {
    super(`atom type not found: ${name}`);
    this.name = 'RegistryNotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Bound on the parser, schema or size text a plan-parse failure carries. */
export const PLAN_PARSE_MESSAGE_MAX_CHARS = 600;

/**
 * Why a plan reply was refused, typed where it was seen so feedback and trace
 * measurements never classify it from prose: `syntax` (malformed JSON),
 * `unbalanced` (only a truncation repair would read it), `truncated` (the
 * reply hit the plan output cap), `schema` (a well-formed pair the schemas
 * refuse), `suite-size` (a new acceptance suite over the authored bound).
 */
export type PlanParseCause = 'syntax' | 'unbalanced' | 'truncated' | 'schema' | 'suite-size';

/**
 * A strategy+plan reply that could not be accepted as written: malformed JSON,
 * a reply a truncation repair would have amputated, a schema mismatch, or a
 * new suite over the authored size bound. A ValidationError, so
 * `superviseLoop` asks a child again within its plan budget; the L3 and SHORT
 * roots count it as a failed planning attempt. `feedback()` is what the next
 * plan call is told, through the planner-feedback channel (`Atom.plan`).
 */
export class PlanParseError extends ValidationError {
  // `kind`, not `cause`: ES2022 `Error.cause` is the chained-error slot that
  // error walkers follow (src/projects/coordinator.ts); a string there would
  // overload it. Traces still record it under `cause`.
  constructor(public readonly kind: PlanParseCause, detail: string) {
    super(`${kind === 'suite-size' ? 'plan reply refused' : 'plan reply unparseable'}: ${detail.slice(0, PLAN_PARSE_MESSAGE_MAX_CHARS)}`);
    this.name = 'PlanParseError';
  }

  /** The text the next plan call carries; only a JSON-syntax failure is told how to escape. */
  feedback(): string {
    const escaping = this.kind === 'syntax' || this.kind === 'unbalanced'
      ? ' Return exactly the JSON array; inside strings escape every backslash, double quote and newline, test sources included.'
      : '';
    return `Previous plan reply was not accepted: ${this.message}.${escaping}`;
  }
}

/**
 * Invalid launch input (timeout, seed, tier pin, credentials). `startTask`
 * throws it; the CLI shell maps it to exit 2.
 *
 * Lives here rather than in `run/runner.ts` so the credential path
 * (`run/auth.ts`) can throw it without importing the runner it is imported
 * BY — a cycle. `run/runner.ts` re-exports it, so the documented library
 * contract ("startTask throws RunnerConfigError on bad input") is unchanged.
 */
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerConfigError';
  }
}

/** Protocol/configuration failures are a reviewer's failure, never a child defect. */
export class EvidenceReviewError extends Error {
  constructor(message: string) { super(message); this.name = 'EvidenceReviewError'; }
}
