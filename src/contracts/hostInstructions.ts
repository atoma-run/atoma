/**
 * Sentences the HOST writes into a worker's conversation, and therefore into
 * its trace. They are Atoma's own routing instructions to the worker model,
 * not payloads. The analyst is shown them (`buildAnalystPrompt`) so quoting
 * one is never a security incident: runs 004e9cfa and 299627a9 (2026-10-09)
 * were each filed `security_incident` for the two below.
 */

/**
 * Hint appended alongside the final tool_result batch when the budget is
 * exhausted. Tells the model it has NO more tool access this turn and must
 * produce its final response as text now. Kept short so it doesn't steer the
 * content of the final answer beyond "stop calling tools".
 */
export const BUDGET_EXHAUSTED_HINT =
  'TOOL BUDGET EXHAUSTED for this turn. You have no more tool access. ' +
  'Produce the final response now as plain text (or structured JSON if the task requires it). ' +
  'Do NOT attempt to call any more tools — tools are disabled for this message.';

/**
 * `run_shell`'s executable allowlist routes, it does not confine: `bash` is on
 * it and a shell line already runs as `bash -c`. The sandbox is the boundary.
 */
export const RUN_SHELL_BASH_ROUTE_HINT =
  'For anything else, invoke it through bash: command: "bash", args: ["-c", "..."] — ' +
  'except network fetches, which belong to the fetch_url tool.';

export const HOST_AUTHORED_INSTRUCTIONS: readonly string[] = [BUDGET_EXHAUSTED_HINT, RUN_SHELL_BASH_ROUTE_HINT];
