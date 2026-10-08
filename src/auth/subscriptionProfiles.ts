import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { CodexModelCache, readCodexModels } from './codexModels.js';
import { subscriptionTransportEnv } from '../core/llmClaudeCli.js';
import { UNAVAILABLE_CODEX_MODELS, type CodexModelInventory } from '../contracts/codexModels.js';
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  accountSubscriptionsResponseSchema,
  accountSubscriptionProfileIdSchema,
  claudeSubscriptionTokenSchema,
  codexDeviceUserCodeSchema,
  codexSubscriptionAttemptSchema,
  type AccountSubscriptionProvider,
  type AccountSubscriptionReason,
  type AccountSubscriptionStatus,
  type AccountSubscriptionsResponse,
  type CodexSubscriptionAttempt,
} from '../contracts/accountSubscriptions.js';
import { organisationIdSchema, principalIdSchema } from '../contracts/projects.js';
import type { AuthStore, PrincipalSubscriptionReceipt } from './store.js';
import {
  acquireCodexHomeLease,
  CodexAppServerCapacityError,
  CodexAppServerConnection,
  CodexAppServerUnavailableError,
  MAX_CODEX_APP_SERVER_PROCESSES,
  type CodexAppServerNotification,
  type CodexAppServerSpawn,
  tryAcquireCodexHomeLease,
} from './codexAppServer.js';

export const ACCOUNT_PROFILES_ROOT_ENV = 'ATOMA_ACCOUNT_PROFILES_ROOT';
export const DEFAULT_CODEX_LOGIN_TTL_MS = 10 * 60 * 1_000;
/** Each pending login owns one app-server process; keep the 4 GiB VPS bounded. */
export const MAX_PENDING_CODEX_LOGINS = MAX_CODEX_APP_SERVER_PROCESSES;
const MAX_CODEX_LOGIN_TTL_MS = 30 * 60 * 1_000;
export const PROFILE_OWNER_FILENAME = '.atoma-profile-owner';
// Another server may still be completing an uncommitted login generation.
export const PROFILE_ORPHAN_GRACE_MS = MAX_CODEX_LOGIN_TTL_MS + 60_000;
const FAILED_ATTEMPT_TTL_MS = 60_000;
const CODEX_STATUS_FRESH_MS = 5 * 60 * 1_000;
/**
 * Every released Codex up to 0.154 sends `account/login/completed` BEFORE it
 * reloads its in-memory auth cache, and `account/read` answers from that
 * cache. An immediate read therefore sees no account although auth.json is
 * already written (prod incident 2026-09-15). Give the provider a bounded
 * window to settle, woken early by its `account/updated` notification.
 */
export const DEFAULT_LOGIN_ACCOUNT_SETTLE_MS = 5_000;
const LOGIN_ACCOUNT_RETRY_MS = 200;
/**
 * The pasted Claude Code token lives in ONE private file inside its
 * generation directory, which is also the run's `CLAUDE_CONFIG_DIR`. Claude
 * Code never names a file this way, so its own state writes cannot collide.
 */
export const CLAUDE_TOKEN_FILENAME = 'atoma-oauth-token';
const CLAUDE_AUTH_PROBE_TIMEOUT_MS = 15_000;
const runFile = promisify(execFile);

export class CodexSubscriptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSubscriptionConflictError';
  }
}

export class CodexSubscriptionCapacityError extends Error {
  constructor() {
    super(`too many pending Codex logins (limit ${MAX_PENDING_CODEX_LOGINS})`);
    this.name = 'CodexSubscriptionCapacityError';
  }
}

export class CodexSubscriptionUnavailableError extends Error {
  constructor(message = 'Codex CLI is unavailable') {
    super(message);
    this.name = 'CodexSubscriptionUnavailableError';
  }
}

/** The pasted value is not a Claude Code token, or the CLI did not accept it. */
export class ClaudeSubscriptionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSubscriptionTokenError';
  }
}

export class ClaudeSubscriptionUnavailableError extends Error {
  constructor(message = 'Claude Code CLI is unavailable') {
    super(message);
    this.name = 'ClaudeSubscriptionUnavailableError';
  }
}

export interface ClaudeAuthProbeInput {
  readonly profilePath: string;
  /** The subprocess environment: the token and the config dir already set. */
  readonly env: NodeJS.ProcessEnv;
}

export interface ClaudeAuthProbeResult {
  readonly loggedIn: boolean;
  readonly authMethod: string | null;
}

/**
 * `claude auth status --json` with the token in the environment. It is a
 * LOCAL check — the CLI reports which credential it would use, without a
 * network call — so it proves the CLI is installed and reads the token as its
 * OAuth bearer, not that the token is still valid upstream. Spending a model
 * call to prove that would bill the member for connecting.
 */
export type ClaudeAuthProbe = (input: ClaudeAuthProbeInput) => Promise<ClaudeAuthProbeResult>;

async function defaultClaudeAuthProbe(input: ClaudeAuthProbeInput): Promise<ClaudeAuthProbeResult> {
  const result = await runFile('claude', ['auth', 'status', '--json'], {
    env: input.env,
    cwd: input.profilePath,
    timeout: CLAUDE_AUTH_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
  });
  let parsed: { loggedIn?: unknown; authMethod?: unknown };
  try {
    parsed = JSON.parse(String(result.stdout)) as { loggedIn?: unknown; authMethod?: unknown };
  } catch {
    throw new ClaudeSubscriptionUnavailableError('Claude Code CLI did not answer the auth probe');
  }
  return {
    loggedIn: parsed.loggedIn === true,
    authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
  };
}

/** The probe's environment: the run transport's own snapshot rule, plus the two values that select this profile. */
function claudeProbeEnv(source: NodeJS.ProcessEnv, token: string, profilePath: string): NodeJS.ProcessEnv {
  const env = subscriptionTransportEnv(source);
  env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
  env['CLAUDE_CONFIG_DIR'] = profilePath;
  return env;
}

interface PendingAttempt {
  readonly principalId: string;
  readonly orgId: string;
  readonly attemptId: string;
  readonly profileId: string;
  readonly profilePath: string;
  loginId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAtMs: number;
  connection: CodexAppServerConnection | null;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
  state: 'connecting' | 'completing' | 'expiring' | 'error';
  reason: AccountSubscriptionReason | null;
}

interface StartingAttempt {
  readonly principalId: string;
  readonly orgId: string;
  readonly attemptId: string;
  readonly profileId: string;
  readonly profilePath: string;
  readonly controller: AbortController;
  promise: Promise<CodexSubscriptionAttempt> | null;
}

export interface CodexProfileForRun {
  readonly profileId: string;
  readonly homePath: string;
  readonly profilesRoot: string;
}

/**
 * The requester's Claude Code generation, resolved at launch. UNLIKE the
 * Codex one this CARRIES THE SECRET: Claude Code authenticates from an
 * environment variable, not from a home it reads itself, so the coordinator
 * must place the token into the child's allowlisted environment. It goes
 * there and nowhere else — never into a row, a journal detail or a response.
 */
export interface ClaudeProfileForRun {
  readonly profileId: string;
  /** The generation directory, handed to the child as `CLAUDE_CONFIG_DIR`. */
  readonly homePath: string;
  readonly profilesRoot: string;
  readonly oauthToken: string;
}

export interface AccountSubscriptionServiceOptions {
  readonly auth: AuthStore;
  /** Rechecked after async login/probing, before replacing any credential generation. */
  readonly canChangeProfile?: (principalId: string) => boolean;
  readonly profilesRoot?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly spawnFn?: CodexAppServerSpawn;
  readonly requestTimeoutMs?: number;
  readonly loginTtlMs?: number;
  /** How long a completed login may take to expose its account; see DEFAULT_LOGIN_ACCOUNT_SETTLE_MS. */
  readonly loginAccountSettleMs?: number;
  readonly now?: () => number;
  /** Injected by tests; the default runs the installed `claude` binary. */
  readonly probeClaudeAuth?: ClaudeAuthProbe;
  readonly onConnected?: (event: {
    principalId: string;
    orgId: string;
    provider: AccountSubscriptionProvider;
  }) => void | Promise<void>;
  readonly onDisconnected?: (event: {
    principalId: string;
    orgId: string;
    provider: AccountSubscriptionProvider;
  }) => void;
}

export interface AccountSubscriptionStatusOptions {
  /** Set false while a run owns CODEX_HOME; returns local state without spawning Codex. */
  readonly verify?: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ensurePrivateRoot(directory: string): string {
  if (path.parse(directory).root === directory) {
    throw new Error('account profiles root must not be a filesystem root');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('account profile path is not a private directory');
  }
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function ensurePrivateSubdirectory(root: string, segments: readonly string[]): string {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('account profile path is not a private directory');
    }
    if (process.platform !== 'win32') chmodSync(current, 0o700);
  }
  return current;
}

function privateDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (process.platform === 'win32' || (stat.mode & 0o777) === 0o700)
    );
  } catch {
    return false;
  }
}

function privateCredentialFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (process.platform === 'win32' || (stat.mode & 0o777) === 0o600)
    );
  } catch {
    return false;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeVerificationUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Codex returned no verification URL');
  const url = new URL(value);
  if (
    url.origin !== 'https://auth.openai.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/codex/device'
  ) {
    throw new Error('Codex returned an unexpected verification origin');
  }
  return url.href;
}

function loginResult(value: unknown): {
  loginId: string;
  verificationUrl: string;
  userCode: string;
} {
  if (!value || typeof value !== 'object') throw new Error('Codex returned an invalid login result');
  const result = value as Record<string, unknown>;
  const loginId = accountSubscriptionProfileIdSchema.safeParse(result['loginId']);
  const userCode = codexDeviceUserCodeSchema.safeParse(result['userCode']);
  if (
    result['type'] !== 'chatgptDeviceCode' ||
    !loginId.success ||
    !userCode.success
  ) {
    throw new Error('Codex returned an invalid device-code login result');
  }
  return {
    loginId: loginId.data,
    verificationUrl: safeVerificationUrl(result['verificationUrl']),
    userCode: userCode.data,
  };
}

function accountIsChatGpt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const account = (value as { account?: unknown }).account;
  return Boolean(account && typeof account === 'object' && (account as { type?: unknown }).type === 'chatgpt');
}

function completion(value: unknown): { success: boolean; loginId: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const params = value as { success?: unknown; loginId?: unknown };
  if (typeof params.success !== 'boolean') return null;
  return {
    success: params.success,
    loginId: typeof params.loginId === 'string' ? params.loginId : null,
  };
}

/**
 * Owns principal-scoped Codex login attempts and profile generations.
 * Pending device codes are memory-only; a restart merely asks the user to
 * start again. The consolidated auth store holds the current non-secret
 * generation receipt, while Codex alone reads/writes credential bytes.
 */
export class AccountSubscriptionService {
  private readonly modelCache = new CodexModelCache(() => this.now());
  private readonly auth: AuthStore;
  private readonly root: string;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly spawnFn: CodexAppServerSpawn | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly loginTtlMs: number;
  private readonly loginAccountSettleMs: number;
  private readonly now: () => number;
  private readonly probeClaudeAuth: ClaudeAuthProbe;
  private readonly onConnected: AccountSubscriptionServiceOptions['onConnected'];
  private readonly canChangeProfile: (principalId: string) => boolean;
  private readonly onDisconnected: AccountSubscriptionServiceOptions['onDisconnected'];
  private readonly profilesSupported: boolean;
  private readonly lifecycle = new AbortController();
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly starting = new Map<string, StartingAttempt>();
  private readonly statusChecks = new Map<string, Promise<AccountSubscriptionStatus>>();
  private closed = false;

  constructor(options: AccountSubscriptionServiceOptions) {
    this.auth = options.auth;
    const sourceEnv = options.sourceEnv ?? process.env;
    const requestedRoot = path.resolve(
      options.profilesRoot?.trim() ||
        sourceEnv[ACCOUNT_PROFILES_ROOT_ENV]?.trim() ||
        path.join(homedir(), '.atoma', 'account-profiles')
    );
    // Node's POSIX mode bits do not prove a private Windows ACL. Personal
    // credential profiles remain unavailable there until ACL validation is
    // implemented; accepting chmod's emulation would be fail-open.
    this.profilesSupported = process.platform !== 'win32';
    this.root = this.profilesSupported ? ensurePrivateRoot(requestedRoot) : requestedRoot;
    this.sourceEnv = { ...sourceEnv };
    this.spawnFn = options.spawnFn;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.loginTtlMs =
      options.loginTtlMs !== undefined &&
      Number.isFinite(options.loginTtlMs) &&
      options.loginTtlMs > 0
        ? Math.min(Math.trunc(options.loginTtlMs), MAX_CODEX_LOGIN_TTL_MS)
        : DEFAULT_CODEX_LOGIN_TTL_MS;
    this.loginAccountSettleMs =
      options.loginAccountSettleMs !== undefined &&
      Number.isFinite(options.loginAccountSettleMs) &&
      options.loginAccountSettleMs >= 0
        ? Math.trunc(options.loginAccountSettleMs)
        : DEFAULT_LOGIN_ACCOUNT_SETTLE_MS;
    this.now = options.now ?? Date.now;
    this.probeClaudeAuth = options.probeClaudeAuth ?? defaultClaudeAuthProbe;
    this.canChangeProfile = options.canChangeProfile ?? (() => true);
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    if (this.profilesSupported) this.reconcileProfiles();
  }

  async status(
    principalIdInput: string,
    options: AccountSubscriptionStatusOptions = {}
  ): Promise<AccountSubscriptionsResponse> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const attempt = this.attempts.get(principalId);
    const codex = await this.codexStatus(principalId, options.verify !== false);
    return accountSubscriptionsResponseSchema.parse({
      claude: this.readClaudeStatus(principalId),
      codex,
      codexAttempt: attempt ? this.publicAttempt(attempt) : null,
    });
  }

  private assertProfileIdle(principalId: string): void {
    if (!this.canChangeProfile(principalId)) throw new CodexSubscriptionConflictError('Wait for the assistant or cancel the active run before changing the subscription.');
  }

  /**
   * CONNECT A CLAUDE CODE TOKEN (BETA, owner decision 2026-10-08). No device
   * flow: the member runs `claude setup-token` where Claude Code is signed in
   * and pastes the long-lived token. The probe runs BEFORE the file exists —
   * it needs only the environment — so a refused token leaves no credential
   * byte behind; a committed one replaces the previous generation atomically
   * through the receipt, as a Codex re-login does.
   */
  async connectClaude(
    principalIdInput: string,
    orgId: string,
    tokenInput: unknown
  ): Promise<AccountSubscriptionStatus> {
    if (this.closed) throw new ClaudeSubscriptionUnavailableError('subscription service is closed');
    if (!this.profilesSupported) {
      throw new ClaudeSubscriptionUnavailableError(
        'personal Claude profiles require verified POSIX permissions'
      );
    }
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsedOrgId = organisationIdSchema.parse(orgId);
    const token = claudeSubscriptionTokenSchema.safeParse(tokenInput);
    if (!token.success) {
      throw new ClaudeSubscriptionTokenError(
        'expected the long-lived token printed by `claude setup-token`'
      );
    }
    const profileId = randomUUID();
    const profilePath = this.profilePath(principalId, profileId, 'claude');
    this.createProfile(principalId, 'claude', profileId);
    try {
      let probe: ClaudeAuthProbeResult;
      try {
        probe = await this.probeClaudeAuth({
          profilePath,
          env: claudeProbeEnv(this.sourceEnv, token.data, profilePath),
        });
      } catch (error) {
        if (error instanceof ClaudeSubscriptionUnavailableError) throw error;
        // ENOENT, a timeout, a non-zero exit: the deployment, not the token.
        // Stable text only — a spawn error message carries the command line.
        throw new ClaudeSubscriptionUnavailableError();
      }
      if (!probe.loggedIn) {
        throw new ClaudeSubscriptionTokenError('the Claude Code CLI did not accept this token');
      }
      this.assertProfileIdle(principalId);
      this.writeClaudeToken(profilePath, token.data);
      if (!privateCredentialFile(path.join(profilePath, CLAUDE_TOKEN_FILENAME))) {
        throw new ClaudeSubscriptionUnavailableError(
          'the Claude token file failed the private-ownership checks'
        );
      }
    } catch (error) {
      this.removeProfile(principalId, profileId, 'claude');
      throw error;
    }
    const previous = this.auth.principalSubscription(principalId, 'claude');
    this.auth.setPrincipalSubscription({ principalId, provider: 'claude', profileId });
    if (previous && previous.profileId !== profileId) {
      this.removeProfile(principalId, previous.profileId, 'claude');
    }
    try {
      await this.onConnected?.({ principalId, orgId: parsedOrgId, provider: 'claude' });
    } catch {
      // An observer cannot roll back a committed token.
    }
    return this.readClaudeStatus(principalId);
  }

  async disconnectClaude(principalIdInput: string, orgId: string): Promise<boolean> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsedOrgId = organisationIdSchema.parse(orgId);
    this.assertProfileIdle(principalId);
    // Receipt first, like Codex: new runs fail closed from this point.
    const receipt = this.auth.deletePrincipalSubscription(principalId, 'claude');
    if (!receipt) return false;
    this.removeProfile(principalId, receipt.profileId, 'claude');
    try {
      this.onDisconnected?.({ principalId, orgId: parsedOrgId, provider: 'claude' });
    } catch {
      // An observer cannot undo the local disconnect.
    }
    return true;
  }

  /**
   * Synchronous launch-time resolver, like `codexProfileForRun`: the exact
   * current generation or nothing, never a fallback to the host's login. The
   * token is read here, once per launch, and handed to the coordinator for
   * the child's environment only.
   */
  claudeProfileForRun(principalIdInput: string): ClaudeProfileForRun | null {
    const principalId = principalIdSchema.parse(principalIdInput);
    if (!this.profilesSupported) return null;
    const receipt = this.auth.principalSubscription(principalId, 'claude');
    if (!receipt || receipt.state !== 'connected' || !this.claudeProfileUsable(principalId, receipt)) {
      return null;
    }
    const homePath = this.profilePath(principalId, receipt.profileId, 'claude');
    let stored: string;
    try {
      stored = readFileSync(path.join(homePath, CLAUDE_TOKEN_FILENAME), 'utf8').trim();
    } catch {
      return null;
    }
    const token = claudeSubscriptionTokenSchema.safeParse(stored);
    if (!token.success) return null;
    return { profileId: receipt.profileId, homePath, profilesRoot: this.root, oauthToken: token.data };
  }

  async startCodexLogin(principalIdInput: string, orgId: string): Promise<CodexSubscriptionAttempt> {
    if (this.closed) throw new CodexSubscriptionUnavailableError('subscription service is closed');
    if (!this.profilesSupported) {
      throw new CodexSubscriptionUnavailableError(
        'personal Codex profiles require verified POSIX permissions'
      );
    }
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsedOrgId = organisationIdSchema.parse(orgId);
    const receipt = this.auth.principalSubscription(principalId, 'codex');
    if (receipt?.state === 'connected' && this.profileUsable(principalId, receipt)) {
      throw new CodexSubscriptionConflictError('the Codex subscription is already connected');
    }
    const starting = this.starting.get(principalId);
    if (starting?.promise) return starting.promise;
    const existing = this.attempts.get(principalId);
    if (existing && existing.state !== 'error') return this.publicAttempt(existing);
    if (existing) {
      this.attempts.delete(principalId);
      this.disposeAttempt(existing, true);
    }
    if (this.attempts.size + this.starting.size >= MAX_PENDING_CODEX_LOGINS) {
      throw new CodexSubscriptionCapacityError();
    }

    const profileId = randomUUID();
    const profilePath = this.profilePath(principalId, profileId);
    this.createProfile(principalId, 'codex', profileId);
    const operation: StartingAttempt = {
      principalId,
      orgId: parsedOrgId,
      attemptId: randomUUID(),
      profileId,
      profilePath,
      controller: new AbortController(),
      promise: null,
    };
    this.starting.set(principalId, operation);
    const promise = this.beginCodexLogin(operation);
    operation.promise = promise;
    return promise;
  }

  private async beginCodexLogin(operation: StartingAttempt): Promise<CodexSubscriptionAttempt> {
    let connection: CodexAppServerConnection | null = null;
    try {
      connection = await this.open(operation.profilePath, operation.controller.signal);
      if (
        operation.controller.signal.aborted ||
        this.closed ||
        this.starting.get(operation.principalId)?.attemptId !== operation.attemptId
      ) {
        throw new CodexSubscriptionConflictError('the Codex login was cancelled');
      }
      let pending: PendingAttempt | null = null;
      let earlyCompletion: CodexAppServerNotification | null = null;
      const unsubscribe = connection.onNotification((notification) => {
        if (notification.method !== 'account/login/completed') return;
        if (pending) {
          void this.handleNotification(pending, notification);
        } else {
          earlyCompletion = notification;
        }
      });
      const started = loginResult(
        await connection.request('account/login/start', { type: 'chatgptDeviceCode' })
      );
      if (
        operation.controller.signal.aborted ||
        this.closed ||
        this.starting.get(operation.principalId)?.attemptId !== operation.attemptId
      ) {
        throw new CodexSubscriptionConflictError('the Codex login was cancelled');
      }
      const expiresAtMs = this.now() + this.loginTtlMs;
      const timer = setTimeout(() => {
        void this.expireAttempt(operation.principalId, operation.attemptId);
      }, this.loginTtlMs);
      timer.unref?.();
      pending = {
        principalId: operation.principalId,
        orgId: operation.orgId,
        attemptId: operation.attemptId,
        profileId: operation.profileId,
        profilePath: operation.profilePath,
        loginId: started.loginId,
        verificationUrl: started.verificationUrl,
        userCode: started.userCode,
        expiresAtMs,
        connection,
        timer,
        unsubscribe,
        state: 'connecting',
        reason: null,
      };
      this.attempts.set(operation.principalId, pending);
      if (earlyCompletion) void this.handleNotification(pending, earlyCompletion);
      return this.publicAttempt(pending);
    } catch (error) {
      if (connection) await connection.closeAndWait();
      await this.removeProfileWhenIdle(operation.principalId, operation.profileId);
      if (error instanceof CodexAppServerUnavailableError) {
        throw new CodexSubscriptionUnavailableError();
      }
      if (error instanceof CodexAppServerCapacityError) {
        throw new CodexSubscriptionCapacityError();
      }
      if (operation.controller.signal.aborted || this.closed) {
        throw new CodexSubscriptionConflictError('the Codex login was cancelled');
      }
      throw error;
    } finally {
      if (this.starting.get(operation.principalId)?.attemptId === operation.attemptId) {
        this.starting.delete(operation.principalId);
      }
    }
  }

  async cancelCodexLogin(principalIdInput: string): Promise<boolean> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const starting = this.starting.get(principalId);
    if (starting) starting.controller.abort();
    const attempt = this.attempts.get(principalId);
    if (!attempt) return starting !== undefined;
    this.attempts.delete(principalId);
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    try {
      if (attempt.connection && attempt.loginId) {
        await attempt.connection.request('account/login/cancel', { loginId: attempt.loginId });
      }
    } catch {
      // Local cancellation still wins; the private staging profile is removed.
    } finally {
      const connection = attempt.connection;
      attempt.connection = null;
      if (connection) await connection.closeAndWait();
      await this.removeProfileWhenIdle(attempt.principalId, attempt.profileId);
    }
    return true;
  }

  async disconnectCodex(principalIdInput: string, orgId: string): Promise<boolean> {
    const principalId = principalIdSchema.parse(principalIdInput);
    const parsedOrgId = organisationIdSchema.parse(orgId);
    this.assertProfileIdle(principalId);
    // Delete the receipt BEFORE awaiting the provider: new runs fail closed
    // from this point even if cancellation/app-server is slow or unavailable.
    const receipt = this.auth.deletePrincipalSubscription(principalId, 'codex');
    await this.cancelCodexLogin(principalId);
    if (!receipt) return false;
    const profilePath = this.profilePath(principalId, receipt.profileId);
    if (this.profileUsable(principalId, receipt)) {
      try {
        const connection = await this.open(profilePath);
        try {
          await connection.request('account/logout');
        } finally {
          await connection.closeAndWait();
        }
      } catch {
        // Disconnect is local authority. Removing the exact owned generation
        // is the fallback when an upgraded/missing CLI cannot perform logout.
      }
    }
    await this.removeProfileWhenIdle(principalId, receipt.profileId);
    try {
      this.onDisconnected?.({ principalId, orgId: parsedOrgId, provider: 'codex' });
    } catch {
      // An observer cannot undo the local disconnect or leak its credential.
    }
    return true;
  }

  /** Discover only through this principal's current private generation. */
  async codexModels(principalId: string, refresh = false, cachedOnly = false): Promise<CodexModelInventory> {
    const profile = this.codexProfileForRun(principalId);
    if (!profile || this.closed) return UNAVAILABLE_CODEX_MODELS;
    if (cachedOnly) return this.modelCache.peek(`${principalId}:${profile.profileId}`);
    const inventory = await this.modelCache.get(`${principalId}:${profile.profileId}`, async () => {
      const connection = await this.open(profile.homePath, AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(30_000)]));
      try {
        if (!accountIsChatGpt(await connection.request('account/read', { refreshToken: false }))) {
          throw new Error('ChatGPT authentication is required');
        }
        return await readCodexModels((method, params) => connection.request(method, params));
      } finally {
        await connection.closeAndWait();
      }
    }, refresh);
    // A disconnect/reconnect during discovery must never publish the old account's catalogue.
    return this.codexProfileForRun(principalId)?.profileId === profile.profileId
      ? inventory : UNAVAILABLE_CODEX_MODELS;
  }

  /** Synchronous launch-time resolver: no network and no fallback profile. */
  codexProfileForRun(principalIdInput: string): CodexProfileForRun | null {
    const principalId = principalIdSchema.parse(principalIdInput);
    if (!this.profilesSupported || this.statusChecks.has(principalId)) return null;
    const receipt = this.auth.principalSubscription(principalId, 'codex');
    if (!receipt || receipt.state !== 'connected' || !this.profileUsable(principalId, receipt)) {
      return null;
    }
    return {
      profileId: receipt.profileId,
      homePath: this.profilePath(principalId, receipt.profileId),
      profilesRoot: this.root,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifecycle.abort();
    for (const operation of this.starting.values()) operation.controller.abort();
    this.starting.clear();
    for (const attempt of this.attempts.values()) this.disposeAttempt(attempt, true);
    this.attempts.clear();
    this.statusChecks.clear();
  }

  private async codexStatus(
    principalId: string,
    verify: boolean
  ): Promise<AccountSubscriptionStatus> {
    if (!verify) return this.readCodexStatus(principalId, false);
    const existing = this.statusChecks.get(principalId);
    if (existing) return existing;
    const liveAttempts = [...this.attempts.values()].filter(
      (attempt) => attempt.connection !== null
    ).length;
    if (
      liveAttempts + this.starting.size + this.statusChecks.size >=
      MAX_PENDING_CODEX_LOGINS
    ) {
      // Status verification is advisory; never exceed the same app-server
      // process budget that protects device login on the 4 GiB deployment.
      return this.readCodexStatus(principalId, false);
    }
    const check = this.readCodexStatus(principalId, true);
    this.statusChecks.set(principalId, check);
    try {
      return await check;
    } finally {
      if (this.statusChecks.get(principalId) === check) this.statusChecks.delete(principalId);
    }
  }

  private async readCodexStatus(
    principalId: string,
    verify: boolean
  ): Promise<AccountSubscriptionStatus> {
    const receipt = this.auth.principalSubscription(principalId, 'codex');
    const attempt = this.attempts.get(principalId);
    if (!this.profilesSupported) {
      return receipt
        ? this.receiptStatus(receipt, 'unavailable', 'profile-permissions-unsupported')
        : {
            provider: 'codex',
            state: 'unavailable',
            connectedAt: null,
            lastVerifiedAt: null,
            reason: 'profile-permissions-unsupported',
          };
    }
    if (!receipt) {
      if (attempt) {
        return {
          provider: 'codex',
          state: attempt.state === 'error' ? 'error' : 'connecting',
          connectedAt: null,
          lastVerifiedAt: null,
          reason: attempt.reason,
        };
      }
      return {
        provider: 'codex',
        state: 'disconnected',
        connectedAt: null,
        lastVerifiedAt: null,
        reason: null,
      };
    }
    if (!this.profileUsable(principalId, receipt)) {
      const marked = this.auth.markPrincipalSubscriptionVerified(
        principalId,
        'codex',
        'reauth_required',
        receipt.profileId
      );
      return marked
        ? this.receiptStatus(marked, 'reauth_required', 'authentication-required')
        : this.disconnectedStatus();
    }
    if (!verify) return this.currentReceiptStatus(receipt);
    const lastVerifiedMs =
      receipt.lastVerifiedAt === null ? Number.NaN : Date.parse(receipt.lastVerifiedAt);
    const verificationAgeMs = this.now() - lastVerifiedMs;
    if (
      receipt.state === 'connected' &&
      Number.isFinite(verificationAgeMs) &&
      verificationAgeMs >= 0 &&
      verificationAgeMs < CODEX_STATUS_FRESH_MS
    ) {
      return this.receiptStatus(receipt, 'connected', null);
    }
    try {
      const connection = await this.open(this.profilePath(principalId, receipt.profileId));
      let account: unknown;
      try {
        // Status is observational. Browser polling must not rotate provider
        // credentials; actual Codex use remains responsible for any refresh.
        account = await connection.request('account/read', { refreshToken: false });
      } finally {
        await connection.closeAndWait();
      }
      const current = this.auth.principalSubscription(principalId, 'codex');
      if (!current || current.profileId !== receipt.profileId) {
        return this.currentReceiptStatus(current);
      }
      if (!accountIsChatGpt(account)) {
        const marked = this.auth.markPrincipalSubscriptionVerified(
          principalId,
          'codex',
          'reauth_required',
          receipt.profileId
        );
        return marked
          ? this.receiptStatus(marked, 'reauth_required', 'authentication-required')
          : this.disconnectedStatus();
      }
      const marked = this.auth.markPrincipalSubscriptionVerified(
        principalId,
        'codex',
        'connected',
        receipt.profileId
      );
      return marked
        ? this.receiptStatus(marked, 'connected', null)
        : this.disconnectedStatus();
    } catch (error) {
      const current = this.auth.principalSubscription(principalId, 'codex');
      if (!current || current.profileId !== receipt.profileId) {
        return this.currentReceiptStatus(current);
      }
      if (error instanceof CodexAppServerUnavailableError) {
        return this.receiptStatus(receipt, 'unavailable', 'codex-cli-unavailable');
      }
      if (error instanceof CodexAppServerCapacityError) {
        return this.currentReceiptStatus(receipt);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found|cannot find/i.test(message)) {
        return this.receiptStatus(receipt, 'unavailable', 'codex-cli-unavailable');
      }
      return this.receiptStatus(receipt, 'error', 'login-failed');
    }
  }

  /**
   * Local, no subprocess: the receipt and the private token file decide. A
   * token that upstream has since revoked surfaces at the first call of the
   * next run, as the CLI's own refusal, exactly as for the host's login.
   */
  private readClaudeStatus(principalId: string): AccountSubscriptionStatus {
    const receipt = this.auth.principalSubscription(principalId, 'claude');
    if (!this.profilesSupported) {
      return receipt
        ? this.receiptStatus(receipt, 'unavailable', 'profile-permissions-unsupported')
        : {
            provider: 'claude',
            state: 'unavailable',
            connectedAt: null,
            lastVerifiedAt: null,
            reason: 'profile-permissions-unsupported',
          };
    }
    if (!receipt) return this.disconnectedStatus('claude');
    if (!this.claudeProfileUsable(principalId, receipt)) {
      const marked = this.auth.markPrincipalSubscriptionVerified(
        principalId,
        'claude',
        'reauth_required',
        receipt.profileId
      );
      return marked
        ? this.receiptStatus(marked, 'reauth_required', 'authentication-required')
        : this.disconnectedStatus('claude');
    }
    return this.currentReceiptStatus(receipt);
  }

  private claudeProfileUsable(principalId: string, receipt: PrincipalSubscriptionReceipt): boolean {
    if (receipt.principalId !== principalId || receipt.provider !== 'claude') return false;
    const profilePath = this.profilePath(principalId, receipt.profileId, 'claude');
    return (
      this.profileDirectoriesUsable(principalId, receipt.profileId, 'claude') &&
      privateCredentialFile(path.join(profilePath, CLAUDE_TOKEN_FILENAME))
    );
  }

  /** Create-exclusive, 0600 from the first byte, never through a link. */
  private writeClaudeToken(profilePath: string, token: string): void {
    const target = path.join(profilePath, CLAUDE_TOKEN_FILENAME);
    const descriptor = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600
    );
    try {
      writeSync(descriptor, `${token}\n`);
      if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  }

  private receiptStatus(
    receipt: PrincipalSubscriptionReceipt,
    state: AccountSubscriptionStatus['state'],
    reason: AccountSubscriptionReason | null
  ): AccountSubscriptionStatus {
    return {
      provider: receipt.provider,
      state,
      connectedAt: receipt.connectedAt,
      lastVerifiedAt: receipt.lastVerifiedAt,
      reason,
    };
  }

  private disconnectedStatus(provider: AccountSubscriptionProvider = 'codex'): AccountSubscriptionStatus {
    return {
      provider,
      state: 'disconnected',
      connectedAt: null,
      lastVerifiedAt: null,
      reason: null,
    };
  }

  private currentReceiptStatus(
    receipt: PrincipalSubscriptionReceipt | null
  ): AccountSubscriptionStatus {
    if (!receipt) return this.disconnectedStatus();
    return receipt.state === 'connected'
      ? this.receiptStatus(receipt, 'connected', null)
      : this.receiptStatus(receipt, 'reauth_required', 'authentication-required');
  }

  private async handleNotification(
    attempt: PendingAttempt,
    notification: CodexAppServerNotification
  ): Promise<void> {
    if (notification.method !== 'account/login/completed') return;
    const result = completion(notification.params);
    if (!result || result.loginId !== attempt.loginId) return;
    if (this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId) return;
    if (attempt.state !== 'connecting') return;
    if (!result.success) {
      this.failAttempt(attempt, 'login-failed');
      return;
    }
    attempt.state = 'completing';
    try {
      if (!attempt.connection) throw new Error('Codex login connection was closed');
      const account = await this.readSettledAccount(attempt, attempt.connection);
      if (
        this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId ||
        attempt.state !== 'completing'
      ) {
        return;
      }
      if (!accountIsChatGpt(account)) {
        // Stable text only: no principal, path, code or provider payload.
        console.warn(
          '[account subscriptions] Codex reported a completed login but no ChatGPT account within the settle window'
        );
        this.failAttempt(attempt, 'authentication-required');
        return;
      }
      if (!this.secureCredentialFile(attempt)) {
        console.warn(
          '[account subscriptions] Codex login completed but its credential file failed the private-ownership checks'
        );
        this.failAttempt(attempt, 'authentication-required');
        return;
      }
      const previous = this.auth.principalSubscription(attempt.principalId, 'codex');
      const connection = attempt.connection;
      if (!connection) throw new Error('Codex login connection was closed');
      attempt.connection = null;
      await connection.closeAndWait();
      if (
        this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId ||
        attempt.state !== 'completing'
      ) {
        return;
      }
      this.assertProfileIdle(attempt.principalId);
      this.auth.setPrincipalSubscription({
        principalId: attempt.principalId,
        provider: 'codex',
        profileId: attempt.profileId,
      });
      this.attempts.delete(attempt.principalId);
      clearTimeout(attempt.timer);
      attempt.unsubscribe();
      if (previous && previous.profileId !== attempt.profileId) {
        await this.removeProfileWhenIdle(attempt.principalId, previous.profileId);
      }
      try {
        await this.onConnected?.({
          principalId: attempt.principalId,
          orgId: attempt.orgId,
          provider: 'codex',
        });
      } catch {
        // An observer cannot roll back a completed provider-owned login.
      }
    } catch {
      if (this.attempts.get(attempt.principalId)?.attemptId === attempt.attemptId) {
        this.failAttempt(attempt, 'login-failed');
      }
    }
  }

  /**
   * Read the account until Codex exposes a ChatGPT one or the settle window
   * closes. Never refreshes tokens; a closed connection or a cancelled attempt
   * ends the loop with the last observation.
   */
  private async readSettledAccount(
    attempt: PendingAttempt,
    connection: CodexAppServerConnection
  ): Promise<unknown> {
    const deadline = this.now() + this.loginAccountSettleMs;
    let wake: (() => void) | null = null;
    const unsubscribe = connection.onNotification((notification) => {
      if (notification.method === 'account/updated') wake?.();
    });
    try {
      while (true) {
        const account = await connection.request('account/read', { refreshToken: false });
        if (accountIsChatGpt(account)) return account;
        const remaining = deadline - this.now();
        if (
          remaining <= 0 ||
          this.attempts.get(attempt.principalId)?.attemptId !== attempt.attemptId ||
          attempt.state !== 'completing'
        ) {
          return account;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(LOGIN_ACCOUNT_RETRY_MS, remaining));
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      unsubscribe();
    }
  }

  private failAttempt(attempt: PendingAttempt, reason: AccountSubscriptionReason): void {
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    const connection = attempt.connection;
    attempt.connection = null;
    this.scheduleProfileRemoval(attempt.principalId, attempt.profileId, connection);
    // A failed device code must not linger in memory for the life of the
    // service. Keep only a short, non-sensitive status receipt for the UI.
    attempt.loginId = null;
    attempt.verificationUrl = null;
    attempt.userCode = null;
    attempt.state = 'error';
    attempt.reason = reason;
    attempt.expiresAtMs = this.now() + FAILED_ATTEMPT_TTL_MS;
    attempt.timer = setTimeout(() => {
      if (this.attempts.get(attempt.principalId)?.attemptId === attempt.attemptId) {
        this.attempts.delete(attempt.principalId);
      }
    }, FAILED_ATTEMPT_TTL_MS);
    attempt.timer.unref?.();
  }

  private async expireAttempt(principalId: string, attemptId: string): Promise<void> {
    const attempt = this.attempts.get(principalId);
    if (!attempt || attempt.attemptId !== attemptId || attempt.state !== 'connecting') return;
    // Claim expiry synchronously, before the provider cancellation yields.
    // A completion that already reached `completing` wins; one arriving after
    // this point observes `expiring` and cannot commit a receipt that expiry
    // would subsequently delete.
    attempt.state = 'expiring';
    try {
      if (attempt.connection && attempt.loginId) {
        await attempt.connection.request('account/login/cancel', { loginId: attempt.loginId });
      }
    } catch {
      // Expiry is authoritative locally.
    }
    if (
      this.attempts.get(principalId)?.attemptId !== attemptId ||
      attempt.state !== 'expiring'
    ) {
      return;
    }
    this.failAttempt(attempt, 'login-expired');
  }

  private publicAttempt(attempt: PendingAttempt): CodexSubscriptionAttempt {
    const connecting = attempt.state !== 'error';
    return codexSubscriptionAttemptSchema.parse({
      attemptId: attempt.attemptId,
      state: connecting ? 'connecting' : 'error',
      verificationUrl: connecting ? attempt.verificationUrl : null,
      userCode: connecting ? attempt.userCode : null,
      expiresAt: iso(attempt.expiresAtMs),
      reason: attempt.reason,
    });
  }

  private profilePath(
    principalIdInput: string,
    profileIdInput: string,
    provider: AccountSubscriptionProvider = 'codex'
  ): string {
    const principalId = principalIdSchema.parse(principalIdInput);
    const profileId = accountSubscriptionProfileIdSchema.parse(profileIdInput);
    const candidate = path.resolve(this.root, principalId, provider, profileId);
    const prefix = `${this.root}${path.sep}`;
    if (!candidate.startsWith(prefix)) throw new Error('account profile escaped its root');
    return candidate;
  }

  private profileUsable(principalId: string, receipt: PrincipalSubscriptionReceipt): boolean {
    if (receipt.principalId !== principalId || receipt.provider !== 'codex') return false;
    const profilePath = this.profilePath(principalId, receipt.profileId);
    return (
      this.profileDirectoriesUsable(principalId, receipt.profileId) &&
      privateCredentialFile(path.join(profilePath, 'auth.json'))
    );
  }

  private removeProfile(
    principalId: string,
    profileId: string,
    provider: AccountSubscriptionProvider = 'codex'
  ): void {
    if (!this.profilesSupported) return;
    const target = this.profilePath(principalId, profileId, provider);
    const principalPath = path.join(this.root, principalId);
    const providerPath = path.join(principalPath, provider);
    try {
      // Never traverse a replaced parent link during cleanup. Leaving an
      // unreachable staging generation is safer than deleting outside root.
      if (!privateDirectory(this.root)) return;
      if (!privateDirectory(principalPath) || !privateDirectory(providerPath)) return;
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        unlinkSync(target);
        return;
      }
      // Exact UUID-derived path, with every parent checked; never a glob.
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Cleanup remains fail-closed and never follows an unsafe substitute.
    }
  }

  private async removeProfileWhenIdle(principalId: string, profileId: string): Promise<void> {
    if (!this.profilesSupported) return;
    const profilePath = this.profilePath(principalId, profileId);
    const release = await acquireCodexHomeLease(profilePath);
    try {
      this.removeProfile(principalId, profileId);
    } finally {
      release();
    }
  }

  private scheduleProfileRemoval(
    principalId: string,
    profileId: string,
    connection: CodexAppServerConnection | null
  ): void {
    void (async () => {
      if (connection) await connection.closeAndWait();
      await this.removeProfileWhenIdle(principalId, profileId);
    })().catch(() => {
      // Failing closed leaves an unreferenced UUID for startup reconciliation.
    });
  }

  private disposeAttempt(attempt: PendingAttempt, removeProfile: boolean): void {
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    const connection = attempt.connection;
    attempt.connection = null;
    if (removeProfile) {
      this.scheduleProfileRemoval(attempt.principalId, attempt.profileId, connection);
    } else {
      connection?.close();
    }
  }

  private secureCredentialFile(attempt: PendingAttempt): boolean {
    const authPath = path.join(attempt.profilePath, 'auth.json');
    let descriptor: number | null = null;
    try {
      if (!this.profileDirectoriesUsable(attempt.principalId, attempt.profileId)) return false;
      descriptor = openSync(
        authPath,
        constants.O_RDONLY |
          constants.O_NONBLOCK |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
      );
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return false;
      if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
      const after = fstatSync(descriptor);
      return (
        after.isFile() &&
        after.nlink === 1 &&
        (process.platform === 'win32' || (after.mode & 0o777) === 0o600)
      );
    } catch {
      return false;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  private profileDirectoriesUsable(
    principalId: string,
    profileId: string,
    provider: AccountSubscriptionProvider = 'codex'
  ): boolean {
    if (!this.profilesSupported) return false;
    const principalPath = path.join(this.root, principalId);
    const providerPath = path.join(principalPath, provider);
    const profilePath = this.profilePath(principalId, profileId, provider);
    try {
      return (
        privateDirectory(this.root) &&
        privateDirectory(principalPath) &&
        privateDirectory(providerPath) &&
        privateDirectory(profilePath) &&
        pathInside(realpathSync(this.root), realpathSync(profilePath))
      );
    } catch {
      return false;
    }
  }

  private createProfile(principalId: string, provider: AccountSubscriptionProvider, profileId: string): void {
    const directory = ensurePrivateSubdirectory(this.root, [principalId, provider, profileId]);
    writeFileSync(path.join(directory, PROFILE_OWNER_FILENAME), this.auth.subscriptionProfileOwner, {
      mode: 0o600, flag: 'wx',
    });
  }

  private ownsExpiredProfile(principalId: string, provider: AccountSubscriptionProvider, profileId: string): boolean {
    if (!this.profileDirectoriesUsable(principalId, profileId, provider)) return false;
    const marker = path.join(this.profilePath(principalId, profileId, provider), PROFILE_OWNER_FILENAME);
    try {
      if (!privateCredentialFile(marker)) return false;
      const stat = lstatSync(marker);
      return stat.size === 64 && this.now() - stat.mtimeMs > PROFILE_ORPHAN_GRACE_MS &&
        readFileSync(marker, 'utf8') === this.auth.subscriptionProfileOwner;
    } catch { return false; }
  }

  /** Only this physical store's old, unreferenced staging generations are ours to remove.
   * An empty/test/copied store cannot infer ownership from a missing receipt.
   * Legacy generations have no proof of ownership and are deliberately preserved.
   */
  private reconcileProfiles(): void {
    const providers: readonly AccountSubscriptionProvider[] = ['codex', 'claude'];
    const referenced = new Map<string, Set<string>>();
    try {
      for (const principal of this.auth.listPrincipals()) {
        for (const provider of providers) {
          const receipt = this.auth.principalSubscription(principal.principalId, provider);
          if (!receipt) continue;
          const key = `${principal.principalId}/${provider}`;
          const profiles = referenced.get(key) ?? new Set<string>();
          profiles.add(receipt.profileId);
          referenced.set(key, profiles);
        }
      }
    } catch {
      // If the store cannot prove the complete reference set, preserve every
      // credential generation. Partial knowledge must never authorize deletion.
      return;
    }

    let principalEntries: Dirent[];
    try {
      if (!privateDirectory(this.root)) return;
      principalEntries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const principalEntry of principalEntries) {
      const principal = principalIdSchema.safeParse(principalEntry.name);
      if (!principal.success || !principalEntry.isDirectory() || principalEntry.isSymbolicLink()) {
        continue;
      }
      const principalPath = path.join(this.root, principal.data);
      if (!privateDirectory(principalPath)) continue;
      for (const provider of providers) {
        const providerPath = path.join(principalPath, provider);
        if (!privateDirectory(providerPath)) continue;
        let generations: Dirent[];
        try {
          generations = readdirSync(providerPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const generation of generations) {
          const profileId = accountSubscriptionProfileIdSchema.safeParse(generation.name);
          if (!profileId.success) continue;
          if (referenced.get(`${principal.data}/${provider}`)?.has(profileId.data)) continue;
          if (generation.isSymbolicLink() || !generation.isDirectory()) continue;
          if (!this.ownsExpiredProfile(principal.data, provider, profileId.data)) continue;
          if (provider === 'claude') {
            // The grace period exceeds the bounded Claude authentication probe.
            this.removeProfile(principal.data, profileId.data, provider);
            continue;
          }
          const release = tryAcquireCodexHomeLease(
            this.profilePath(principal.data, profileId.data)
          );
          if (!release) continue;
          try {
            this.removeProfile(principal.data, profileId.data);
          } finally {
            release();
          }
        }
      }
    }
  }

  private open(profilePath: string, signal?: AbortSignal): Promise<CodexAppServerConnection> {
    return CodexAppServerConnection.open({
      profilePath,
      profilesRoot: this.root,
      sourceEnv: this.sourceEnv,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      ...(this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
      signal: signal ?? this.lifecycle.signal,
    });
  }
}
