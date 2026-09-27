import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recordedProcessLive } from '../mcp/runLock.js';

export const DEPLOYMENT_LOCK_ENV = 'ATOMA_DEPLOY_LOCK_PATH';
/** First word of a marker that names its writer: `guard <pid> <birth identity>`. */
export const DEPLOYMENT_MARKER_PREFIX = 'guard';

const STATEFUL_GET_PATHS = new Set([
  '/auth/login',
  '/oauth/authorize',
  '/auth/callback',
  '/auth/github/connect',
  '/auth/github/authorize',
  '/auth/github/setup',
]);

/**
 * The host-owned marker that closes write admission before code activation.
 * Absence keeps the existing developer/release behaviour unchanged.
 *
 * A marker that NAMES ITS WRITER (`guard <pid> <birth identity>`, what a
 * waiting deployment guard writes) freezes writes only while that writer lives: one
 * left behind by a killed guard or a reboot mid-deployment would otherwise
 * refuse every write until a person found and deleted it. A marker without a
 * name — an activator's own, or one from a release before this — pauses for
 * as long as it exists, as it always did.
 */
export function deploymentPaused(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): boolean {
  const configured = env[DEPLOYMENT_LOCK_ENV]?.trim();
  if (!configured) return false;
  const path = resolve(configured);
  if (!exists(path)) return false;
  let content: string;
  try {
    content = read(path);
  } catch {
    // Present but unreadable: the conservative answer is the old one.
    return true;
  }
  // The prefix keeps a hand-written note ("1 maintenance") from reading as a
  // named writer that is gone.
  const writer = new RegExp(`^${DEPLOYMENT_MARKER_PREFIX} (\\d+) (.+?)\\s*$`).exec(content);
  return writer ? recordedProcessLive(Number(writer[1]), writer[2]!) : true;
}

/** Requests that may create or mutate durable/runtime state wait for deploy. */
export function requestWaitsForDeployment(
  method: string | undefined,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): boolean {
  if (!deploymentPaused(env, exists)) return false;
  const verb = (method ?? 'GET').toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS') return true;
  // OAuth uses redirects, so several GET routes are writes despite their
  // verb: login/authorize/connect create state, while callbacks consume it
  // and persist identity, installation or session data.
  return STATEFUL_GET_PATHS.has(pathname);
}
