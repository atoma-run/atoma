/** Public assets supported by the default run and preview network policy. */
export const DEFAULT_WEB_RESOURCE_HOSTS: readonly string[] = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
];

/** The one variable that closes application egress to an exact list. */
export const APPLICATION_EGRESS_HOSTS_ENV = 'ATOMA_PREVIEW_ALLOWED_HOSTS';

/**
 * Do applications Atoma serves reach any public destination? Yes unless the
 * operator names an exact list (owner decision 2026-11-28): unset or `*` is
 * open; any other value, the empty string included, is that list. Read by the
 * web process (previews, hosted pages) and by the hosting launcher, which
 * runs under its own environment: an operator who closes one sets both.
 */
export function applicationEgressOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[APPLICATION_EGRESS_HOSTS_ENV];
  return value === undefined || value.trim() === '*';
}
