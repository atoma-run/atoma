/** Model-facing tool results are bounded; observers retain the complete result. */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/** Even six-character JSON escapes leave room for page metadata and the tool envelope. */
export const MAX_FILE_PAGE_CHARS = 2_000;
