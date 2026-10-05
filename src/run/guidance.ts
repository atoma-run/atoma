/**
 * How to phrase a goal for a run, and the shell command that starts one.
 *
 * ONE source for the CLI's `--help` and the MCP `atoma_goal` prompt. It was a
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
  help: 'Describe the outcome, intended users, relevant repository or files, constraints, and observable signs of completion. For an imported repository, say what to inspect or change. Do not prescribe Atoma’s internal tools or agent roles. Atoma chooses its planning capability from the request and repository, plans the work, and checks the result against the goal. A run may deliver, stop incomplete, or fail; review its result.',
  examples: [
    'Explain how authentication works in this repository and identify the files responsible for it.',
    'Analyze the CSV files in the repository and write a report on missing values and outliers.',
    'Build a single-page pomodoro timer with start, pause and reset controls.',
  ],
  npmScript: 'run:build',
};
