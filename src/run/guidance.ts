/**
 * How to phrase a goal for a run, and the shell command that starts one.
 *
 * ONE source for every consumer: the CLI's `--help`, the viz project run form
 * (through `/api/goal-guidance`) and the MCP `atoma_goal` prompt. It was a
 * per-profile `guidance` when a "family" picked a run's root; the root is now
 * chosen from the request, so there is one thing to say and nothing to pick.
 *
 * English is the source, matching the viz i18n convention: the UI prefers the
 * `launch.help` catalog key when it carries a translation and falls back to
 * `help`.
 */
export interface GoalGuidance {
  /** A few sentences on how to phrase a goal. */
  readonly help: string;
  /** Concrete example goals, click-to-fill in the UI. */
  readonly examples: readonly string[];
  /** npm script that starts a run from a shell, as in `npm run <npmScript> -- "<goal>"`. */
  readonly npmScript: string;
}

export const GOAL_GUIDANCE: GoalGuidance = {
  help: 'Describe the outcome you want and any constraints. For an imported repository, explain what to inspect or change. Atoma selects a tissue from the request and repository context, reusing an existing capability or creating one when needed. Verification follows the requested outcome.',
  examples: [
    'Explain how authentication works in this repository and identify the files responsible for it.',
    'Analyze the CSV files in the repository and write a report on missing values and outliers.',
    'Build a single-page pomodoro timer with start, pause and reset controls.',
  ],
  npmScript: 'run:build',
};
