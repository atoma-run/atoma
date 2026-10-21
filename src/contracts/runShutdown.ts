/** Shutdown establishes interruption, never the identity or intent of its sender. */
export const RUN_SHUTDOWN_MESSAGE = 'run interrupted before completion (shutdown requested)';

/** Historical trace bytes stay immutable. Only this known host-authored legacy
 * message is corrected for display; arbitrary recorded error text stays verbatim. */
export function displayedRunError(error: string): string {
  return error === 'run cancelled by user (signal received)' ? RUN_SHUTDOWN_MESSAGE : error;
}
