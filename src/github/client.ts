import { readRepositoryArchive } from './repositoryArchive.js';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import { createHash } from 'node:crypto';
import { repositoryTreeEntrySchema, type RepositoryTreeEntry } from '../contracts/repositorySync.js';
import type { KeyObject } from 'node:crypto';
import { canonicalGitHubId } from './config.js';
import { createGitHubAppJwt } from './crypto.js';
import type {
  GitHubInstallationTargetType,
  GitHubPermissionLevel,
  GitHubRepositorySelection,
} from './store.js';

export const GITHUB_API_VERSION = '2026-03-10';
export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_GITHUB_RESPONSE_MAX_BYTES = 1024 * 1024;
export const MAX_GITHUB_INSTALLATION_PAGES = 10;
export const MAX_GITHUB_PUBLISH_FILES = WORKSPACE_LIMITS.maxFiles;
const GITHUB_TREE_BATCH_FILES = 1_000;
/**
 * Request-body ceiling for any single call. Named because the per-file publish
 * bound below is DERIVED from it and the two must not drift apart.
 */
export const MAX_GITHUB_REQUEST_BODY_BYTES = 30 * 1024 * 1024;
/**
 * PER FILE, and not a policy choice: every file travels as its own request with
 * a base64 body, and base64 inflates by 4/3. So 30 MiB of body allows 22.5 MiB
 * of content; 20 MiB is that with margin for the surrounding JSON.
 * `DEFAULT_ARTIFACT_LIMITS.maxFileBytes` is 10 MiB, so this never binds first —
 * it is the wall behind the wall.
 */
export const MAX_GITHUB_PUBLISH_FILE_BYTES = 20 * 1024 * 1024;
/** Total upload budget; unchanged repository content is never uploaded. */
export const MAX_GITHUB_PUBLISH_TOTAL_BYTES = WORKSPACE_LIMITS.maxTotalBytes;

export const GITHUB_PUBLISH_PERMISSIONS = Object.freeze({
  administration: 'write',
  contents: 'write',
} as const satisfies Readonly<Record<string, GitHubPermissionLevel>>);

export interface GitHubClientConfig {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKey: KeyObject;
  readonly apiBaseUrl: string;
}

export interface GitHubAppClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly responseMaxBytes?: number;
  readonly now?: () => number;
}

export interface GitHubInstallationView {
  readonly installationId: string;
  readonly appId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly targetType: GitHubInstallationTargetType;
  readonly repositorySelection: GitHubRepositorySelection;
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  readonly suspended: boolean;
}

export interface GitHubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, GitHubPermissionLevel>>;
  readonly repositorySelection: GitHubRepositorySelection;
}

export interface CreateGitHubRepositoryInput {
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
}

export interface GitHubRepository {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
  readonly parentId?: string;
}

export interface GitHubPublishFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  /** Git tree mode. Defaults to a regular file; '100755' publishes executable. */
  readonly mode?: '100644' | '100755';
}

/** Metadata stays cheap; bytes are revalidated only immediately before upload. */
export interface GitHubDeferredPublishFile {
  readonly path: string;
  readonly mode?: '100644' | '100755';
  readonly size: number;
  readonly readContent: () => Uint8Array;
}
type PublishFile = GitHubPublishFile | GitHubDeferredPublishFile;

function publishFileBytes(file: PublishFile): number {
  return 'readContent' in file ? file.size : typeof file.content === 'string'
    ? Buffer.byteLength(file.content, 'utf8') : file.content.byteLength;
}
function publishFileContent(file: PublishFile): string | Uint8Array {
  const content = 'readContent' in file ? file.readContent() : file.content;
  if (('readContent' in file && (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength) !== file.size) || publishFileBytes(file) > MAX_GITHUB_PUBLISH_FILE_BYTES) {
    throw new Error('GitHub publish file changed or exceeds its byte bound');
  }
  return content;
}

export interface PublishGitHubManifestInput {
  readonly token: string;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly branch?: string;
  readonly message: string;
  readonly files: readonly PublishFile[];
  /**
   * THE AUTHORITY TO WRITE ONTO A BRANCH THAT ALREADY HAS COMMITS: the commit
   * this project itself last published, or null for a first publication.
   *
   * A required key with a nullable value, so a caller must state which it is
   * rather than omitting it into the permissive case. It is NOT derived from
   * `repository_status = 'ready'`: that says the repository EXISTS, and reading
   * it as "the branch is ours" is the conflation that made publication
   * single-shot. Passing null against a populated branch is a refusal, which is
   * what keeps a repository adopted through a 422 name collision — or one a
   * second project of the same organisation is publishing into — out of reach.
   */
  readonly expectedHead: string | null;
  /** Resolve the write set against the exact parent used for this commit. */
  readonly selectFiles?: (head: string) => Promise<{ files: readonly PublishFile[]; message: string }>;
  /** Host-persisted receipt from this same publication, never an observed head. */
  readonly seedCommitSha?: string | null;
  /** Must persist before subsequent remote writes. */
  readonly onSeed?: (commitSha: string) => void | Promise<void>;
}

/** What a branch reference read found. 404 and 409 mean different things. */
export type GitHubBranchHead =
  | { readonly state: 'head'; readonly sha: string }
  | { readonly state: 'missing' }
  | { readonly state: 'empty' };

export interface GitHubPublishedCommit {
  readonly branch: string;
  readonly treeSha: string;
  readonly commitSha: string;
  readonly ref: string;
  /**
   * The observed publication parent (the captured run base for imported
   * projects); null when this publication started the history. An observation, never
   * a pointer anything decides from.
   */
  readonly baseSha: string | null;
  /**
   * `unchanged` means the branch already held every byte the manifest declares,
   * so no commit object was created and the reference was not moved.
   *
   * Named `publishKind` and not `outcome` because `src/projects/AGENTS.md`
   * already owns a closed `outcome` vocabulary one join away.
   */
  readonly publishKind: 'created' | 'extended' | 'unchanged';
}

type GitHubApiErrorCode = 'http' | 'network' | 'timeout' | 'response_too_large' | 'invalid_response';

/** Safe transport error: it never includes authorization headers or response bodies. */
export class GitHubApiError extends Error {
  readonly status: number | null;
  readonly method: string;
  readonly path: string;
  readonly code: GitHubApiErrorCode;

  constructor(input: {
    readonly status: number | null;
    readonly method: string;
    readonly path: string;
    readonly code: GitHubApiErrorCode;
  }) {
    super(
      input.status === null
        ? `GitHub API ${input.method} ${input.path} failed (${input.code})`
        : `GitHub API ${input.method} ${input.path} returned HTTP ${input.status}`
    );
    this.name = 'GitHubApiError';
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.code = input.code;
  }
}

/**
 * A FIRST publication found a branch that already has commits — so this
 * product has no authority over that history and refuses to add to it.
 *
 * The sentence is a PREFIX and stays byte-identical, because it is quoted in
 * `src/github/AGENTS.md` and it is the stored error on the live `a06b09ff`
 * publication row. What follows it is the evidence an operator needs to tell
 * the two reachable causes apart: a repository adopted through
 * `ensureRepository`'s 422 name collision, and a second project of the same
 * organisation publishing into one repository (nothing in the projects DDL
 * forbids that).
 */
export class GitHubDivergenceError extends Error {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  /** The head this product does not own, when it could be read. */
  readonly observedHead: string | null;

  constructor(owner: string, repository: string, branch: string, observedHead: string | null = null) {
    super(
      'GitHub repository branch already exists; initial publish refused' +
        (observedHead === null
          ? ''
          : ` (branch ${branch} is at ${observedHead.slice(0, 7)} and no publication of this project owns it)`)
    );
    this.name = 'GitHubDivergenceError';
    this.owner = owner;
    this.repository = repository;
    this.branch = branch;
    this.observedHead = observedHead;
  }
}

/**
 * This project HAS published to that branch, and the branch is no longer
 * there. Refused rather than re-seeded: a second root history in a repository
 * a tenant already cloned is worse than a stopped publication.
 */
export class GitHubBranchGoneError extends Error {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly reason: 'missing' | 'empty';
  readonly publishedSha: string;

  constructor(input: {
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly reason: 'missing' | 'empty';
    readonly publishedSha: string;
  }) {
    const slug = `${input.owner}/${input.repository}`;
    super(
      input.reason === 'missing'
        ? `GitHub branch ${slug}@${input.branch} no longer exists although this project published ${input.publishedSha.slice(0, 7)} to it; publication refused rather than starting a second history`
        : `GitHub repository ${slug} has no commits although this project published ${input.publishedSha.slice(0, 7)} to it; publication refused rather than starting a second history`
    );
    this.name = 'GitHubBranchGoneError';
    this.owner = input.owner;
    this.repository = input.repository;
    this.branch = input.branch;
    this.reason = input.reason;
    this.publishedSha = input.publishedSha;
  }
}

/**
 * The fast-forward was declined. NO WORD IS SHARED with the divergence
 * sentence above: reporting a protected branch as "somebody pushed" sends an
 * operator hunting a push that never happened, and 422 is how GitHub answers
 * both. One best-effort head re-read decides which it was.
 *
 * The identifying facts come FIRST because `publication.failed`'s push summary
 * is truncated to 120 characters — the repository, branch and shas must survive
 * that cut, and the reassurance is what may be lost.
 */
export class GitHubRefRefusedError extends Error {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly reason: 'moved' | 'blocked' | 'unknown';
  readonly expectedSha: string;
  readonly observedSha: string | null;
  readonly commitSha: string;

  constructor(input: {
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly expectedSha: string;
    readonly observedSha: string | null;
    readonly commitSha: string;
  }) {
    const slug = `${input.owner}/${input.repository}@${input.branch}`;
    const expected = input.expectedSha.slice(0, 7);
    const built = input.commitSha.slice(0, 7);
    const reason: 'moved' | 'blocked' | 'unknown' =
      input.observedSha === null ? 'unknown' : input.observedSha === input.expectedSha ? 'blocked' : 'moved';
    super(
      reason === 'moved'
        ? `GitHub branch ${slug} moved from ${expected} to ${input.observedSha!.slice(0, 7)} while this publication was being built; commit ${built} was created, the branch was NOT force-updated, and a retry builds on the new head`
        : reason === 'blocked'
          ? `GitHub declined to fast-forward ${slug}, which is still at ${expected}: a branch protection rule or ruleset forbids this update, so no retry converges until it changes`
          : `GitHub declined to fast-forward ${slug} (HTTP 422) and its current head could not be read; commit ${built} was created and the branch was not force-updated`
    );
    this.name = 'GitHubRefRefusedError';
    this.owner = input.owner;
    this.repository = input.repository;
    this.branch = input.branch;
    this.reason = reason;
    this.expectedSha = input.expectedSha;
    this.observedSha = input.observedSha;
    this.commitSha = input.commitSha;
  }
}

interface RequestInput {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  readonly accepted?: readonly number[];
  readonly responseMaxBytes?: number;
  readonly signal?: AbortSignal;
}

interface RequestOutput {
  readonly status: number;
  readonly json: unknown;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value as Record<string, unknown>;
}

function responseString(value: unknown, label: string, max = 4096): string {
  const hasControl = typeof value === 'string' && [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (typeof value !== 'string' || !value || value.length > max || hasControl) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function responseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} has an invalid value`);
  return value;
}

function repositoryName(value: string): string {
  if (
    value === '.' ||
    value === '..' ||
    value.length > 100 ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error('GitHub repository name has an invalid value');
  }
  return value;
}

function ownerLogin(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(value)) {
    throw new Error('GitHub owner login has an invalid value');
  }
  return value;
}

function branchName(value: string): string {
  if (
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    throw new Error('GitHub branch name has an invalid value');
  }
  return value;
}

function safeToken(value: string): string {
  const printableAscii = [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 33 && code <= 126;
  });
  if (value.length < 1 || value.length > 16_384 || !printableAscii) {
    throw new Error('GitHub bearer token has an invalid format');
  }
  return value;
}

function permissions(value: unknown): Readonly<Record<string, GitHubPermissionLevel>> {
  const object = asObject(value, 'GitHub permissions');
  if (Object.keys(object).length > 100) throw new Error('GitHub permissions have an invalid shape');
  const normalized: Record<string, GitHubPermissionLevel> = {};
  for (const [name, level] of Object.entries(object).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(name) || (level !== 'read' && level !== 'write')) {
      throw new Error('GitHub permissions have an invalid value');
    }
    normalized[name] = level;
  }
  return Object.freeze(normalized);
}

function repositorySelection(value: unknown): GitHubRepositorySelection {
  if (value !== 'all' && value !== 'selected') {
    throw new Error('GitHub repository selection has an invalid value');
  }
  return value;
}

function parseInstallation(value: unknown): GitHubInstallationView {
  const object = asObject(value, 'GitHub installation');
  const account = asObject(object['account'], 'GitHub installation account');
  const targetType = object['target_type'] ?? account['type'];
  if (targetType !== 'User' && targetType !== 'Organization') {
    throw new Error('GitHub installation target type has an invalid value');
  }
  const suspendedAt = object['suspended_at'];
  if (suspendedAt !== null && suspendedAt !== undefined && typeof suspendedAt !== 'string') {
    throw new Error('GitHub installation suspension has an invalid value');
  }
  return Object.freeze({
    installationId: canonicalGitHubId(object['id'], 'GitHub installation id'),
    appId: canonicalGitHubId(object['app_id'], 'GitHub App id'),
    accountId: canonicalGitHubId(account['id'], 'GitHub account id'),
    accountLogin: responseString(account['login'], 'GitHub account login', 100),
    targetType,
    repositorySelection: repositorySelection(object['repository_selection']),
    permissions: permissions(object['permissions']),
    suspended: suspendedAt !== null && suspendedAt !== undefined,
  });
}

function parseRepository(value: unknown): GitHubRepository {
  const object = asObject(value, 'GitHub repository');
  const owner = asObject(object['owner'], 'GitHub repository owner');
  const name = repositoryName(responseString(object['name'], 'GitHub repository name', 100));
  const ownerName = ownerLogin(responseString(owner['login'], 'GitHub repository owner', 100));
  const fullName = responseString(object['full_name'], 'GitHub repository full name', 201);
  if (fullName.toLowerCase() !== `${ownerName}/${name}`.toLowerCase()) {
    throw new Error('GitHub repository identity is inconsistent');
  }
  const htmlUrl = responseString(object['html_url'], 'GitHub repository URL', 2048);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(htmlUrl);
  } catch {
    throw new Error('GitHub repository URL has an invalid value');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('GitHub repository URL has an invalid value');
  return Object.freeze({
    id: canonicalGitHubId(object['id'], 'GitHub repository id'),
    owner: ownerName,
    name,
    fullName,
    defaultBranch: branchName(responseString(object['default_branch'], 'GitHub default branch', 255)),
    private: responseBoolean(object['private'], 'GitHub repository visibility'),
    htmlUrl: parsedUrl.toString(),
    ...(object['parent'] ? { parentId: canonicalGitHubId(asObject(object['parent'], 'fork parent')['id']) } : {}),
  });
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function repositoryPath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('GitHub artifact path has an invalid value');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment === '.git')) {
    throw new Error('GitHub artifact path has an invalid value');
  }
  return value;
}

function filePath(value: string): string {
  repositoryPath(value);
  const segments = value.split('/');
  if (segments[0]?.toLowerCase() === '.github' && segments[1]?.toLowerCase() === 'workflows') {
    throw new Error('GitHub workflow files are outside the initial publish scope');
  }
  return value;
}

function importExcludePrefixes(value: unknown): readonly string[] {
  const config = asObject(value, 'repository import selection');
  if (Object.keys(config).some(key => key !== 'version' && key !== 'excludePrefixes') ||
    config['version'] !== 1 || !Array.isArray(config['excludePrefixes']) || config['excludePrefixes'].length > 32) {
    throw new Error('Repository import selection has an invalid shape');
  }
  const seen = new Set<string>();
  return config['excludePrefixes'].map((candidate: unknown) => {
    if (typeof candidate !== 'string' || !candidate.endsWith('/') || candidate.length > 256) {
      throw new Error('Repository import selection has an invalid prefix');
    }
    const prefix = repositoryPath(candidate.slice(0, -1)).toLowerCase() + '/';
    if (seen.has(prefix)) throw new Error('Repository import selection has duplicate prefixes');
    seen.add(prefix);
    return prefix;
  });
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export class GitHubAppClient {
  private readonly config: GitHubClientConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly responseMaxBytes: number;
  private readonly now: () => number;

  constructor(config: GitHubClientConfig, options: GitHubAppClientOptions = {}) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(config.appSlug)) {
      throw new Error('GitHub App slug has an invalid value');
    }
    this.config = Object.freeze({
      appId: canonicalGitHubId(config.appId, 'GitHub App id'),
      appSlug: responseString(config.appSlug, 'GitHub App slug', 100),
      privateKey: config.privateKey,
      apiBaseUrl: config.apiBaseUrl.replace(/\/$/, ''),
    });
    const parsedBase = new URL(this.config.apiBaseUrl);
    const loopback = parsedBase.hostname === 'localhost' || parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === '::1';
    if (parsedBase.protocol !== 'https:' && !(parsedBase.protocol === 'http:' && loopback)) {
      throw new Error('GitHub API base URL must use HTTPS (HTTP is allowed only on loopback)');
    }
    if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
      throw new Error('GitHub API base URL has an invalid value');
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
    this.responseMaxBytes = options.responseMaxBytes ?? DEFAULT_GITHUB_RESPONSE_MAX_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error('GitHub request timeout must be between 1 and 60000 milliseconds');
    }
    if (!Number.isSafeInteger(this.responseMaxBytes) || this.responseMaxBytes < 1 || this.responseMaxBytes > 10 * 1024 * 1024) {
      throw new Error('GitHub response limit must be between 1 byte and 10 MiB');
    }
    this.now = options.now ?? Date.now;
  }

  private appJwt(): string {
    return createGitHubAppJwt({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      now: this.now(),
    });
  }

  private async readJson(response: Response, method: string, path: string, maxBytes = this.responseMaxBytes): Promise<unknown> {
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The response is already rejected by its byte count.
          }
          throw new GitHubApiError({
            status: response.status,
            method,
            path,
            code: 'response_too_large',
          });
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (length === 0) return null;
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new GitHubApiError({
        status: response.status,
        method,
        path,
        code: 'invalid_response',
      });
    }
  }

  private async request(input: RequestInput): Promise<RequestOutput> {
    const method = input.method ?? 'GET';
    if (!input.path.startsWith('/') || input.path.startsWith('//')) {
      throw new Error('GitHub API request path must be relative to the configured API');
    }
    const token = safeToken(input.token);
    // PUT to the contents API answers 201 on create and 200 on update; PATCH
    // answers 200. Defaults per method, so no call site restates them.
    const accepted =
      input.accepted ?? (method === 'POST' ? [201] : method === 'PUT' ? [200, 201] : [200]);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_GITHUB_REQUEST_BODY_BYTES) {
      throw new Error('GitHub API request body exceeds the configured publish bound');
    }
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(input.signal ? [input.signal] : [])]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${input.path}`, {
        method,
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': `atoma-${this.config.appSlug}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new GitHubApiError({
        status: null,
        method,
        path: input.path,
        code: signal.aborted ? 'timeout' : 'network',
      });
    }
    if (!accepted.includes(response.status)) {
      try {
        await response.body?.cancel();
      } catch {
        // The status is authoritative; failure to cancel a diagnostic body is irrelevant.
      }
      throw new GitHubApiError({
        status: response.status,
        method,
        path: input.path,
        code: 'http',
      });
    }
    return Object.freeze({
      status: response.status,
      json: await this.readJson(response, method, input.path, input.responseMaxBytes),
    });
  }

  async listUserInstallations(userAccessToken: string): Promise<readonly GitHubInstallationView[]> {
    const installations: GitHubInstallationView[] = [];
    for (let page = 1; page <= MAX_GITHUB_INSTALLATION_PAGES; page += 1) {
      const result = await this.request({
        token: userAccessToken,
        path: `/user/installations?per_page=100&page=${page}`,
      });
      const object = asObject(result.json, 'GitHub user installations response');
      if (!Array.isArray(object['installations'])) {
        throw new Error('GitHub user installations response has an invalid shape');
      }
      const pageInstallations = object['installations'].map(parseInstallation);
      installations.push(...pageInstallations);
      const totalCount = object['total_count'];
      if (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0) {
        throw new Error('GitHub user installations count has an invalid value');
      }
      if (installations.length >= (totalCount as number)) return Object.freeze(installations);
      if (pageInstallations.length === 0) {
        throw new Error('GitHub user installations pagination ended before total_count');
      }
    }
    throw new Error(`GitHub user installations exceed the ${MAX_GITHUB_INSTALLATION_PAGES}-page safety bound`);
  }

  /**
   * Does the installation behind `installationToken` include this repository?
   *
   * The publication pre-flight. An installation whose selection was narrowed
   * after a project was created still mints tokens and still reads PUBLIC
   * repositories, then answers the first write with a bare
   * `403 Resource not accessible by integration` — measured on 2026-09-24,
   * two forks refused this way while the local row still said `all`. The
   * installation's own repository list is the authoritative answer.
   */
  async installationIncludesRepository(installationToken: string, repositoryId: string, signal?: AbortSignal): Promise<boolean> {
    const id = canonicalGitHubId(repositoryId, 'GitHub repository id');
    let seen = 0;
    for (let page = 1; page <= MAX_GITHUB_INSTALLATION_PAGES; page += 1) {
      const result = await this.request({
        token: installationToken, signal,
        path: `/installation/repositories?per_page=100&page=${page}`,
      });
      const object = asObject(result.json, 'GitHub installation repositories response');
      if (!Array.isArray(object['repositories'])) {
        throw new Error('GitHub installation repositories response has an invalid shape');
      }
      const repositories = object['repositories'] as unknown[];
      for (const repository of repositories) {
        const entry = asObject(repository, 'GitHub installation repository');
        if (canonicalGitHubId(entry['id'], 'GitHub repository id') === id) return true;
      }
      seen += repositories.length;
      const totalCount = object['total_count'];
      if (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0) {
        throw new Error('GitHub installation repositories count has an invalid value');
      }
      if (seen >= (totalCount as number) || repositories.length === 0) return false;
    }
    throw new Error(`GitHub installation repositories exceed the ${MAX_GITHUB_INSTALLATION_PAGES}-page safety bound`);
  }

  async getAppInstallation(installationId: string): Promise<GitHubInstallationView> {
    const id = canonicalGitHubId(installationId, 'GitHub installation id');
    const result = await this.request({
      token: this.appJwt(),
      path: `/app/installations/${id}`,
    });
    const installation = parseInstallation(result.json);
    if (installation.installationId !== id || installation.appId !== this.config.appId) {
      throw new Error('GitHub installation does not belong to the configured App');
    }
    return installation;
  }

  /** Verify setup_url's untrusted installation_id through both App and user views. */
  async verifyInstallation(input: {
    readonly userAccessToken: string;
    readonly installationId: string;
  }): Promise<GitHubInstallationView> {
    const installationId = canonicalGitHubId(input.installationId, 'GitHub installation id');
    const [appInstallation, userInstallations] = await Promise.all([
      this.getAppInstallation(installationId),
      this.listUserInstallations(input.userAccessToken),
    ]);
    const userInstallation = userInstallations.find((candidate) => candidate.installationId === installationId);
    if (
      !userInstallation ||
      userInstallation.appId !== this.config.appId ||
      userInstallation.accountId !== appInstallation.accountId ||
      userInstallation.accountLogin !== appInstallation.accountLogin ||
      userInstallation.targetType !== appInstallation.targetType ||
      userInstallation.repositorySelection !== appInstallation.repositorySelection
    ) {
      throw new Error('GitHub installation is not accessible to the authenticated user');
    }
    return appInstallation;
  }

  async createInstallationToken(installationId: string, pullRequests = false, readOnly = false, signal?: AbortSignal): Promise<GitHubInstallationToken> {
    const id = canonicalGitHubId(installationId, 'GitHub installation id');
    const result = await this.request({
      method: 'POST',
      token: this.appJwt(), signal,
      path: `/app/installations/${id}/access_tokens`,
      body: { permissions: readOnly ? { contents: 'read' } : { ...GITHUB_PUBLISH_PERMISSIONS, ...(pullRequests ? { pull_requests: 'write' } : {}) } },
    });
    const object = asObject(result.json, 'GitHub installation token response');
    const token = safeToken(responseString(object['token'], 'GitHub installation token', 16_384));
    const expiresAt = responseString(object['expires_at'], 'GitHub installation token expiry', 64);
    const expiry = new Date(expiresAt);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiresAt) ||
      !Number.isFinite(expiry.getTime()) ||
      expiry.getTime() <= this.now()
    ) {
      throw new Error('GitHub installation token expiry has an invalid value');
    }
    const grantedPermissions = permissions(object['permissions']);
    if (
      (!readOnly && grantedPermissions['administration'] !== 'write') ||
      (readOnly ? !['read', 'write'].includes(grantedPermissions['contents'] ?? '') : grantedPermissions['contents'] !== 'write') ||
      (pullRequests && grantedPermissions['pull_requests'] !== 'write')
    ) {
      throw new Error('GitHub installation token lacks required publish permissions');
    }
    return Object.freeze({
      token,
      expiresAt: expiry.toISOString(),
      permissions: grantedPermissions,
      repositorySelection: repositorySelection(object['repository_selection']),
    });
  }

  private async createRepository(
    path: string,
    token: string,
    input: CreateGitHubRepositoryInput
  ): Promise<GitHubRepository> {
    const name = repositoryName(input.name);
    const description = input.description ?? '';
    const descriptionHasControl = [...description].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
    if (description.length > 350 || descriptionHasControl) {
      throw new Error('GitHub repository description has an invalid value');
    }
    const result = await this.request({
      method: 'POST',
      path,
      token,
      body: {
        name,
        description,
        private: input.private ?? true,
        auto_init: false,
      },
    });
    return parseRepository(result.json);
  }

  async createUserRepository(
    userAccessToken: string,
    input: CreateGitHubRepositoryInput
  ): Promise<GitHubRepository> {
    return this.createRepository('/user/repos', userAccessToken, input);
  }

  async createOrganisationRepository(
    installationToken: string,
    organisation: string,
    input: CreateGitHubRepositoryInput
  ): Promise<GitHubRepository> {
    const owner = ownerLogin(organisation);
    return this.createRepository(`/orgs/${encodeSegment(owner)}/repos`, installationToken, input);
  }

  /**
   * Resolve an existing repository's identity. 404 is null (the caller's
   * idempotent-create path), any other status is a transport error.
   */
  async getRepository(
    token: string,
    owner: string,
    repository: string
  ): Promise<GitHubRepository | null> {
    const safeOwner = ownerLogin(owner);
    const safeRepository = repositoryName(repository);
    const result = await this.request({
      token,
      path: `/repos/${encodeSegment(safeOwner)}/${encodeSegment(safeRepository)}`,
      accepted: [200, 404],
    });
    if (result.status === 404) return null;
    return parseRepository(result.json);
  }

  async createFork(input: {
    token: string; owner: string; name: string; targetName: string; organisation?: string;
  }): Promise<GitHubRepository> {
    const result = await this.request({
      token: input.token, method: 'POST', accepted: [202],
      path: `/repos/${encodeSegment(ownerLogin(input.owner))}/${encodeSegment(repositoryName(input.name))}/forks`,
      body: { name: repositoryName(input.targetName), default_branch_only: true,
        ...(input.organisation ? { organization: ownerLogin(input.organisation) } : {}) },
    });
    return parseRepository(result.json);
  }

  async mergeUpstream(input: { token: string; owner: string; name: string; branch: string; signal: AbortSignal }): Promise<string> {
    const result = await this.request({ token: input.token, method: 'POST', signal: input.signal,
      path: `/repos/${encodeSegment(ownerLogin(input.owner))}/${encodeSegment(repositoryName(input.name))}/merge-upstream`,
      body: { branch: branchName(input.branch) } });
    const object = asObject(result.json, 'GitHub upstream merge');
    const kind = responseString(object['merge_type'], 'upstream merge type', 32);
    if (!['fast-forward', 'merge', 'none'].includes(kind)) throw new Error('Unknown upstream merge result');
    return kind;
  }

  async readRepositoryTree(input: {
    token: string; owner: string; name: string; commitSha: string; signal?: AbortSignal;
    paths?: readonly string[];
  }): Promise<RepositoryTreeEntry[]> {
    input.signal?.throwIfAborted();
    const commit = await this.getCommit(input.token, input.owner, input.name, input.commitSha, input.signal);
    const read = async (treeSha: string, recursive: boolean) => {
      const result = await this.request({ token: input.token,
        path: this.gitPath(input.owner, input.name, `trees/${treeSha}${recursive ? '?recursive=1' : ''}`),
        responseMaxBytes: 32 * 1024 * 1024, signal: input.signal });
      const tree = asObject(result.json, 'GitHub tree');
      if (typeof tree['truncated'] !== 'boolean' || !Array.isArray(tree['tree'])) throw new Error('Repository tree is incomplete');
      const entries = tree['tree'].map(value => {
        const entry = asObject(value, 'GitHub tree entry');
        return repositoryTreeEntrySchema.parse({ path: entry['path'], mode: entry['mode'],
          sha: entry['sha'], type: entry['type'], ...(entry['size'] === undefined ? {} : { size: entry['size'] }) });
      });
      return { entries, truncated: tree['truncated'] };
    };
    if (!input.paths) {
      try {
        const recursive = await read(commit.treeSha, true);
        if (!recursive.truncated) {
          if (recursive.entries.length > WORKSPACE_LIMITS.maxEntries) throw new Error('Repository exceeds the tree entry limit');
          return recursive.entries;
        }
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.code !== 'response_too_large') throw error;
      }
    }
    // A truncated recursive response is not an inventory. Walk immutable
    // subtrees instead, or only the directories needed by a publication diff.
    const cache = new Map<string, Map<string, RepositoryTreeEntry>>();
    const found = new Map<string, RepositoryTreeEntry>();
    let visited = 0;
    const directory = async (treeSha: string, prefix: string) => {
      if (++visited > WORKSPACE_LIMITS.maxEntries) throw new Error('Repository exceeds the tree traversal limit');
      input.signal?.throwIfAborted();
      let entries = cache.get(treeSha);
      if (!entries) {
        const result = await read(treeSha, false);
        if (result.truncated) throw new Error('Repository tree is incomplete');
        entries = new Map();
        for (const e of result.entries) {
          if (e.path.includes('/') || e.path === '.' || e.path === '..' || entries.has(e.path)) throw new Error('Repository contains invalid tree entries');
          entries.set(e.path, e);
        }
        cache.set(treeSha, entries);
      }
      for (const e of entries.values()) {
        const path = prefix ? `${prefix}/${e.path}` : e.path;
        if (path.length > 4096) throw new Error('Repository path exceeds its bound');
        found.set(path, { ...e, path });
      }
      if (found.size > WORKSPACE_LIMITS.maxEntries) throw new Error('Repository exceeds the tree entry limit');
      return entries;
    };
    if (input.paths) {
      const expanded = new Set<string>();
      for (const p of input.paths) {
        let treeSha = commit.treeSha;
        const parts = p.split('/');
        for (let i = 0; i < parts.length; i++) {
          const prefix = parts.slice(0, i).join('/');
          let entries = cache.get(treeSha);
          if (!expanded.has(prefix)) { entries = await directory(treeSha, prefix); expanded.add(prefix); }
          const next = entries!.get(parts[i]!);
          if (!next || next.type !== 'tree') break;
          treeSha = next.sha;
        }
      }
    } else {
      const pending = [{ sha: commit.treeSha, prefix: '' }];
      while (pending.length) {
        const next = pending.pop()!;
        const entries = await directory(next.sha, next.prefix);
        for (const e of entries.values()) if (e.type === 'tree') pending.push({ sha: e.sha,
          prefix: next.prefix ? `${next.prefix}/${e.path}` : e.path });
      }
    }
    return [...found.values()];
  }

  async readRepositoryBlob(input: {
    token: string; owner: string; name: string; sha: string; signal: AbortSignal;
  }): Promise<Buffer> {
    const result = await this.request({ token: input.token,
      path: this.gitPath(input.owner, input.name, `blobs/${sha(input.sha, 'blob sha')}`),
      responseMaxBytes: MAX_GITHUB_REQUEST_BODY_BYTES, signal: input.signal });
    const object = asObject(result.json, 'GitHub blob');
    if (object['encoding'] !== 'base64' || typeof object['content'] !== 'string') throw new Error('Unsupported repository blob encoding');
    const content = Buffer.from(object['content'], 'base64');
    if (content.length > WORKSPACE_LIMITS.maxFileBytes || content.length !== object['size']) throw new Error('Repository blob exceeds its bound or is incomplete');
    return content;
  }

  /** Read immutable git objects; never follow archive redirects carrying credentials. */
  async readRepositoryFiles(input: {
    token: string; owner: string; name: string; commitSha: string; signal: AbortSignal;
    onFile?: (file: GitHubPublishFile) => Promise<void>;
  }): Promise<readonly GitHubPublishFile[]> {
    input.signal.throwIfAborted();
    const entries = await this.readRepositoryTree(input);
    // The source repository may explicitly leave bulky or non-publishable
    // directories out of Atoma's workspace. Read this one small config blob
    // before the files so exclusions apply before per-file and total limits.
    const selection = entries.find(entry => entry['path'] === '.atoma-import.json');
    let excludePrefixes: readonly string[] = [];
    if (selection) {
      if (selection['type'] !== 'blob' || selection['mode'] !== '100644') {
        throw new Error('Repository import selection must be a regular file');
      }
      const selected = await this.request({ token: input.token,
        path: this.gitPath(input.owner, input.name, `blobs/${sha(selection['sha'], 'import selection sha')}`),
        responseMaxBytes: 64 * 1024, signal: input.signal });
      const object = asObject(selected.json, 'repository import selection blob');
      if (object['encoding'] !== 'base64' || typeof object['content'] !== 'string') {
        throw new Error('Repository import selection has an unsupported encoding');
      }
      const content = Buffer.from(object['content'], 'base64');
      if (content.length > 16 * 1024 || content.length !== object['size']) {
        throw new Error('Repository import selection exceeds its size limit');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(content.toString('utf8')) as unknown; }
      catch { throw new Error('Repository import selection is not valid JSON'); }
      excludePrefixes = importExcludePrefixes(parsed);
    }
    const selected: Array<{ path: string; sha: string; mode: '100644' | '100755'; size?: number }> = [];
    const seen = new Map<string, string>();
    const paths = new Set<string>();
    let declaredBytes = 0;
    for (const entry of entries) {
      input.signal.throwIfAborted();
      const name = repositoryPath(entry.path);
      if (paths.has(name)) throw new Error('Repository contains duplicate file paths');
      paths.add(name);
      if (name.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('Repository contains a reserved git path');
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        const prior = seen.get(prefix.toLowerCase());
        if (prior && prior !== prefix) throw new Error('Repository contains conflicting file paths');
        seen.set(prefix.toLowerCase(), prefix);
      }
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        throw new Error('Repository import does not support symbolic links or submodules');
      }
      if (name === '.atoma-import.json') continue;
      if (excludePrefixes.some(prefix => name.toLowerCase().startsWith(prefix))) continue;
      filePath(name);
      if (name.length > WORKSPACE_LIMITS.maxPathChars || name !== name.trim()) throw new Error('Repository path exceeds the workspace path policy');
      if (entry.size !== undefined) {
        if (entry.size > WORKSPACE_LIMITS.maxFileBytes) throw new Error('Repository file exceeds the 10 MiB import limit');
        declaredBytes += entry.size;
      }
      selected.push({ path: name, sha: entry.sha, mode: entry.mode, size: entry.size });
    }
    if (selected.length > WORKSPACE_LIMITS.maxFiles) throw new Error('Repository exceeds the workspace file limit');
    if (declaredBytes > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Repository exceeds the 512 MiB import limit');
    const files: GitHubPublishFile[] = [];
    let total = 0, cursor = 0;
    const emit = async (file: GitHubPublishFile) => {
      total += typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength;
      if (total > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Repository exceeds the 512 MiB import limit');
      if (input.onFile) await input.onFile(file);
      else files.push(file);
    };
    // Avoid thousands of REST blob calls on GitHub.com. The signed archive
    // URL receives NO installation token. Enterprise hosts retain blob reads.
    const completed = selected.length > 128 && this.config.apiBaseUrl === 'https://api.github.com'
      ? await readRepositoryArchive({ body: await this.repositoryArchiveBody(input), files: selected,
          signal: input.signal, onFile: emit }) : new Set<string>();
    const remaining = selected.filter(file => !completed.has(file.path));
    // Bounded parallel reads: the run's preparation signal owns cancellation,
    // including waiting for active readers to settle before seed cleanup.
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const readers = Array.from({ length: Math.min(8, remaining.length) }, async () => {
      try {
        while (cursor < remaining.length) {
          signal.throwIfAborted();
          const entry = remaining[cursor++]!;
          const content = await this.readRepositoryBlob({ ...input, sha: entry.sha, signal });
          const hash = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
          if (hash !== entry.sha || (entry.size !== undefined && entry.size !== content.length)) throw new Error('Repository blob integrity failure');
          await emit({ path: entry.path, mode: entry.mode, content });
        }
      } catch (error) { controller.abort(error); throw error; }
    });
    await Promise.allSettled(readers);
    if (signal.aborted) throw signal.reason;

    if (!selected.length) throw new Error('Repository has no files to import');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async repositoryArchiveBody(input: {
    token: string; owner: string; name: string; commitSha: string; signal: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const path = `/repos/${encodeSegment(ownerLogin(input.owner))}/${encodeSegment(repositoryName(input.name))}/zipball/${sha(input.commitSha, 'archive commit sha')}`;
    try {
      const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        redirect: 'manual', signal: AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: { Authorization: `Bearer ${safeToken(input.token)}`, Accept: 'application/vnd.github+json',
          'User-Agent': `atoma-${this.config.appSlug}`, 'X-GitHub-Api-Version': GITHUB_API_VERSION },
      });
      await response.body?.cancel();
      if (response.status !== 302) throw new Error('Archive link unavailable');
      const url = new URL(response.headers.get('location') ?? '');
      if (url.origin !== 'https://codeload.github.com' || url.username || url.password || url.hash) throw new Error('Unsafe archive host');
      const archive = await this.fetchImpl(url, { redirect: 'error', signal: input.signal,
        headers: { 'User-Agent': `atoma-${this.config.appSlug}` } });
      if (!archive.ok || !archive.body) { await archive.body?.cancel(); throw new Error('Archive unavailable'); }
      return archive.body;
    } catch {
      input.signal.throwIfAborted();
      // Never expose signed URLs or transport errors containing credentials.
      throw new Error('GitHub repository archive could not be downloaded');
    }
  }

  /** Publish from the captured run base, to its own PR branch or directly into a fork. */
  async publishRepositoryRun(input: PublishGitHubManifestInput & {
    baseBranch: string; baseSha: string; pullRequest: boolean;
  }): Promise<GitHubPublishedCommit & { pullRequestUrl: string | null }> {
    const baseSha = sha(input.baseSha, 'run base sha');
    const normalized = this.normalizeManifestFiles(input);
    const remote = await this.readRepositoryTree({ token: input.token, owner: input.repository.owner,
      name: input.repository.name, commitSha: baseSha, paths: normalized.files.map(f => f.path) });
    const byPath = new Map(remote.map(e => [e.path, e]));
    const changed = normalized.files.filter(file => {
      const entry = byPath.get(file.path);
      if (!entry || entry.type !== 'blob' || entry.mode !== (file.mode ?? '100644')) return true;
      const content = publishFileContent(file);
      const bytes = typeof content === 'string' ? Buffer.from(content) : content;
      return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha;
    });
    const { owner, repository, branch, files } = this.normalizeManifestFiles({ ...input, files: changed, expectedHead: baseSha });
    if (input.pullRequest && branch === input.baseBranch) throw new Error('A run branch must differ from its base');
    if (!input.pullRequest && branch !== input.baseBranch) throw new Error('Direct publication must target its base branch');
    const base = await this.getCommit(input.token, owner, repository, baseSha);
    if (!files.length) return { branch, treeSha: base.treeSha, commitSha: baseSha,
      ref: `refs/heads/${branch}`, baseSha, publishKind: 'unchanged', pullRequestUrl: null };
    const entries = await this.blobEntries(input.token, owner, repository, files);
    const treeSha = await this.createTree({ token: input.token, owner, repository, entries, baseTreeSha: base.treeSha });
    if (treeSha === base.treeSha) return { branch, treeSha, commitSha: baseSha,
      ref: `refs/heads/${branch}`, baseSha, publishKind: 'unchanged', pullRequestUrl: null };
    const head = await this.readBranchHead(input.token, owner, repository, branch);
    let commitSha: string;
    if (head.state === 'head' && (input.pullRequest || head.sha !== baseSha)) {
      const existing = await this.getCommit(input.token, owner, repository, head.sha);
      if (existing.treeSha !== treeSha || existing.parents.length !== 1 || existing.parents[0] !== baseSha) {
        throw new GitHubDivergenceError(owner, repository, branch, head.sha);
      }
      commitSha = head.sha;
    } else {
      commitSha = await this.createCommit({ token: input.token, owner, repository,
        message: input.message, treeSha, parents: [baseSha] });
      if (input.pullRequest) {
        await this.createReference({ token: input.token, owner, repository, branch, commitSha });
      } else {
        if (head.state !== 'head') throw new Error('Fork branch disappeared since the run started');
        await this.moveBranch({ token: input.token, owner, repository, branch, expectedSha: baseSha, commitSha });
      }
    }
    if (!input.pullRequest) return { branch, treeSha, commitSha, ref: `refs/heads/${branch}`, baseSha,
      publishKind: 'extended', pullRequestUrl: null };
    const pullsPath = `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}/pulls`;
    const found = await this.request({ token: input.token,
      path: `${pullsPath}?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=100` });
    if (!Array.isArray(found.json)) throw new Error('Invalid pull request list');
    const existing = found.json[0] as unknown;
    const pr = existing ? asObject(existing, 'pull request') : asObject((await this.request({
      token: input.token, method: 'POST', path: pullsPath,
      body: { title: input.message.split('\n')[0]!.slice(0, 240), body: input.message,
        head: branch, base: branchName(input.baseBranch) },
    })).json, 'pull request');
    const url = responseString(pr['html_url'], 'pull request URL', 2048);
    if (new URL(url).protocol !== 'https:') throw new Error('Invalid pull request URL');
    return { branch, treeSha, commitSha, ref: `refs/heads/${branch}`, baseSha,
      publishKind: 'created', pullRequestUrl: url };
  }

  /**
   * Read a branch's head, DISCRIMINATING the two ways it can be absent.
   *
   * This used to collapse 404 and 409 into one `null`, one line from the
   * decision that used it — and the two are not the same fact. 409 is
   * `{"message":"Git Repository is empty."}`: the repository has no commits at
   * all, which is the state the contents API exists to seed. 404 is a
   * repository that HAS commits but not this branch, which for a project that
   * already published means somebody deleted or renamed it. Publishing the
   * same way in both cases is how a second root history gets started in a
   * repository a tenant already cloned.
   */
  async readBranchHead(
    token: string,
    owner: string,
    repository: string,
    branch: string,
    signal?: AbortSignal
  ): Promise<GitHubBranchHead> {
    const safeOwner = ownerLogin(owner);
    const safeRepository = repositoryName(repository);
    const safeBranch = branchName(branch);
    const path = `/repos/${encodeSegment(safeOwner)}/${encodeSegment(safeRepository)}/git/ref/heads/${safeBranch.split('/').map(encodeSegment).join('/')}`;
    const result = await this.request({ token, path, accepted: [200, 404, 409], signal });
    if (result.status === 409) return { state: 'empty' };
    if (result.status === 404) return { state: 'missing' };
    const object = asObject(result.json, 'GitHub reference response');
    const target = asObject(object['object'], 'GitHub reference target');
    return { state: 'head', sha: sha(target['sha'], 'GitHub reference sha') };
  }

  /**
   * One commit's tree. `readBranchHead` yields a COMMIT sha and `base_tree`
   * needs a TREE sha, so an incremental publication cannot be composed without
   * this read.
   */
  async getCommit(
    token: string,
    owner: string,
    repository: string,
    commitSha: string,
    signal?: AbortSignal
  ): Promise<{ treeSha: string; parents: readonly string[] }> {
    const result = await this.request({
      token, signal,
      path: this.gitPath(owner, repository, `commits/${sha(commitSha, 'GitHub commit sha')}`),
    });
    const object = asObject(result.json, 'GitHub commit response');
    const tree = asObject(object['tree'], 'GitHub commit tree');
    const parents = Array.isArray(object['parents']) ? object['parents'] : [];
    return {
      treeSha: sha(tree['sha'], 'GitHub tree sha'),
      parents: parents.map((parent) => sha(asObject(parent, 'GitHub commit parent')['sha'], 'GitHub commit sha')),
    };
  }

  async createBlob(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly content: string | Uint8Array;
  }): Promise<string> {
    const bytes = typeof input.content === 'string'
      ? Buffer.from(input.content, 'utf8')
      : Buffer.from(input.content);
    if (bytes.length > MAX_GITHUB_PUBLISH_FILE_BYTES) {
      throw new Error('GitHub blob exceeds the per-file publish byte bound');
    }
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'blobs'),
      body: {
        content: bytes.toString('base64'),
        encoding: 'base64',
      },
    });
    return sha(asObject(result.json, 'GitHub blob response')['sha'], 'GitHub blob sha');
  }

  async createTree(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly entries: readonly {
      readonly path: string;
      readonly sha: string;
      readonly mode?: '100644' | '100755';
    }[];
    /**
     * Merge onto this tree instead of replacing it. Present for an incremental
     * publication, absent for a first one — where the manifest IS the tree.
     */
    readonly baseTreeSha?: string;
  }): Promise<string> {
    if (input.entries.length < 1 || input.entries.length > MAX_GITHUB_PUBLISH_FILES) {
      throw new Error('GitHub tree has an invalid number of entries');
    }
    const seen = new Set<string>();
    const tree = input.entries.map((entry) => {
      const path = filePath(entry.path);
      if (seen.has(path)) throw new Error('GitHub tree contains duplicate paths');
      seen.add(path);
      if (entry.mode !== undefined && entry.mode !== '100644' && entry.mode !== '100755') {
        throw new Error('GitHub tree entry has an invalid mode');
      }
      return {
        path,
        mode: entry.mode ?? '100644',
        type: 'blob',
        sha: sha(entry.sha, 'GitHub blob sha'),
      };
    });
    let baseTreeSha = input.baseTreeSha;
    for (let offset = 0; offset < tree.length; offset += GITHUB_TREE_BATCH_FILES) {
      const result = await this.request({ method: 'POST', token: input.token,
        path: this.gitPath(input.owner, input.repository, 'trees'),
        body: { tree: tree.slice(offset, offset + GITHUB_TREE_BATCH_FILES),
          ...(baseTreeSha === undefined ? {} : { base_tree: sha(baseTreeSha, 'GitHub tree sha') }) } });
      baseTreeSha = sha(asObject(result.json, 'GitHub tree response')['sha'], 'GitHub tree sha');
    }
    return baseTreeSha!;
  }

  async createCommit(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly message: string;
    readonly treeSha: string;
    /** Empty for a root commit; one parent when building on a seeded branch. */
    readonly parents?: readonly string[];
  }): Promise<string> {
    if (!input.message.trim() || input.message.length > 65_536 || input.message.includes('\u0000')) {
      throw new Error('GitHub commit message has an invalid value');
    }
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'commits'),
      body: {
        message: input.message,
        tree: sha(input.treeSha, 'GitHub tree sha'),
        parents: (input.parents ?? []).map((parent) => sha(parent, 'GitHub commit sha')),
      },
    });
    return sha(asObject(result.json, 'GitHub commit response')['sha'], 'GitHub commit sha');
  }

  async createReference(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly commitSha: string;
  }): Promise<string> {
    const branch = branchName(input.branch);
    const result = await this.request({
      method: 'POST',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, 'refs'),
      body: { ref: `refs/heads/${branch}`, sha: sha(input.commitSha, 'GitHub commit sha') },
    });
    const object = asObject(result.json, 'GitHub reference response');
    const ref = responseString(object['ref'], 'GitHub reference', 512);
    if (ref !== `refs/heads/${branch}`) throw new Error('GitHub created an unexpected reference');
    return ref;
  }

  /**
   * Write ONE file through the contents API, creating the branch if it does
   * not exist.
   *
   * IT EXISTS BECAUSE THE GIT DATA API CANNOT START A REPOSITORY. Measured
   * against real GitHub on 2026-08-23, in a repository created moments
   * earlier: `POST /git/blobs` answers `409 {"message":"Git Repository is
   * empty."}`, and so does `POST /git/trees` with inline content. Every path
   * that begins with a blob or a tree is therefore unavailable for a first
   * commit, and the contents API — which answered 201 on the same repository
   * — is the only one that is. This was invisible to the suite because every
   * publisher test mocks this client.
   */
  async putContentsFile(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly path: string;
    readonly content: string | Uint8Array;
    readonly message: string;
    readonly branch: string;
  }): Promise<{ commitSha: string; treeSha: string; parents: number }> {
    const bytes =
      typeof input.content === 'string'
        ? Buffer.from(input.content, 'utf8')
        : Buffer.from(input.content);
    if (bytes.length > MAX_GITHUB_PUBLISH_FILE_BYTES) {
      throw new Error('GitHub contents write exceeds the per-file publish byte bound');
    }
    if (!input.message.trim() || input.message.length > 65_536 || input.message.includes('\u0000')) {
      throw new Error('GitHub commit message has an invalid value');
    }
    const result = await this.request({
      method: 'PUT',
      token: input.token,
      path: `/repos/${encodeSegment(ownerLogin(input.owner))}/${encodeSegment(
        repositoryName(input.repository)
      )}/contents/${filePath(input.path).split('/').map(encodeSegment).join('/')}`,
      body: {
        message: input.message,
        content: bytes.toString('base64'),
        branch: branchName(input.branch),
      },
    });
    const commit = asObject(
      asObject(result.json, 'GitHub contents response')['commit'],
      'GitHub contents commit'
    );
    // Whether this commit STARTED the repository or landed on top of someone
    // else's. The caller needs it: a contents write to an existing branch
    // succeeds silently, so the parent count is the only evidence that the
    // branch was empty when we looked.
    const parents = Array.isArray(commit['parents']) ? commit['parents'].length : 0;
    return {
      commitSha: sha(commit['sha'], 'GitHub commit sha'),
      treeSha: sha(asObject(commit['tree'], 'GitHub commit tree')['sha'], 'GitHub tree sha'),
      parents,
    };
  }

  /** Move a branch to a commit. Used only to complete a multi-file first push. */
  async updateReference(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly commitSha: string;
  }): Promise<string> {
    const branch = branchName(input.branch);
    const result = await this.request({
      method: 'PATCH',
      token: input.token,
      path: this.gitPath(input.owner, input.repository, `refs/heads/${branch}`),
      body: { sha: sha(input.commitSha, 'GitHub commit sha'), force: false },
    });
    const object = asObject(result.json, 'GitHub reference response');
    const ref = responseString(object['ref'], 'GitHub reference', 512);
    if (ref !== `refs/heads/${branch}`) throw new Error('GitHub moved an unexpected reference');
    return ref;
  }

  /** Validation and canonical ordering, before any I/O. Shared by both paths. */
  private normalizeManifestFiles(input: PublishGitHubManifestInput): {
    owner: string;
    repository: string;
    branch: string;
    files: Array<PublishFile & { bytes: number }>;
  } {
    const owner = ownerLogin(input.repository.owner);
    const repository = repositoryName(input.repository.name);
    const branch = branchName(input.branch ?? 'main');
    if ((!input.files.length && input.expectedHead === null) || input.files.length > MAX_GITHUB_PUBLISH_FILES) {
      throw new Error('GitHub publish has an invalid number of files');
    }
    const files = input.files.map((file) => ({
      ...file, path: filePath(file.path), bytes: publishFileBytes(file),
    })).sort((left, right) => left.path.localeCompare(right.path));
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_GITHUB_PUBLISH_FILE_BYTES) throw new Error('GitHub file exceeds the per-file publish byte bound');
      if (seen.has(file.path)) throw new Error('GitHub publish contains duplicate paths');
      seen.add(file.path);
      totalBytes += file.bytes;
      if (totalBytes > MAX_GITHUB_PUBLISH_TOTAL_BYTES) {
        throw new Error('GitHub publish exceeds the total byte bound');
      }
    }
    return { owner, repository, branch, files };
  }

  /** One blob per manifest file, in canonical order, as tree entries. */
  private async blobEntries(
    token: string,
    owner: string,
    repository: string,
    files: readonly PublishFile[]
  ): Promise<Array<{ path: string; sha: string; mode?: '100644' | '100755' }>> {
    const entries: Array<{ path: string; sha: string; mode?: '100644' | '100755' }> = [];
    for (const file of files) {
      entries.push({
        path: file.path,
        ...(file.mode !== undefined ? { mode: file.mode } : {}),
        sha: await this.createBlob({ token, owner, repository, content: publishFileContent(file) }),
      });
    }
    return entries;
  }

  /**
   * Move a branch, and say WHICH refusal it was when GitHub declines.
   *
   * `updateReference` sends `force: false`, so GitHub's own fast-forward check
   * is the concurrency test — but it answers 422 both when somebody else moved
   * the branch and when a protection rule forbids the update, and
   * `GitHubApiError` carries no response body. So the branch is re-read once,
   * best effort, and the head decides the sentence. Anything that is not 422 or
   * 409 propagates untouched: a 403 from a ruleset must not be dressed up as
   * divergence.
   */
  private async moveBranch(input: {
    readonly token: string;
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly expectedSha: string;
    readonly commitSha: string;
  }): Promise<void> {
    try {
      await this.updateReference({
        token: input.token,
        owner: input.owner,
        repository: input.repository,
        branch: input.branch,
        commitSha: input.commitSha,
      });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 422 && error.status !== 409)) {
        throw error;
      }
      const head = await this.readBranchHead(
        input.token,
        input.owner,
        input.repository,
        input.branch
      ).catch(() => null);
      throw new GitHubRefRefusedError({
        owner: input.owner,
        repository: input.repository,
        branch: input.branch,
        expectedSha: input.expectedSha,
        observedSha: head !== null && head.state === 'head' ? head.sha : null,
        commitSha: input.commitSha,
      });
    }
  }

  /**
   * Publish one artifact manifest: create the branch, or commit ON TOP of what
   * this project last published.
   *
   * THE DECISION IS TAKEN FROM GITHUB, not from the store. `expectedHead` is
   * the authority (this project's own last published commit, or null), and the
   * live head read is the fact. Reading `repository_status = 'ready'` as "the
   * branch is ours" is what made publication single-shot.
   *
   * An incremental commit MERGES onto the parent's tree (`base_tree`), so a
   * path the manifest does not name is never removed. That is deliberate and
   * asymmetric: a manifest is `plan.subtasks.flatMap(s => s.outputs)`, a
   * model's plan-time declaration of what THIS run would write, and the
   * workspace is seeded from the previous delivered workspace — so absence
   * from a manifest says nothing about a user's intent. Replacing the tree
   * would let "run 2 only touched index.html" delete `app.js` from the branch
   * tip while `app.js` still sits on disk in that very run, breaking the
   * published site from a run that SUCCEEDED. The cost is that publication
   * cannot delete; a human deletes in one click.
   */
  async publishManifestCommit(input: PublishGitHubManifestInput): Promise<GitHubPublishedCommit> {
    const { owner, repository, branch, files } = this.normalizeManifestFiles(input);
    const ref = `refs/heads/${branch}`;
    const head = await this.readBranchHead(input.token, owner, repository, branch);

    if (input.expectedHead === null) {
      if (input.seedCommitSha) {
        const seedSha = sha(input.seedCommitSha, 'GitHub seed commit sha');
        if (head.state !== 'head') throw new GitHubDivergenceError(owner, repository, branch);
        const seed = await this.getCommit(input.token, owner, repository, seedSha);
        const current = head.sha === seedSha ? seed : await this.getCommit(input.token, owner, repository, head.sha);
        if (seed.parents.length !== 0 || (head.sha !== seedSha &&
          (current.parents.length !== 1 || current.parents[0] !== seedSha))) {
          throw new GitHubDivergenceError(owner, repository, branch, head.sha);
        }
        const entries = await this.blobEntries(input.token, owner, repository, files);
        const treeSha = await this.createTree({ token: input.token, owner, repository, entries });
        // A completed remote write whose local receipt failed converges only
        // on the exact tree and direct parent recorded by this publication.
        if (current.treeSha === treeSha) return Object.freeze({ branch, treeSha,
          commitSha: head.sha, ref, baseSha: null, publishKind: 'created' as const });
        if (head.sha !== seedSha) throw new GitHubDivergenceError(owner, repository, branch, head.sha);
        const commitSha = await this.createCommit({ token: input.token, owner, repository,
          message: input.message, treeSha, parents: [seedSha] });
        await this.moveBranch({ token: input.token, owner, repository, branch,
          expectedSha: seedSha, commitSha });
        return Object.freeze({ branch, treeSha, commitSha, ref, baseSha: null, publishKind: 'created' as const });
      }
      // Without a durable receipt, populated branches remain unowned.
      if (head.state === 'head') throw new GitHubDivergenceError(owner, repository, branch, head.sha);
      // THE BRANCH IS SEEDED THROUGH THE CONTENTS API, always. A repository
      // with no commits refuses `git/blobs` and `git/trees` alike (409, "Git
      // Repository is empty"), so the first write cannot be a git-data write.
      // The seed carries a real file from the manifest, never a placeholder:
      // nobody should have to explain a junk commit later.
      const seed = files[0]!;
      const seeded = await this.putContentsFile({
        token: input.token,
        owner,
        repository,
        path: seed.path,
        content: publishFileContent(seed),
        message: input.message,
        branch,
      });
      // THE RACE THAT THE OLD FLOW CAUGHT WITH A 422. A contents write to a
      // branch created inside the window simply lands on it, so the seed
      // commit's PARENT COUNT is the evidence: a root commit means the branch
      // was ours to start, anything else means somebody created it inside the
      // window. One file has been written by then, and saying so loudly beats
      // publishing the rest on top of content this product never saw.
      if (seeded.parents > 0) throw new GitHubDivergenceError(owner, repository, branch);
      await input.onSeed?.(seeded.commitSha);
      if (files.length === 1 && seed.mode !== '100755') {
        return Object.freeze({
          branch,
          treeSha: seeded.treeSha,
          commitSha: seeded.commitSha,
          ref,
          baseSha: null,
          publishKind: 'created' as const,
        });
      }
      // More than one file: the repository now HAS a commit, so the git data
      // API works and the whole tree lands in a second commit on top of the
      // seed. No `baseTreeSha` — on a first publication the manifest IS the
      // tree. Two commits rather than one, and both of them ours.
      const entries = await this.blobEntries(input.token, owner, repository, files);
      const treeSha = await this.createTree({ token: input.token, owner, repository, entries });
      const commitSha = await this.createCommit({
        token: input.token,
        owner,
        repository,
        message: input.message,
        treeSha,
        parents: [seeded.commitSha],
      });
      await this.moveBranch({
        token: input.token,
        owner,
        repository,
        branch,
        expectedSha: seeded.commitSha,
        commitSha,
      });
      return Object.freeze({
        branch,
        treeSha,
        commitSha,
        ref,
        baseSha: null,
        publishKind: 'created' as const,
      });
    }

    // THIS PROJECT HAS PUBLISHED HERE BEFORE. A branch that is gone is refused
    // rather than re-seeded: a second root history in a repository a tenant has
    // already cloned is worse than a stopped publication.
    if (head.state !== 'head') {
      throw new GitHubBranchGoneError({
        owner,
        repository,
        branch,
        reason: head.state,
        publishedSha: input.expectedHead,
      });
    }
    // Deliberately NOT requiring `head.sha === input.expectedHead`. A branch
    // that moved for a reason this product did not cause — a merged pull
    // request, a typo fixed in the browser — must not brick the project, and a
    // merge cannot delete what that change added. The observed head is
    // returned as `baseSha`, which makes "somebody moved this branch" a
    // store-only, network-free, timestamped fact afterwards.
    const baseTreeSha = (await this.getCommit(input.token, owner, repository, head.sha)).treeSha;
    const selected = input.selectFiles ? await input.selectFiles(head.sha) : { files, message: input.message };
    const selectedFiles = this.normalizeManifestFiles({ ...input, files: selected.files }).files;
    if (!selectedFiles.length) return { branch, treeSha: baseTreeSha, commitSha: head.sha,
      ref, baseSha: head.sha, publishKind: 'unchanged' };
    const entries = await this.blobEntries(input.token, owner, repository, selectedFiles);
    const treeSha = await this.createTree({
      token: input.token,
      owner,
      repository,
      entries,
      baseTreeSha,
    });
    // THE ORDER HERE IS LOAD-BEARING: the tree is built and compared BEFORE any
    // commit object exists. Git trees are content-addressed, so an identical
    // result sha means the branch tip already holds every byte this manifest
    // declares — which is both the empty-diff case and the repair for a crash
    // between the reference move and the store write. Merging a manifest onto
    // its own result is idempotent; replacing would not be.
    if (treeSha === baseTreeSha) {
      return Object.freeze({
        branch,
        treeSha,
        commitSha: head.sha,
        ref,
        baseSha: head.sha,
        publishKind: 'unchanged' as const,
      });
    }
    const commitSha = await this.createCommit({
      token: input.token,
      owner,
      repository,
      message: selected.message,
      treeSha,
      parents: [head.sha],
    });
    await this.moveBranch({
      token: input.token,
      owner,
      repository,
      branch,
      expectedSha: head.sha,
      commitSha,
    });
    return Object.freeze({
      branch,
      treeSha,
      commitSha,
      ref,
      baseSha: head.sha,
      publishKind: 'extended' as const,
    });
  }

  private gitPath(owner: string, repository: string, object: string): string {
    return `/repos/${encodeSegment(ownerLogin(owner))}/${encodeSegment(repositoryName(repository))}/git/${object}`;
  }
}
