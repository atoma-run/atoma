/** Model-facing tool results are bounded; observers retain the complete result. */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/** Even six-character JSON escapes leave room for page metadata and the tool envelope. */
export const MAX_FILE_PAGE_CHARS = 2_000;

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
