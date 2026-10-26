/** Model-facing tool results are bounded; observers retain the complete result. */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/**
 * The file text one `read_file` result shows the model. read_file never
 * refuses a range for its size: a file or a range longer than this comes back
 * as its first part with `nextOffset`, so a file of any size is read whole,
 * part after part, and none overflows the model's context and fails the run.
 * Shown verbatim between markers (`formatToolResultContent`), never cut.
 * Until 2026-10-26 a page held at most 2,000 characters and a larger `limit`
 * was refused: run 9d36e988's read-only audits lost ~15 calls that way.
 */
export const MAX_FILE_READ_CHARS = 60_000;

/** Withhold read_file's overwrite authorization side effect during host observation. Grants no capability. */
export const FILE_OBSERVATION_ONLY_ARG = 'observationOnly';

/**
 * `read_file` and `list_files` ANSWER a path that holds no file instead of
 * throwing (2026-10-13): `{ exists: false }` for an absent path, and
 * `read_file` answers `{ kind: 'dir' }` for a directory. Neither is file
 * content, a successful tool action, a read the write guard counts, or an
 * attested observation — exactly what the throw they replaced was. Only a
 * result carrying a string `content` read a file.
 */
export function pathHeldNoFile(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const result = raw as Record<string, unknown>;
  if (typeof result['content'] === 'string') return false;
  return result['exists'] === false || result['kind'] === 'dir';
}
