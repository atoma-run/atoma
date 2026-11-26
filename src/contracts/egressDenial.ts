/**
 * How the run's egress proxy says no, and how `fetch_url` recognises it.
 *
 * Behind `NODE_USE_ENV_PROXY`, Node's fetch turns a proxy's 403 into a bare
 * `fetch failed` (cause: `Request was cancelled.`, no status, no body). Three
 * DVF runs on a Compute device (2026-11-23: a89d095f, 42886713, e88e7810;
 * 189 minutes) read that as a transient failure and kept retrying an
 * official download the device's allowlist never admitted. The proxy's
 * answer is host text, not model text, so it is read through these two
 * constants and nothing else.
 */

/** First bytes of every 403 body the egress proxy writes. */
export const EGRESS_DENIED_PREFIX = 'egress denied: ';

/**
 * Response header naming WHY the proxy refused. `policy`: the host-owned
 * allowlist or port set refused the name, which no retry changes.
 * `resolution`: the name could not be resolved to a public address, which may
 * be transient. A proxy older than this header sends neither.
 */
export const EGRESS_DENIAL_HEADER = 'x-atoma-egress-denial';

export type EgressDenialKind = 'policy' | 'resolution';
