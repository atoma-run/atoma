import { RunCheckpointStore, canonicalCheckpointWorkspacePath } from '../run/checkpoint.js';
import { platformLimitsFor } from '../platform/settings.js';
import { inventoryRepositoryWorkspace, carryRepositoryBase } from './repositorySync.js';
import { GitHubAccessRequiredError } from './publisher.js';
import { assertPersonalCodexModels, CODEX_MODEL_CAPABILITIES_ENV, type CodexModelInventory } from '../contracts/codexModels.js';
import { projectWorkspaceRelative } from '../contracts/launcherVolumes.js';
import { randomUUID } from 'node:crypto';
import { migratePlatformSkills, reconcilePlatformSkills } from '../skills/migratePlatform.js';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseRunLog, spawnRun, DEFAULT_HARD_KILL_MARGIN_MS, UNKILLABLE_BACKSTOP_EXTRA_MS, type RunStats } from '../cli/burnin.js';
import { encodePreviousLanding, PREVIOUS_LANDING_ENV } from '../contracts/runLanding.js';
import { PREVIOUS_RESULTS_ENV } from '../contracts/previousRunResults.js';
import { previousResultsFor } from './previousResults.js';
import { standingHttpEvidenceFor } from './standingEvidence.js';
import { STANDING_HTTP_EVIDENCE_ENV } from '../contracts/standingHttpEvidence.js';
import { ACCEPTANCE_SOURCE_ENV, ACCEPTANCE_SPEC_ENV } from '../contracts/acceptanceChecklist.js';
import { encodeAcceptanceSpec } from '../run/acceptanceSpec.js';
import { capturePlatformTissueAuthor } from '../run/tissueAuthor.js';
import type { RunTitler } from './runTitle.js';
import { PLATFORM_TISSUE_AUTHOR_ENV } from '../contracts/tissueRouting.js';
import { declaredArtifactManifestSchema } from '../contracts/artifactManifest.js';
import type {
  ArtifactManifest,
  StartProjectRunInput,
  Project,
  ProjectRun,
  Publication,
} from '../contracts/projects.js';
import type { RunTierModels, TierModelPins } from '../contracts/tierModels.js';
import { PERSONAL_CODEX_PROFILE_ROOT_ENV } from '../core/codexHomeLease.js';
import { JEV_ENV, JEV_KEY_ENV, JEV_PROGRESSIVE_ENV, jevEnabled } from '../core/jev.js';
import { skillsDirPath } from '../core/stores.js';
import { LLM_PROVIDER_CATALOG, findProvider, isAccountTierSelection } from '../core/providerCatalog.js';
import { DEFAULT_PLATFORM_LIMITS, type PlatformLimits } from '../contracts/platformSettings.js';
import {
  assertServedHostChatGptModels,
  ledgerTouchesAnySubscription,
  ledgerTouchesSubscription,
  payerForSelector,
  principalSubscriptionTiers,
  runPayerLedgerSchema,
  subscriptionTiers,
  subscriptionTransports,
  tierPayerRow,
  type RunPayerLedger,
  type TierPayer,
} from '../contracts/runPayers.js';
import {
  MODEL_SELECTOR_GRAMMAR,
  parseModelSelector,
  tierPinVariable,
  TIERS,
  tryParseModelSelector,
  type ModelSelector,
  type TierNumber,
} from '../contracts/modelSelector.js';
import {
  resolveTierChain,
  tierChainCandidates,
  type TierChainLevel,
} from '../contracts/tierModels.js';
import type { ProviderKeyProvider } from '../auth/store.js';
import { readTraceTopLevelFields } from '../contracts/traceFields.js';
// TYPE-ONLY, and it must stay that way: `src/viz/server.ts` imports four
// `src/projects` modules, so a value edge back into `src/viz` would close a
// subsystem cycle and put the delivered/failed decision inside the
// visualization subsystem. The import earns its place by pinning the member
// names below against the shape the recorder actually writes.
import type { VizRun } from '../viz/trace.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../run/runner.js';
import {
  acquireRunLease,
  RunLockBusyError,
  type RunLease,
  type RunLeaseAcquirer,
} from '../mcp/runLock.js';
import { repoRoot } from '../mcp/run.js';
import { buildWorkspaceArtifactManifest, revalidateArtifactManifest } from './artifacts.js';
import { ProjectStateConflict, ProjectStore } from './store.js';
import { ProjectRetrievalLaunchStore } from './retrievalLaunch.js';
import { resolveRerunOrigin, type RerunOrigin } from './rerun.js';
import { HAYSTACK_LAUNCH_ENV, readHaystackLaunch } from '../contracts/retrievalHaystack.js';

const MAX_CONTROL_JSON_BYTES = 512 * 1024;

export interface ProjectRunPublisher {
  syncRun?(project: Project, run: ProjectRun, seed: ProjectRun | null, signal: AbortSignal): Promise<string | undefined>;
  prepareRun?(project: Project, run: ProjectRun, signal: AbortSignal): Promise<string>;
  publish(input: {
    readonly project: Project;
    readonly run: ProjectRun;
    readonly workspaceRoot: string;
    readonly manifest: ArtifactManifest;
    readonly manifestHash: string;
  }): Promise<void | Publication | null>;
}

export type ProjectRunDriver = typeof spawnRun;

/**
 * Terminal outcome of one project run, emitted exactly once from `finish()`
 * after the state transition is persisted. Consumers (the viz push notifier)
 * are fail-open: a throwing listener is stderr, never a run failure.
 */
export interface ProjectRunFinishedEvent {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  /** The principal who requested the run — the one to notify. */
  readonly principalId: string;
  readonly goal: string;
  readonly status: 'delivered' | 'partial' | 'failed' | 'cancelled';
}

export interface ProjectCoordinatorOptions {
  readonly store: ProjectStore;
  readonly dbPath: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Host root whose layout is `orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
  readonly projectsRoot?: string;
  readonly skillsDir?: string;
  readonly driver?: ProjectRunDriver;
  readonly acquireLease?: RunLeaseAcquirer;
  /**
   * Ask this host's background analysis to give the run slot up; true once
   * it has. Called when the slot's holder is the resident analyst: a
   * member's run preempts a post-run analysis instead of being refused
   * behind it (owner decision 2026-09-27). The mender is never preempted.
   */
  readonly yieldBackground?: () => Promise<boolean>;
  readonly publisher?: ProjectRunPublisher;
  readonly onRunFinished?: (event: ProjectRunFinishedEvent) => void | Promise<void>;
  /**
   * The requesting principal's per-tier model pins, when the deployment has
   * accounts (the viz gate supplies `authStore.modelPins`). Fail-open: a
   * throwing resolver falls back to the operator's host pins, because a
   * preference lookup must never be able to block a run.
   */
  readonly tierModelsFor?: (principalId: string) => TierModelPins;
  /**
   * The requesting principal's organisation's per-tier DEFAULTS (the second
   * level of the precedence chain account pin > org default > host env).
   * Same fail-open rule as `tierModelsFor`: resolved as a QUESTION per run,
   * never trusted from the request.
   */
  readonly orgTierModelsFor?: (orgId: string) => TierModelPins;
  /**
   * One provider credential the ORG configured, decrypted for injection into
   * this run child's environment. Resolved per (orgId, provider) at launch;
   * null or a throwing resolver means "no key", which degrades to not
   * forwarding that provider — never to failing the run.
   */
  readonly orgProviderKeyFor?: (
    orgId: string,
    provider: ProviderKeyProvider
  ) => string | null;
  /**
   * Does this principal hold the instance-wide platform-admin flag? Supplied
   * as a QUESTION, never as an answer: the coordinator asks it itself, so no
   * caller can hand in a pre-decided "yes". Absent or throwing means NO —
   * fail-closed, unlike `tierModelsFor`, because this one gates spending.
   *
   * It is the authority for the subscription-transport door
   * (`projectRunEnvironment`). The platform-admin flag is the right authority
   * because it is never derived from an OAuth claim: only the operator CLI,
   * run against the store on disk, can mint it (`src/cli/auth.ts`).
   */
  readonly platformAdmins?: (principalId: string) => boolean;
  /**
   * The SECOND authority for the same door, asked with the same fail-closed
   * rules: has a platform admin delegated the host subscription to THIS
   * principal IN THIS ORGANISATION (`src/auth/subscriptionDelegates.ts`)?
   *
   * It takes the organisation because the delegation is membership-scoped,
   * where the operator flag is instance-wide. Neither widens what a `sub:`
   * pin may do: the pin still has to be the requester's own account pin, and
   * the run still has to belong to the declared organisation.
   */
  readonly subscriptionDelegates?: (principalId: string, orgId: string) => boolean;
  /**
   * Resolve the requesting principal's CURRENT personal Codex generation.
   * The resolver is asked at launch, never trusted from an HTTP request. A
   * missing/throwing resolver is a hard refusal only when a personal sentinel
   * was selected; it can never fall through to the host's Codex login.
   */
  readonly principalCodexProfileFor?: (
    principalId: string
  ) => PrincipalCodexProfile | null;
  readonly principalCodexModelsFor?: (principalId: string) => Promise<CodexModelInventory>;
  /**
   * Observer fired when a run spends any CLI subscription (host or requesting
   * principal). The payer ledger distinguishes them; the caller journals it,
   * so there is one delivery path as with `onRunFinished`.
   */
  readonly onSubscriptionTransport?: (info: SubscriptionTransportUse) => void;
  /**
   * Describe the delivered workspace for the result preview, at delivery.
   *
   * A NARROW COLLABORATOR, like `publisher` and `onRunFinished`, and for the
   * same reason: the coordinator owns when a run is delivered, not what a
   * preview is. It supplies the identity and the workspace it already holds;
   * the caller classifies and stores.
   *
   * WHY AT DELIVERY AND NOT ON DEMAND. The workspace is the seed of the next
   * run, so what it holds is a fact about THIS run only while this run is the
   * latest; and a classification computed per request would probe the
   * filesystem on a route a browser polls. Deciding once, here, is what lets
   * unavailability carry a stable reason.
   *
   * FAIL-OPEN, and that is not a shrug: a preview is a convenience over work
   * that is already delivered and already paid for. This repo has measured
   * what the other choice costs — a trace-size cap recorded delivered run
   * `2857a579` as failed and erased $0.84 of stats — so nothing on this path
   * may downgrade a delivered run. A throw is caught and reported to stderr,
   * and the missing row reads as `legacy-run`, which is exactly what it is.
   */
  readonly describeDeliveredPreview?: (input: DeliveredPreviewSubject) => void;
  /**
   * Name every run once it ENDED (delivered, partial, failed or cancelled):
   * one short line for the lists that would otherwise print a whole goal
   * (`runTitle.ts`, normally `hostRunTitler(hostEnv)`). A narrow collaborator
   * like the two above, and fail-open the same way: it starts after the
   * terminal transition, never delays the lease, and a `null` or a throw only
   * means the run keeps showing its goal.
   */
  readonly runTitler?: RunTitler;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * THE PLATFORM'S OWN LIMITS, read fresh per run.
   *
   * A FUNCTION and not a value, for the same reason it is injected rather
   * than opened here: the coordinator outlives every settings change a
   * platform admin makes in the viz, so a value captured at construction
   * would mean "restart the server to change a limit" — and the dependency
   * arrow points from the server at the domain, so this module must not learn
   * where the settings table lives. Absent means the shipped constants, which
   * is what every caller outside a gated deployment gets.
   */
  readonly platformLimits?: () => PlatformLimits;
  /** Re-check membership when a previously admitted request leaves the queue. */
  readonly queuedRunAllowed?: (principalId: string, orgId: string) => boolean;
}

/** What the coordinator knows about a delivered run's deliverable. */
export interface DeliveredPreviewSubject {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  readonly workspaceRoot: string;
}

/** One run allowed through the subscription-transport door. */
export interface SubscriptionTransportUse {
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRunId: string;
  readonly principalId: string;
  /** The subscription transports this run spends, comma-joined (`claude-cli`, `codex-cli`). */
  readonly transport: string;
  /**
   * WHICH TIERS, PAID BY WHOM. A whole-run fact is no longer enough: a run may
   * spend the operator's login on L2 and L3 while L1 bills the organisation's
   * own key, and the journal row has to say so or it names the wrong payer.
   * The caller journals; this coordinator emits no audit row itself, as with
   * `onRunFinished`.
   */
  readonly payers: RunPayerLedger;
}

/** How long a member's start waits for the analysis it preempts to let go of the slot. */
export const PREEMPT_ANALYST_WAIT_MS = 20_000;

/** Every way a run ENDS; each one is named, so no list prints a whole goal. */
const TITLED_STATUSES: ReadonlySet<string> = new Set(['delivered', 'partial', 'failed', 'cancelled']);

export class ProjectRunBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRunBusy';
  }
}

/**
 * What a member is told when the one run slot is taken: WHY, in words that
 * hold no host detail. The lease's own message names the holder's run id,
 * pid and start time — the deployment's process table, relayed verbatim to a
 * tenant as a 409 until 2026-09-26. Holding the slot for post-run
 * maintenance is the documented resource trade (`src/supervisor/AGENTS.md`);
 * saying so is what makes "retry in a few minutes" an honest answer.
 */
export function tenantBusyMessage(owner: { readonly runId: string } | undefined, condition: RunLockBusyError['condition'] = 'held'): string {
  if (condition === 'capacity') {
    return 'the instance has reached its concurrent run limit; start your run when a place becomes available';
  }
  if (condition === 'wedged') {
    return 'the run slot is held by a run the instance could not clean up; an operator has to release it before a new run can start';
  }
  if (condition === 'pending') {
    // Waiting can outlast "a few minutes": the update lets the current work
    // finish first, however long that takes.
    return 'the instance is about to be updated and is letting the current work finish first; start this run again once the update is done';
  }
  const holder = owner?.runId ?? '';
  if (holder.startsWith('analyst:')) {
    return 'the platform is reviewing a finished run and holds the one run slot for a few minutes; start this run again shortly';
  }
  if (holder.startsWith('mender:')) {
    return 'the platform is preparing a fix for a finished run and holds the one run slot; start this run again later';
  }
  if (holder.startsWith('deployment:')) {
    return 'the instance is being updated; start this run again in a few minutes';
  }
  if (holder.startsWith('maintenance:')) {
    return 'the instance is running scheduled maintenance; start this run again shortly';
  }
  return 'another run is in progress on this instance; start your run once that one finishes';
}

/** The refusal when the run holding the place is the caller's own. */
export function ownLiveRunMessage(run: { readonly projectRunId: string; readonly projectId: string }): string {
  return `your run ${run.projectRunId} (project ${run.projectId}) is still in progress; ` +
    'follow it with atoma_run_status — do not start it again';
}

export class ProjectRunConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRunConfigurationError';
  }
}

interface ActiveRun {
  readonly orgId: string;
  readonly principalId: string;
  readonly controller: AbortController;
}

/** Non-secret, exact generation passed from the account-profile authority. */
export interface PrincipalCodexProfile {
  readonly profileId: string;
  readonly homePath: string;
  readonly profilesRoot: string;
}

const FORWARDED_HOST_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'CI',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'ATOMA_EGRESS_ALLOWLIST',
  'ATOMA_LAUNCHER_SOCKET', 'ATOMA_LAUNCHER_WORKSPACE_ID', 'ATOMA_WORKER_IMAGE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * The `sub:` selectors a host environment pins, as `VAR=value` strings, for
 * the CLI guard that refuses them to anyone but a platform admin. Malformed
 * values are not this function's business: the run's own launch refuses them
 * with the grammar.
 */
export function hostSubscriptionPinsOf(env: NodeJS.ProcessEnv): string[] {
  return TIERS.flatMap((tier) => {
    const value = env[tierPinVariable(tier)]?.trim();
    const selector = value ? tryParseModelSelector(value) : null;
    return selector && selector.mode !== 'api' ? [`${tierPinVariable(tier)}=${value}`] : [];
  });
}

/** Where an `api:` vendor's credential comes from for this run, if anywhere. */
type VendorCredentialSource = 'org' | 'host' | 'selfhosted' | null;

/**
 * ONE ANSWER PER VENDOR, not per tier: a vendor's credential is one
 * environment variable, so every tier on `api:<vendor>` shares it. The org's
 * OWN key wins over the host's — "the org brought its own key" is BYO-key's
 * entire point — and Ollama needs no secret but does need the operator to have
 * DECLARED an endpoint: assuming the default localhost is exactly what
 * detonates on a host without one, so no declaration means the pin falls
 * through like any vendor whose credential nobody brought. The endpoint is the
 * OPERATOR's infrastructure: an org picks ollama models, never an ollama
 * destination (a tenant-supplied URL would be SSRF from the platform).
 */
function vendorCredentialSource(
  vendor: ModelSelector['vendor'],
  keys: Partial<Record<ProviderKeyProvider, string>>,
  hostEnv: NodeJS.ProcessEnv
): VendorCredentialSource {
  const entry = findProvider(vendor);
  if (!entry) return null;
  if (entry.credentialEnvVar === null) {
    return hostEnv['OLLAMA_BASE_URL']?.trim() ? 'selfhosted' : null;
  }
  if (keys[vendor]?.trim()) return 'org';
  if (hostEnv[entry.credentialEnvVar]?.trim()) return 'host';
  return null;
}

/**
 * MAY THIS RUN SPEND THE OPERATOR'S OWN LOGIN ON THIS TIER? Three refusals,
 * each naming what is missing, and every one of them THROWS rather than
 * falling through: a revoked authority that quietly became a billed
 * credential is exactly the audit lie this feature exists to avoid.
 *
 * The authority is asked HERE, per run, and is never handed in as an answer —
 * `resolveSubscriptionGrant` is fail-closed and reads either the platform-admin
 * flag, which only the operator CLI can mint, or a delegation a platform admin
 * granted to this principal IN THIS ORGANISATION
 * (`src/auth/subscriptionDelegates.ts`). A stored pin is data; permission is
 * asked again here, whichever of the two answers it.
 */
function assertSubscriptionPinIsHonourable(input: {
  readonly tier: TierNumber;
  readonly level: TierChainLevel;
  readonly grant: { readonly principalId: string } | undefined;
  readonly declaredOrg: string | undefined;
  readonly orgId: string | undefined;
}): void {
  const where = tierPinVariable(input.tier);
  // `run` is the requester's own choice for ONE run (a comparison rerun), so
  // it stands where the account pin stands; the grant is still asked below.
  if (input.level !== 'account' && input.level !== 'run') {
    // An org default is inherited by every member by construction, and the
    // host env is the third candidate for EVERY tier: a `sub:` selector at
    // either level would be a payer-bearing default nobody chose (D2/D3).
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription from the ${input.level} level; only a platform ` +
        "admin's own account pin may spend the operator's login"
    );
  }
  if (!input.grant) {
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription, but the requesting account is neither a platform ` +
        'admin nor a delegate of it in this organisation. Clear the pin in Settings, or have the ' +
        'delegation restored'
    );
  }
  if (!input.declaredOrg) {
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription, but this deployment declares no organisation for ` +
        'it. Set ATOMA_HOST_SUBSCRIPTION_ORG, or clear the pin in Settings'
    );
  }
  if (input.orgId !== input.declaredOrg) {
    throw new ProjectRunConfigurationError(
      `${where} names the host subscription, but this run belongs to another organisation than ` +
        'the one this deployment declares for it'
    );
  }
}

/**
 * A personal subscription is valid only as the requester's own account pin.
 * Unlike a missing catalogue key, loss of the exact profile is never a
 * fall-through: changing payer after the user selected their subscription
 * would make both the bill and the audit row false.
 */
function assertPrincipalSubscriptionPinIsHonourable(input: {
  readonly tier: TierNumber;
  readonly level: TierChainLevel;
  readonly vendor: ModelSelector['vendor'];
  readonly profile: PrincipalCodexProfile | undefined;
}): void {
  const where = tierPinVariable(input.tier);
  if (input.level !== 'account' && input.level !== 'run') {
    throw new ProjectRunConfigurationError(
      `${where} names a personal subscription from the ${input.level} level; only the ` +
        "requesting member's own account pin may spend their subscription"
    );
  }
  if (input.vendor !== 'openai') {
    // Anthropic requires prior approval before a third-party product may
    // offer claude.ai login; until then `own:anthropic` has no transport.
    throw new ProjectRunConfigurationError(
      `${where} names a personal Claude subscription, which this deployment cannot offer yet`
    );
  }
  if (!input.profile) {
    throw new ProjectRunConfigurationError(
      `${where} names the requester's ChatGPT subscription, but their Codex account is no ` +
        'longer connected. Reconnect it in Settings or clear the pin'
    );
  }
}

export interface ProjectRunEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  /** Who paid for what, per tier. */
  readonly payers: RunPayerLedger;
}

export function projectRunEnvironment(input: {
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly dbPath: string;
  readonly workspacePath: string;
  readonly runsPath: string;
  readonly skillsPath: string;
  readonly runId: string;
  readonly artifactManifestPath: string;
  /**
   * The requesting account's per-tier choices, and the organisation's
   * defaults beneath them. `resolveTierChain` walks account pin > org default
   * > host pin per tier, and EVERY tier must resolve: there is no base
   * transport and no built-in default to fall back on (2026-09-07).
   *
   * Every value is a full selector (`contracts/modelSelector.ts`). An `api:`
   * selector is honoured when its vendor's credential is available to this
   * run — the org's own key, or the host's — and falls through otherwise; a
   * `sub:`/`own:` selector is honoured after its authority is re-asked here
   * and refused, never skipped, when it is not.
   */
  readonly tierModels?: TierModelPins;
  /** The org-level defaults under `tierModels`. See its doc above. */
  readonly orgTierModels?: TierModelPins;
  /**
   * A comparison rerun's models, above every stored level. Unlike those, a
   * run-level `api:` choice whose vendor has no credential REFUSES instead of
   * falling through: the whole point of the rerun is to run on exactly these
   * models, and a fall-through would compare against models nobody asked for.
   */
  readonly runModels?: RunTierModels;
  /**
   * The organisation this run belongs to. Required to judge a per-tier
   * host-subscription pin: the deployment declares ONE organisation in
   * `ATOMA_HOST_SUBSCRIPTION_ORG` where the operator's own login may be
   * spent, and a pin naming it from anywhere else is refused (design
   * 2026-08-28, D6/Q1). Optional so the many callers that never touch the
   * subscription keep compiling; absent simply cannot match a declaration.
   */
  readonly orgId?: string;
  /**
   * Credentials the org configured, by vendor id. Present keys are forwarded
   * into the run child for the vendors its tiers reference; absent ones are
   * not.
   */
  readonly orgProviderKeys?: Partial<Record<ProviderKeyProvider, string>>;
  /**
   * THE SUBSCRIPTION-TRANSPORT DOOR. Present only when the coordinator has
   * verified that the REQUESTING principal holds the platform-admin flag.
   *
   * A `sub:` selector binds to the host's own `claude /login` or `codex login`
   * session, so the run spends THAT subscription and cannot honour a per-run
   * credential. For a tenant that would be one account billing another, which
   * is why the default is refusal. For a platform admin on their own instance
   * the host subscription IS their subscription, so the objection does not
   * apply — and the platform-admin flag is the right authority precisely
   * because it is never derived from an OAuth claim: only the operator CLI,
   * run against the store on disk, can mint it.
   */
  readonly subscriptionTransport?: { readonly principalId: string };
  /** Exact personal Codex generation resolved for the requesting principal. */
  readonly principalCodexProfile?: PrincipalCodexProfile;
}): ProjectRunEnvironment {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED_HOST_ENV) {
    const value = input.hostEnv[key];
    if (value !== undefined) environment[key] = value;
  }
  environment['NODE_ENV'] = 'production';
  // Shared catalog authorship is platform work, independent of the run's payer.
  // Capture the host L3 and its credential before any account/org override.
  environment[PLATFORM_TISSUE_AUTHOR_ENV] = capturePlatformTissueAuthor(input.hostEnv);
  // THE HOST'S OLLAMA ENDPOINT crosses on every run: it selects no payer
  // (self-hosted, priced at zero), so unlike a vendor gateway URL it is safe
  // beside a BYO key and on a subscription run alike. Forwarded BEFORE tier
  // resolution because it is what makes an ollama pin honourable.
  const ollamaBaseUrl = input.hostEnv['OLLAMA_BASE_URL']?.trim();
  if (ollamaBaseUrl) environment['OLLAMA_BASE_URL'] = ollamaBaseUrl;
  const orgKeys = input.orgProviderKeys ?? {};
  const subscriptionOrg = input.hostEnv['ATOMA_HOST_SUBSCRIPTION_ORG']?.trim();
  const ledger: Partial<Record<'l1' | 'l2' | 'l3', TierPayer>> = {};
  /** Vendors whose credential this run takes, and from where. */
  const vendorSources = new Map<ModelSelector['vendor'], VendorCredentialSource>();

  // TIER RESOLUTION: run > account pin > org default > host env, resolved PER
  // CANDIDATE so a preference pointing at a vendor whose credential nobody
  // configured falls through to the level beneath it instead of reaching the
  // router and detonating mid-run.
  //
  // THE THREE ANSWERS ARE NOT INTERCHANGEABLE, and the rule generalises:
  // FALL-THROUGH IS PERMITTED WITHIN A PAYER, REFUSAL IS REQUIRED ACROSS
  // PAYERS. A credential nobody brought is a fall-through (the next level
  // bills the same kind of account); a selector you may not use, or an
  // authority you no longer hold, is a refusal — falling through there would
  // move the payer from the operator's subscription to a billed credential
  // with no event anywhere, which is the defect class finding 2.2 closed.
  for (const tier of TIERS) {
    const key = `l${tier}` as const;
    const variable = tierPinVariable(tier);
    const chosen = resolveTierChain(
      tierChainCandidates({
        run: input.runModels,
        account: input.tierModels,
        org: input.orgTierModels,
        host: input.hostEnv[variable],
        tier,
      }),
      (candidate) => {
        const selector = tryParseModelSelector(candidate.value);
        if (!selector) {
          throw new ProjectRunConfigurationError(
            `${variable}=${candidate.value} (${candidate.level} level) is not a model selector; ` +
              `expected ${MODEL_SELECTOR_GRAMMAR}`
          );
        }
        // A stored rerun row is read by SPELLING (`storedRunTierModelsSchema`),
        // so whether its model is still offered is asked HERE, at launch: a
        // retired model refuses this run instead of reaching the router.
        if (candidate.level === 'run' && !isAccountTierSelection(candidate.value, tier)) {
          throw new ProjectRunConfigurationError(
            `${variable}=${candidate.value} was asked for this run, but this deployment no longer ` +
              'offers that model on this tier'
          );
        }
        if (selector.mode === 'own') {
          assertPrincipalSubscriptionPinIsHonourable({
            tier,
            level: candidate.level,
            vendor: selector.vendor,
            profile: input.principalCodexProfile,
          });
          return 'take';
        }
        if (selector.mode === 'sub') {
          assertSubscriptionPinIsHonourable({
            tier,
            level: candidate.level,
            grant: input.subscriptionTransport,
            declaredOrg: subscriptionOrg,
            orgId: input.orgId,
          });
          return 'take';
        }
        const available = vendorCredentialSource(selector.vendor, orgKeys, input.hostEnv) !== null;
        if (!available && candidate.level === 'run') {
          throw new ProjectRunConfigurationError(
            `${variable}=${candidate.value} was asked for this run, but neither the organisation nor ` +
              `this deployment holds a ${selector.vendor} credential`
          );
        }
        // Fail-open: nobody brought this vendor's credential, so the next
        // level of the chain decides instead.
        return available ? 'take' : 'skip';
      }
    );
    if (!chosen) {
      throw new ProjectRunConfigurationError(
        `${variable}: no level supplies a selection this run can honour. Pick a model for this ` +
          'tier in Settings (account or organisation default) whose vendor key the organisation ' +
          `has saved, or pin ${variable} on the host beside its credential`
      );
    }
    const selector = parseModelSelector(chosen.value, variable);
    environment[variable] = chosen.value;
    // THE PAYER RULE IS THE CONTRACT'S, NOT THIS FUNCTION'S. This block used
    // to re-derive it, which left `payerForSelector` with no caller anywhere
    // and two definitions of "who paid" free to drift apart unobserved. Only
    // the second fact it needs is local: whether the organisation brought the
    // key for this vendor. The `vendorSources` entry is a separate output —
    // the credential injection below reads it — so it is still recorded here.
    let orgBroughtKey = false;
    if (selector.mode === 'api') {
      const source = vendorCredentialSource(selector.vendor, orgKeys, input.hostEnv);
      vendorSources.set(selector.vendor, source);
      orgBroughtKey = source === 'org';
    }
    ledger[key] = tierPayerRow({
      selection: chosen.value,
      payer: payerForSelector(selector, orgBroughtKey),
      source: chosen.level,
    });
  }
  const payers: RunPayerLedger = runPayerLedgerSchema.parse(ledger);

  // CREDENTIALS, ONE PER VENDOR THIS RUN REFERENCES, AND NOTHING ELSE — save
  // Jev's, which crosses below only for an organisation the host names.
  // `CHILD_ENV_ALLOWLIST` (`src/tools/sandbox.ts`) already keeps keys out of
  // tool subprocesses, so this is not a hole being closed — it is the
  // runner's own memory and `/proc` surface being no wider than the run needs
  // (2026-08-27, 3.1).
  for (const [vendor, source] of vendorSources) {
    const entry = findProvider(vendor);
    if (!entry?.credentialEnvVar) continue;
    if (source === 'org') {
      // BYO wins over the host: an org that brought its own key pays with it.
      // A BYO KEY GOES TO ITS OWN ISSUER: the host's gateway URL
      // (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, …) applies to the HOST's
      // credential, not to a tenant's, and forwarding it would send an
      // ORGANISATION's key to a third party it never consented to. So only
      // the key crosses on this branch.
      environment[entry.credentialEnvVar] = orgKeys[vendor]!.trim();
      continue;
    }
    if (source === 'host') {
      // NO BEARER TOKEN ON THIS PATH. `ANTHROPIC_AUTH_TOKEN` is the SDK's
      // other credential slot; a bearer is short-lived and refreshed from a
      // login profile on disk, while a run child receives a frozen env
      // snapshot it cannot refresh, so a long run would simply expire
      // mid-flight. Refused rather than dropped: an operator who exported a
      // bearer expecting it to be spent must be told it is not.
      if (vendor === 'anthropic' && input.hostEnv['ANTHROPIC_AUTH_TOKEN']?.trim()) {
        throw new ProjectRunConfigurationError(
          'project runs do not accept ANTHROPIC_AUTH_TOKEN: a bearer token is refreshed from a login ' +
            'profile the run child cannot read, so it would expire mid-run. Use ANTHROPIC_API_KEY on ' +
            "the host, or the organisation's own anthropic provider key"
        );
      }
      environment[entry.credentialEnvVar] = input.hostEnv[entry.credentialEnvVar]!.trim();
      for (const variableName of entry.configurableEnvVars) {
        const value = input.hostEnv[variableName]?.trim();
        if (value) environment[variableName] = value;
      }
    }
  }

  if (principalSubscriptionTiers(payers).length > 0) {
    if (!input.principalCodexProfile) {
      // Kept next to the environment mutation as a defensive invariant even
      // though the candidate gate above already refuses this state.
      throw new ProjectRunConfigurationError(
        "the requester's Codex profile disappeared while constructing the run"
      );
    }
    if (
      [payers.l1, payers.l2, payers.l3].some(
        (row) => row.provider === 'codex-cli' && row.payer === 'host-subscription'
      )
    ) {
      throw new ProjectRunConfigurationError(
        'one run cannot mix the host and requester ChatGPT subscriptions because Codex has ' +
          'one credential home per process'
      );
    }
    environment['CODEX_HOME'] = path.resolve(input.principalCodexProfile.homePath);
    environment['CODEX_SQLITE_HOME'] = path.resolve(input.principalCodexProfile.homePath);
    environment[PERSONAL_CODEX_PROFILE_ROOT_ENV] = path.resolve(
      input.principalCodexProfile.profilesRoot
    );
  }
  if (ledgerTouchesSubscription(payers)) {
    // A GATEWAY AND A SUBSCRIPTION DO NOT SHARE A RUN. `ANTHROPIC_BASE_URL`
    // redirects the anthropic transport at a third party; the subscription
    // subprocess already refuses every `ANTHROPIC_*` variable, so leaving it
    // in the env would only mislead about where the OTHER tiers went.
    delete environment['ANTHROPIC_BASE_URL'];
  }
  // JEV'S CREDENTIAL (docs/jev-decisions-2026-09-28.md) crosses into EVERY
  // organisation's runs, unless the platform switch is off (owner decision
  // 2026-09-30): Jev receives each decision's state — the task text, the
  // catalog, a plan or a result — as a third party, which the service terms
  // state. It is not a tier credential and pays for no tier; the switch
  // travels with it because this environment is an allowlist.
  if (jevEnabled(input.hostEnv)) {
    environment[JEV_KEY_ENV] = input.hostEnv[JEV_KEY_ENV]!.trim();
    environment[JEV_ENV] = '1';
    if (input.hostEnv[JEV_PROGRESSIVE_ENV] === '1') environment[JEV_PROGRESSIVE_ENV] = '1';
  } else if (input.hostEnv[JEV_ENV] === '0') {
    // Said in the run log as the platform's choice, not as a missing key.
    environment[JEV_ENV] = '0';
  }
  Object.assign(environment, {
    ATOMA_REQUIRE_ISOLATION: '1',
    ATOMA_CONTAINER: '1',
    ATOMA_EGRESS: input.hostEnv['ATOMA_EGRESS'] === '0' ? '0' : '1',
    ATOMA_DB_PATH: path.resolve(input.dbPath),
    ATOMA_LEDGER_DB: path.resolve(input.dbPath),
    ATOMA_BUILD_WORKSPACE: path.resolve(input.workspacePath),
    ATOMA_RUNS_DIR: path.resolve(input.runsPath),
    ATOMA_SKILLS_DIR: path.resolve(input.skillsPath),
    ATOMA_RUN_ID: input.runId,
    [ARTIFACT_MANIFEST_PATH_ENV]: path.resolve(input.artifactManifestPath),
    // SKILL LEARNING IS ON, and it is the point of the platform: a tenant's
    // runs should get cheaper as their project grows. It was off, and two
    // delivered runs measured what that costs — $0.59 spent, `learnedSkills:
    // 0`, nothing carried into the next run.
    ATOMA_SKILL_LEARN: '1',
    ATOMA_EVENT_SKILLS: '1',
    // A RUN IS A RUN (docs/platform-trust-2026-09-15.md): promotion,
    // deterministic dispatch and the prefilter cache follow the same defaults
    // as any run on this host — promotion is on unless the host says
    // otherwise, direct dispatch is on unless it says ATOMA_SKILL_DIRECT=0, and the cache
    // is the platform's. Nothing is pinned to '0' here any more, and no veto
    // flag travels below; a host that wants them off says so in its own env.
    // THE SECOND GATE'S INPUT. A tenant run's child re-checks, at launch,
    // that every machine-bound selector it can see was authorised HERE —
    // `assertTransportHonoursCredentials` in `src/run/providers.ts`.
    // `ATOMA_TENANT_RUN` is what arms it; the tier list is what keeps it from
    // refusing the very pins this coordinator just authorised (design
    // 2026-08-28, Q8).
    ATOMA_TENANT_RUN: '1',
  });
  const authorisedTiers = [
    ...subscriptionTiers(payers),
    ...principalSubscriptionTiers(payers),
  ];
  if (authorisedTiers.length > 0) {
    environment['ATOMA_SUBSCRIPTION_TIERS'] = authorisedTiers.join(',');
  }
  return { environment, payers };
}

/**
 * The workspace the next run of this project starts from: the most recent run
 * that produced one.
 *
 * It was `previousDeliveredRun` and took `delivered` only. A LANDED run counts
 * now, and that is the half of partial delivery that actually recovers the
 * spend: a run that completed three phases of four leaves those three on disk,
 * and the customer's next run continues from them instead of rebuilding them.
 * Without this the partial status would be a nicer label on the same loss.
 *
 * Order is "most recent first" from the store, and the first usable one wins —
 * a landed run is not ranked below an older complete one, because it is the
 * later state of the same evolving corpus (the project-continuity contract in
 * docs/incidents/progressive-runs-2026-09-21.md).
 */
export function previousSeedRun(
  store: ProjectStore,
  orgId: string,
  projectId: string
): ProjectRun | null {
  const runs = store.listProjectRuns(orgId, projectId);
  if (!runs) return null;
  for (const run of runs) {
    if (run.status !== 'delivered' && run.status !== 'partial') continue;
    // A COMPARISON RERUN IS NOT PART OF THE LINE: it is a measurement taken
    // beside the project, and seeding from it would turn an experiment into
    // the project's state. The retention hold and the retrieval source follow
    // this function, so this one filter keeps it out of all three.
    if (run.rerunOf) continue;
    if (run.bytesExpiredAt) throw new ProjectStateConflict('The previous workspace has expired; restore it before continuing this project');
    try {
      if (lstatSync(run.hostPaths.workspacePath).isDirectory()) {
        return run;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * ONE caller: `declared-artifacts.json`. That file is small by contract and its
 * CONTENT is model-chosen, so a size bound plus a whole-document parse is the
 * right shape for it.
 *
 * A run trace is the opposite on both axes — a control-plane-owned path whose
 * SIZE is a function of how much work the run did — and bounding the two the
 * same way is what recorded delivered run `2857a579` as failed. Traces go
 * through `readTraceTopLevelFields`; see `src/contracts/traceFields.ts`.
 */
function boundedOwnJson(pathname: string): unknown {
  const stat = lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_JSON_BYTES) {
    throw new Error(`control-plane JSON is not a bounded regular file: ${pathname}`);
  }
  return JSON.parse(readFileSync(pathname, 'utf8')) as unknown;
}

/**
 * The members the delivery decision reads. `satisfies` pins them against the
 * shape the recorder writes, so renaming a field in `VizRun` fails to compile
 * here instead of silently reading `undefined` in production.
 */
const TRACE_VALUE_KEYS = ['id', 'endedAt', 'cancelled', 'degraded'] as const satisfies readonly (keyof VizRun)[];
/**
 * `result` and `error` are the two members a MODEL wrote. They are read as
 * shapes — present, and an object — and never materialised, which is what
 * makes the projection under 400 bytes on a trace of any size.
 */
const TRACE_SHAPE_KEYS = ['result', 'error'] as const satisfies readonly (keyof VizRun)[];

function verifiedTrace(
  pathname: string,
  expectedRunId: string,
  opts: { readonly forPublication: boolean } = { forPublication: true }
): void {
  const trace = readTraceTopLevelFields(pathname, {
    values: TRACE_VALUE_KEYS,
    shapes: TRACE_SHAPE_KEYS,
  });
  if (trace.values['id'] !== expectedRunId) {
    throw new Error('run trace id does not match the project run');
  }
  if (typeof trace.values['endedAt'] !== 'string' || trace.shapes['result'] !== 'object') {
    throw new Error('run trace has no completed result');
  }
  // PRESENCE, not truthiness: `error: ''` now refuses where it used to pass.
  // `endRun` assigns `error` only from a real message, so no writer produces
  // the empty string, and the tightening only ever refuses.
  if (trace.shapes['error'] !== undefined || trace.values['cancelled'] === true) {
    throw new Error('failed or cancelled traces are not recordable');
  }
  // DEGRADED IS A PUBLICATION RULE, not an integrity one, and separating the
  // two is what lets a landed run be recorded at all. A run that reached its
  // executor of last resort must not reach a customer's repository — but a
  // LANDED run never publishes anyway, and refusing its trace here would have
  // coerced it back to `failed` through the caller's catch. That is one of the
  // two production shapes a refusal takes (a refusal after a deepening, which
  // sets `viaFallback`), so the feature would have been inert on half its
  // cases while appearing to work.
  if (opts.forPublication && trace.values['degraded'] === true) {
    throw new Error('degraded traces are not publishable');
  }
}

/** First `✖ …` line from a failed runner log, else a bounded outcome label. */
export function runnerFailureDetail(log: string, outcome: string): string {
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('✖ ')) continue;
    const detail = trimmed.slice(2).trim();
    if (!detail) continue;
    // A runner error is not always one line: a schema failure prints zod's
    // pretty-printed issues array, whose FIRST line is `[`. MEASURED
    // 2026-08-23, project run `d771d166`: the stored error column held the
    // single character `[` while the field that failed and why sat on the
    // eleven indented lines below it. Continuation lines are recognised by
    // SHAPE — indented, or a bare closing bracket — so an unrelated flat log
    // line that happens to follow a one-line error is never swallowed.
    const parts = [detail];
    let budget = 2_000 - detail.length;
    for (let j = i + 1; j < lines.length && budget > 0; j++) {
      const raw = lines[j]!;
      const isContinuation =
        /^\s+\S/.test(raw) || /^[\]}],?$/.test(raw.trim());
      if (!isContinuation) break;
      const piece = raw.trim();
      parts.push(piece);
      budget -= piece.length + 1;
    }
    return parts.join(' ').slice(0, 2_000);
  }
  // A LAUNCH that never became a run has no `✖ ` line, because the runner
  // never spoke. `--- spawn failed --- <cause>` is the shape `spawnRun` writes
  // for every one of those: an ENOENT on `npm`, an unwritable workspace, and
  // the run-host refusal on a platform whose reap sequence cannot work
  // (src/run/platform.ts). Without this branch every such failure reached the
  // operator as the generic sentence below while the log held the reason —
  // measured on a win32 host 2026-09-01, where the platform refusal names the
  // way out and the Projects screen showed none of it.
  //
  // Ranked BELOW the runner's own verdict on purpose, and it is the same
  // reasoning parseRunLog applies to outcomes: a run takes one path, so if the
  // runner reported a failure it is the cause, and a launcher marker then
  // belongs to an earlier attempt or to echoed prose. A tenant goal is echoed
  // verbatim into this log and can therefore forge this line exactly as it can
  // already forge `✖ ` — which changes a detail string, never an outcome, and
  // is the accepted trade recorded in src/cli/AGENTS.md.
  for (const line of lines) {
    const spawned = /^-{3} spawn failed -{3}\s+(\S.*)$/.exec(line.trim());
    const cause = spawned?.[1]?.trim();
    if (cause) return cause.slice(0, 2_000);
  }
  return `runner finished with outcome ${outcome}`.slice(0, 2_000);
}

/**
 * What a landed run says about itself, for the row the customer reads.
 *
 * The OUTCOME comes from the JSON epilogue and is not in question here; this
 * only recovers the prose the runner printed alongside it — the phases that
 * never ran. Same trade as `runnerFailureDetail` above and for the same
 * reason: a tenant goal is echoed into this log and can therefore forge these
 * lines, which changes a detail string and never a status.
 */
export function landedRunDetail(stats: Pick<RunStats, 'landingReasons'>, log: string): string {
  // THE TYPED REASONS, not a regex over the log — and that is a security
  // property, not tidiness. The runner echoes the tenant's own goal verbatim
  // into this log (`task: …`), `landedRunDetail` used to take the FIRST
  // matching line, and the genuine banner is printed ~170 lines later. So a
  // goal containing a newline and a forged `refused at delivery: …` line put
  // the tenant's own text where the customer reads why their run did not
  // deliver — and this string was about to become an input to the NEXT run's
  // planner. `result.output` is echoed the same way, which made it reachable
  // from anything `fetch_url` pulled off the web.
  //
  // The epilogue cannot be forged the same way: `parseRunStatsEpilogue` takes
  // the LAST valid object and the runner writes it after the goal is echoed.
  const reasons = stats.landingReasons ?? [];
  if (reasons.length > 0) {
    return `run landed and was not delivered; ${reasons.join('; ')}`.slice(0, 2_000);
  }
  // An epilogue that carried none (an archived one, or a run killed before it
  // was written) falls back to the banner — a bounded, unstructured line. It
  // is NOT parsed for reasons; it only says that the run landed.
  const banner = log.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('◐ '));
  return (banner ? banner.slice(2).trim() : 'run landed before delivering').slice(0, 2_000);
}

/**
 * THE OPERATOR'S BUDGET FOR ONE PROJECT RUN, and the one place it is decided.
 *
 * It used to be unreachable. The coordinator hard-coded 15 minutes, neither
 * construction site passed `timeoutMs`, `projects run` had no flag, and
 * `spawnRun` writes `ATOMA_BUILD_TIMEOUT_MS` AFTER spreading the caller's env —
 * so an operator's exported value was silently overwritten by the default. Run
 * `949ecd5d` died at 900s after 68 tool calls and $0.96, and its own post-mortem
 * advised raising a variable that could not be raised.
 *
 * The default is 60 minutes. It was 30, and two production runs of 2026-09-21
 * (`cc894dad`, `d3098d25`, docs/incidents/progressive-runs-2026-09-21.md) both
 * died at exactly that wall clock having spent $2.83 and $3.50. Raising it is
 * the smaller half of the answer and not the interesting one: a bigger budget
 * only moves the cliff. What stops the loss is that reaching the deadline now
 * LANDS on the phases already accepted (`MIN_PHASE_LANDING_MS` in
 * src/atoms/dispatch.ts) and records the run `partial` instead of discarding
 * them. Explicit operator budgets still take precedence.
 *
 * Since the platform-settings catalog a platform admin may also re-state this
 * default and NARROW the maximum (`run.timeoutDefaultMs`, `run.timeoutMaxMs`).
 *
 * Bounded on both ends because the child derives two later deadlines from it:
 * the runner's watchdog fires at budget + its grace (60s by default,
 * `run.watchdogGraceMs`) and the harness hard-reaps at budget + 180s, so an
 * absurd value moves those too. That is why an admin's ceiling may only
 * narrow `MAX_PROJECT_RUN_TIMEOUT_MS`, never raise it.
 */
export const DEFAULT_PROJECT_RUN_TIMEOUT_MS = 60 * 60 * 1_000;
export const MIN_PROJECT_RUN_TIMEOUT_MS = 60 * 1_000;
export const MAX_PROJECT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const PROJECT_RUN_TIMEOUT_ENV = 'ATOMA_PROJECT_TIMEOUT_MS';

/**
 * The preparation's OWN bound, and the reason the run budget no longer pays
 * for it.
 *
 * Importing a GitHub repository and building the run's retrieval corpus both
 * happen before the child is spawned, and both used to be billed to the
 * tenant's wall clock: `deadlineAt` was stamped above this work and the child
 * received the REMAINDER. Measured on the 2026-09-21 production runs, whose
 * post-mortem reads `run aborted after 1787s budget` against a 1800s setting —
 * the missing 13s are this preparation. Small in that instance, arbitrary in
 * general, and paid by the wrong party in every instance.
 *
 * It gets a ceiling rather than no bound at all: moving it off the run budget
 * must not make it unbounded, or a wedged import becomes a run that never
 * starts and never stops. Ten minutes is far above anything observed and well
 * under the point where a caller would rather have been refused.
 */
export const PROJECT_RUN_PREPARATION_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Resolve the budget: an explicit argument wins over the host environment,
 * which wins over the platform default (`run.timeoutDefaultMs`,
 * `DEFAULT_PROJECT_RUN_TIMEOUT_MS` when no admin has stated one). A malformed
 * or out-of-range value is a REFUSAL, never a silent fallback — a run that
 * quietly gets the default when the operator asked for 40 is the defect this
 * replaces, wearing a different hat, and that is exactly why the platform
 * CEILING refuses rather than clamps: the same argument applies to an admin's
 * limit as to a constant.
 *
 * The ceiling can only NARROW `MAX_PROJECT_RUN_TIMEOUT_MS` — see the body.
 *
 * Deliberately NOT named `ATOMA_BUILD_TIMEOUT_MS`: that variable belongs to the
 * child, is written by `spawnRun` from this value, and two names for one number
 * on either side of a process boundary is how the first version got confusing.
 */
export function projectRunTimeoutMs(
  hostEnv: NodeJS.ProcessEnv = process.env,
  explicitMs?: number,
  limits: PlatformLimits = DEFAULT_PLATFORM_LIMITS
): number {
  // A PLATFORM ADMIN MAY ONLY NARROW THIS. `MAX_PROJECT_RUN_TIMEOUT_MS` is
  // what the child's watchdog and the burn-in reaper were sized against, so
  // `Math.min` and not the setting alone: raising the ceiling past the
  // constant would move two deadlines this module does not own.
  const ceilingMs = Math.min(MAX_PROJECT_RUN_TIMEOUT_MS, limits['run.timeoutMaxMs']);
  // The admin's DEFAULT, still bounded by the ceiling — a default above the
  // ceiling is a contradiction, and refusing it here would fail every run on
  // an instance whose two settings disagree, which is a worse answer than
  // honouring the tighter of the two.
  const defaultMs = Math.min(limits['run.timeoutDefaultMs'], ceilingMs);
  const raw = explicitMs ?? hostEnv[PROJECT_RUN_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return defaultMs;
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new ProjectRunConfigurationError(
      `invalid project run timeout "${String(raw)}" (expected an integer in milliseconds)`
    );
  }
  if (parsed < MIN_PROJECT_RUN_TIMEOUT_MS || parsed > ceilingMs) {
    throw new ProjectRunConfigurationError(
      `project run timeout ${parsed}ms is outside ${MIN_PROJECT_RUN_TIMEOUT_MS}..${ceilingMs}ms`
    );
  }
  return parsed;
}

/** Default host root: `~/.atoma/orgs/<orgId>/projects/<projectId>/runs/<runId>`. */
export const DEFAULT_PROJECTS_ROOT = path.join(homedir(), '.atoma');

/**
 * One run, one directory. The runner's `ATOMA_RUNS_DIR` is the `traces/`
 * child so `{runId}.json` never lands in a shared instance corpus.
 */
export function projectRunHostLayout(
  root: string,
  orgId: string,
  projectId: string,
  runId: string,
  workspaceRoot?: string
) {
  const projectRoot = path.join(path.resolve(root), 'orgs', orgId, 'projects', projectId);
  const runRoot = path.join(projectRoot, 'runs', runId);
  return {
    projectRoot,
    runRoot,
    workspacePath: workspaceRoot ? path.join(path.resolve(workspaceRoot), projectWorkspaceRelative({ orgId, projectId, runId })) : path.join(runRoot, 'workspace'),
    runsPath: path.join(runRoot, 'traces'),
    logPath: path.join(runRoot, 'run.log'),
    skillsPath: path.join(projectRoot, 'skills'),
    artifactManifestPath: path.join(runRoot, 'declared-artifacts.json'),
  };
}

export class ProjectRunCoordinator {
  private readonly principalCodexModelsFor?: (principalId: string) => Promise<CodexModelInventory>;
  private readonly store: ProjectStore;
  private readonly dbPath: string;
  private readonly checkpoints: RunCheckpointStore;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly root: string;
  private readonly skillsRoot: string;
  private readonly driver: ProjectRunDriver;
  private readonly acquireLease: RunLeaseAcquirer;
  private readonly yieldBackground?: () => Promise<boolean>;
  private readonly publisher?: ProjectRunPublisher;
  private readonly onRunFinished?: (event: ProjectRunFinishedEvent) => void | Promise<void>;
  private readonly tierModelsFor?: (principalId: string) => TierModelPins;
  private readonly orgTierModelsFor?: (orgId: string) => TierModelPins;
  private readonly orgProviderKeyFor?: (
    orgId: string,
    provider: ProviderKeyProvider
  ) => string | null;
  private readonly platformAdmins?: (principalId: string) => boolean;
  private readonly subscriptionDelegates?: (principalId: string, orgId: string) => boolean;
  private readonly principalCodexProfileFor?: (
    principalId: string
  ) => PrincipalCodexProfile | null;
  private readonly onSubscriptionTransport?: (info: SubscriptionTransportUse) => void;
  private readonly describeDeliveredPreview?: (input: DeliveredPreviewSubject) => void;
  private readonly runTitler?: RunTitler;
  /** Naming calls still in flight; they hold `waitForIdle`, never the run slot. */
  private readonly titling = new Set<Promise<void>>();
  private readonly cwd: string;
  private readonly explicitTimeoutMs?: number;
  private readonly platformLimits: () => PlatformLimits;
  private readonly queuedRunAllowed?: ProjectCoordinatorOptions['queuedRunAllowed'];
  private queueTimer?: NodeJS.Timeout;
  private queuePumping = false;
  private queueStopped = false;
  private readonly active = new Map<string, ActiveRun>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: ProjectCoordinatorOptions) {
    this.store = options.store;
    this.queuedRunAllowed = options.queuedRunAllowed;
    this.dbPath = path.resolve(options.dbPath);
    this.checkpoints = new RunCheckpointStore(this.dbPath);
    this.hostEnv = { ...(options.hostEnv ?? process.env) };
    this.root = path.resolve(options.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
    this.skillsRoot = path.resolve(skillsDirPath(options.skillsDir, this.hostEnv));
    migratePlatformSkills({ dbPath: this.dbPath, projectsRoot: this.root, skillsRoot: this.skillsRoot });
    reconcilePlatformSkills({ db: this.dbPath, skillsRoot: this.skillsRoot });
    this.driver = options.driver ?? spawnRun;
    this.acquireLease = options.acquireLease ?? ((id, scope) => acquireRunLease(id, undefined, scope));
    this.yieldBackground = options.yieldBackground;
    this.publisher = options.publisher;
    if (options.onRunFinished) this.onRunFinished = options.onRunFinished;
    if (options.tierModelsFor) this.tierModelsFor = options.tierModelsFor;
    if (options.principalCodexModelsFor) this.principalCodexModelsFor = options.principalCodexModelsFor;
    if (options.orgTierModelsFor) this.orgTierModelsFor = options.orgTierModelsFor;
    if (options.orgProviderKeyFor) this.orgProviderKeyFor = options.orgProviderKeyFor;
    if (options.platformAdmins) this.platformAdmins = options.platformAdmins;
    if (options.subscriptionDelegates) this.subscriptionDelegates = options.subscriptionDelegates;
    if (options.principalCodexProfileFor) {
      this.principalCodexProfileFor = options.principalCodexProfileFor;
    }
    if (options.onSubscriptionTransport) {
      this.onSubscriptionTransport = options.onSubscriptionTransport;
    }
    if (options.describeDeliveredPreview) {
      this.describeDeliveredPreview = options.describeDeliveredPreview;
    }
    if (options.runTitler) this.runTitler = options.runTitler;
    this.cwd = options.cwd ?? repoRoot();
    if (options.timeoutMs !== undefined) this.explicitTimeoutMs = options.timeoutMs;
    this.platformLimits = options.platformLimits ?? (() => platformLimitsFor(this.dbPath));
    // RESOLVED TWICE ON PURPOSE. Once here, against the SHIPPED limits, so a
    // malformed `ATOMA_PROJECT_TIMEOUT_MS` or an out-of-range flag fails at
    // CONSTRUCTION — a server that boots and then refuses every run is a
    // worse answer than one that refuses to boot. NOT against the admin's
    // limits: a ceiling saved below the exported variable would then keep the
    // server from booting at all, and every push deploys (2026-09-30 review).
    // Again per run, in `start` before anything is reserved, where the
    // admin's limits refuse that run alone and a change reaches the next
    // launch without a restart. The value is deliberately NOT cached.
    projectRunTimeoutMs(this.hostEnv, this.explicitTimeoutMs);
  }

  /**
   * The budget for the NEXT run: the explicit argument, else the host
   * environment, else the platform default — all bounded by the platform
   * ceiling. See `projectRunTimeoutMs` for the precedence and the refusals.
   */
  private runTimeoutMs(): number {
    return projectRunTimeoutMs(this.hostEnv, this.explicitTimeoutMs, this.platformLimits());
  }

  /** Pure configuration resolution shared by launch and the read-only readiness surface. */
  private configuredEnvironment(input: {
    orgId: string; principalId: string; runId: string; workspacePath: string; runsPath: string;
    skillsPath: string; artifactManifestPath: string; runModels?: RunTierModels;
  }) {
    const principalCodexProfile = this.resolvePrincipalCodexProfile(input.principalId);
    const built = projectRunEnvironment({ ...input, hostEnv: this.hostEnv, dbPath: this.dbPath,
      tierModels: this.resolveTierModels(input.principalId), orgTierModels: this.resolveOrgTierModels(input.orgId),
      orgProviderKeys: this.resolveOrgProviderKeys(input.orgId),
      subscriptionTransport: this.resolveSubscriptionGrant(input.principalId, input.orgId), principalCodexProfile });
    assertServedHostChatGptModels(Object.values(built.payers).map(row => row.selection));
    return { built, principalCodexProfile };
  }

  /** No lease, row, directory, provider request or model discovery is created here. */
  configurationReadiness(orgId: string, principalId: string, projectId: string) {
    const timeoutMs = this.runTimeoutMs();
    readHaystackLaunch(this.hostEnv);
    if (this.hostEnv['ATOMA_LAUNCHER_SOCKET'] && !this.hostEnv['ATOMA_LAUNCHER_WORKSPACE_ROOT']) {
      throw new ProjectRunConfigurationError('Launcher workspace root is required for project runs');
    }
    const layout = projectRunHostLayout(this.root, orgId, projectId, 'readiness');
    const { built } = this.configuredEnvironment({ orgId, principalId, runId: 'readiness',
      workspacePath: layout.workspacePath, runsPath: layout.runsPath, skillsPath: this.skillsRoot,
      artifactManifestPath: layout.artifactManifestPath });
    return { models: built.payers, timeoutMs };
  }

  /**
   * Boot-time crash recovery: fail every run/publication a dead process left
   * in flight (see `ProjectStore.reconcileInterrupted`). Refuses to run while
   * anything is active in-memory — those rows have live drivers.
   */
  reconcileInterrupted(): { runs: number; publications: number } {
    if (this.active.size > 0) {
      throw new Error('reconcileInterrupted is a boot-time operation; runs are active');
    }
    const recovered = this.store.reconcileInterrupted('interrupted by server restart');
    this.resumeQueuedRuns();
    return recovered;
  }

  /**
   * The requesting account's tier pins, or none. Fail-open by design: a
   * preferences lookup that throws leaves the operator's host pins in force
   * instead of failing the run the viewer just asked for.
   */
  private resolveTierModels(principalId: string): TierModelPins | undefined {
    if (!this.tierModelsFor) return undefined;
    try {
      return this.tierModelsFor(principalId);
    } catch (error) {
      process.stderr.write(
        `[atoma projects] tier model preferences unavailable for ${principalId}: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * The requester's organisation tier defaults, or none. Same fail-open
   * rule as `resolveTierModels` — it is a preference level, not an
   * authority.
   */
  private resolveOrgTierModels(orgId: string): TierModelPins | undefined {
    if (!this.orgTierModelsFor) return undefined;
    try {
      return this.orgTierModelsFor(orgId);
    } catch (error) {
      process.stderr.write(
        `[atoma projects] organisation tier defaults unavailable for ${orgId}: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * The org's configured provider credentials, decrypted per run. A key
   * that cannot be read degrades to absent (the run continues without the
   * provider), and one failing provider never hides another.
   */
  private resolveOrgProviderKeys(
    orgId: string
  ): Partial<Record<ProviderKeyProvider, string>> | undefined {
    if (!this.orgProviderKeyFor) return undefined;
    const keys: Partial<Record<ProviderKeyProvider, string>> = {};
    for (const provider of LLM_PROVIDER_CATALOG) {
      try {
        const value = this.orgProviderKeyFor(orgId, provider.id);
        if (value) keys[provider.id] = value;
      } catch (error) {
        process.stderr.write(
          `[atoma projects] provider key lookup failed for ${provider.id} in ${orgId}: ${String(error)}\n`
        );
      }
    }
    return keys;
  }

  /**
   * The subscription-transport grant for this requester, or none.
   *
   * FAIL-CLOSED, and deliberately the opposite of `resolveTierModels`: a
   * preferences lookup that throws must not block a run, but an authority
   * lookup that throws must never be read as permission to spend. No
   * resolver wired (a deployment without accounts) is also NO — the
   * ungated developer path uses the CLI runner directly and never comes
   * through here.
   */
  private resolveSubscriptionGrant(
    principalId: string,
    orgId: string
  ): { principalId: string } | undefined {
    // TWO WAYS IN, ONE DOOR. The flag answers for the operator themself; the
    // delegation answers for one member of the declared organisation. Both
    // are asked here, per run, and BOTH fail closed — an absent resolver, a
    // `false`, or a throw all mean no. Order matters only for cost: the flag
    // is the cheaper lookup and the common case on a single-operator host.
    if (this.platformAdmins) {
      try {
        if (this.platformAdmins(principalId)) return { principalId };
      } catch (error) {
        process.stderr.write(
          `[atoma projects] platform-admin lookup failed for ${principalId}; refusing the subscription transport: ${String(error)}\n`
        );
        return undefined;
      }
    }
    if (!this.subscriptionDelegates) return undefined;
    try {
      return this.subscriptionDelegates(principalId, orgId) ? { principalId } : undefined;
    } catch (error) {
      process.stderr.write(
        `[atoma projects] subscription-delegate lookup failed for ${principalId} in ${orgId}; refusing the subscription transport: ${String(error)}\n`
      );
      return undefined;
    }
  }

  /**
   * Resolve the exact personal credential generation at launch. Authority
   * lookups fail closed: only a selected personal sentinel observes absence,
   * and that absence becomes an explicit configuration error in the builder.
   */
  private resolvePrincipalCodexProfile(
    principalId: string
  ): PrincipalCodexProfile | undefined {
    if (!this.principalCodexProfileFor) return undefined;
    try {
      return this.principalCodexProfileFor(principalId) ?? undefined;
    } catch {
      process.stderr.write(
        `[atoma projects] personal Codex profile lookup failed for ${principalId}; refusing personal subscription pins\n`
      );
      return undefined;
    }
  }

  /**
   * The run slot, preempting this host's post-run analysis when that is what
   * holds it: the analysis is aborted (its run keeps its attempt), the lease
   * released, and the acquisition tried ONCE more. Any other holder — another
   * run, the mender, a deployment — refuses as before.
   */
  private async acquireLeasePreempting(runId: string, orgId?: string): Promise<RunLease> {
    try {
      return await this.acquireLease(runId, orgId ? { orgId, maxConcurrent: () => this.platformLimits()['run.concurrentMax'] } : undefined);
    } catch (error) {
      if (!(error instanceof RunLockBusyError) || error.condition !== 'held' ||
        !error.owner?.runId.startsWith('analyst:') || !this.yieldBackground) throw error;
      let timer: NodeJS.Timeout | undefined;
      const yielded = await Promise.race([
        this.yieldBackground().catch(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PREEMPT_ANALYST_WAIT_MS); timer.unref(); }),
      ]).finally(() => clearTimeout(timer));
      if (!yielded) throw error;
      process.stderr.write(`[atoma projects] preempted the post-run analysis ${error.owner.runId} for ${runId}\n`);
      return this.acquireLease(runId, orgId ? { orgId, maxConcurrent: () => this.platformLimits()['run.concurrentMax'] } : undefined);
    }
  }

  /** Preparation and the child's hard backstop belong to the task's lifetime too. */
  runTaskBudgetMs(): number {
    // A reader (the MCP task TTL), so it never throws: a budget the current
    // limits refuse is refused at `start`, and the TTL still needs a number.
    let runMs: number;
    try {
      runMs = this.runTimeoutMs();
    } catch {
      runMs = MAX_PROJECT_RUN_TIMEOUT_MS;
    }
    return PROJECT_RUN_PREPARATION_TIMEOUT_MS + runMs + DEFAULT_HARD_KILL_MARGIN_MS + UNKILLABLE_BACKSTOP_EXTRA_MS;
  }

  checkpointStatus(run: ProjectRun) {
    const status = this.checkpoints.projectStatus(run.projectRunId, run.orgId);
    if (!status) return undefined;
    // A boundary is only offered after the project finalizer released its lease.
    if (['recoverable', 'blocked'].includes(status.state) && !['failed', 'partial'].includes(run.status)) return { ...status, state: 'unavailable' as const };
    if (status.state === 'paused' && run.status !== 'partial') return { ...status, state: 'unavailable' as const };
    if (['running', 'pause_requested'].includes(status.state) && run.status !== 'running') return { ...status, state: 'unavailable' as const };
    return status;
  }

  continuationRequestKey(run: ProjectRun): string {
    const previous = this.store.latestContinuation(run.orgId, run.projectRunId);
    return previous && !['failed', 'cancelled'].includes(previous.status) ? previous.requestKey
      : `phase-resume:${run.projectRunId}${previous ? `:${previous.projectRunId}` : ''}`;
  }

  pause(run: ProjectRun): void {
    if (run.status !== 'running') throw new ProjectStateConflict('Only a running run can pause');
    try { this.checkpoints.requestPause(run.projectRunId, run.orgId); }
    catch (error) { throw new ProjectStateConflict((error as Error).message); }
  }

  private continuation(orgId: string, projectId: string, principalId: string, sourceId: string): ProjectRun {
    const source = this.store.getProjectRun(orgId, sourceId);
    if (!source || source.projectId !== projectId) throw new ProjectStateConflict('Continuation source not found');
    if (source.requestedByPrincipalId !== principalId || !['partial', 'failed'].includes(source.status) || source.bytesExpiredAt || source.rerunOf) {
      throw new ProjectStateConflict('This run cannot be continued by this requester');
    }
    try {
      const saved = this.checkpoints.read(sourceId);
      if (saved.scope?.orgId !== orgId || saved.scope.projectId !== projectId || saved.scope.principalId !== principalId ||
          saved.scope.runId !== sourceId || saved.workspace !== canonicalCheckpointWorkspacePath(source.hostPaths.workspacePath)) throw new Error('Checkpoint scope mismatch');
      if (saved.remainingMs <= 0) throw new Error('The saved execution budget is exhausted');
    } catch { throw new ProjectStateConflict('Saved continuation is unavailable: its workspace, ownership or remaining budget could not be verified'); }
    return source;
  }

  async start(input: {
    readonly orgId: string;
    readonly principalId: string;
    readonly projectId: string;
    readonly request: StartProjectRunInput;
  }): Promise<ProjectRun> {
    return (await this.startOutcome(input)).run;
  }

  private selectedIterationBase(orgId: string, projectId: string, runId: string): ProjectRun {
    const base = this.store.iterationBase(orgId, projectId, runId);
    if (this.store.getProject(orgId, projectId)?.repositoryTarget.source && !base.repositoryBase) {
      throw new ProjectStateConflict('The selected version has no recorded repository base');
    }
    try {
      if (!lstatSync(base.hostPaths.workspacePath).isDirectory()) throw new Error('missing workspace');
      revalidateArtifactManifest({ workspaceRoot: base.hostPaths.workspacePath,
        manifest: base.artifactManifest!, expectedHash: base.artifactManifestHash! });
    } catch { throw new ProjectStateConflict('The selected version files are unavailable or changed; choose a retained intact version'); }
    return base;
  }

  /**
   * `start`, saying whether THIS call created the run. An exact retry (same
   * key) and a re-sent identical request while its run is live both return
   * the existing run with `created: false`: what journals "run started" must
   * not write it twice for one run.
   */
  async startOutcome(input: {
    readonly orgId: string;
    readonly principalId: string;
    readonly projectId: string;
    readonly request: StartProjectRunInput;
  }): Promise<{ readonly run: ProjectRun; readonly created: boolean }> {
    const findRetry = () => this.store.findProjectRunForRequest(
      input.orgId, input.projectId, input.principalId, input.request
    ) ?? this.store.findLiveRunForSameRequest(input.orgId, input.projectId, input.principalId, input.request);
    const existing = findRetry();
    if (existing) return { run: existing, created: false };
    try {
      this.store.assertRunCapacity(input.orgId);
    } catch (error) {
      throw this.namingOwnRun(error, input.orgId, input.principalId);
    }
    // The platform limits in force NOW, before the run is reserved: a budget
    // they refuse is this run's 400, never a row left to fail at launch.
    const timeoutMs = this.runTimeoutMs();
    // Every new project run carries search. Validate before taking the lease or
    // reserving a run; read-only service startup and idempotent retries still work.
    try { readHaystackLaunch(this.hostEnv); }
    catch (error) {
      throw new ProjectRunConfigurationError((error as Error).message);
    }
    if (this.hostEnv['ATOMA_LAUNCHER_SOCKET'] && !this.hostEnv['ATOMA_LAUNCHER_WORKSPACE_ROOT']) throw new ProjectRunConfigurationError('Launcher workspace root is required for project runs');
    // A comparison rerun resolves WHAT IT COPIES before it reserves anything,
    // so an origin that cannot be rerun is refused without a row or a lease.
    let rerun: RerunOrigin | null = null;
    if ('rerunOf' in input.request) {
      const project = this.store.getProject(input.orgId, input.projectId);
      if (!project) throw new Error('project not found');
      const retrieval = ProjectRetrievalLaunchStore.open(this.dbPath);
      rerun = resolveRerunOrigin({
        store: this.store,
        project,
        orgId: input.orgId,
        rerunOf: input.request.rerunOf,
        recordedSourceRunId: (runId) => retrieval.recordedSourceRunId(runId),
      });
    }
    if ('resumeOf' in input.request && input.request.resumeOf) {
      const source = this.continuation(input.orgId, input.projectId, input.principalId, input.request.resumeOf);
      const acceptance = this.store.getRunAcceptanceSpec(source.orgId, source.projectRunId);
      const expected = acceptance?.items.map(({ behaviour, check }) => ({ behaviour, check }));
      if (source.goal !== input.request.goal || (source.depth ?? 'deep') !== (input.request.depth ?? 'deep') ||
          JSON.stringify(input.request.acceptanceChecklist) !== JSON.stringify(expected)) {
        throw new ProjectStateConflict('A continuation must keep its original goal and acceptance criteria');
      }
    }
    if ('baseRunId' in input.request && input.request.baseRunId) {
      this.selectedIterationBase(input.orgId, input.projectId, input.request.baseRunId);
    }
    const candidateRunId = randomUUID();
    const candidatePaths = projectRunHostLayout(
      this.root,
      input.orgId,
      input.projectId,
      candidateRunId,
      this.hostEnv['ATOMA_LAUNCHER_SOCKET'] ? this.hostEnv['ATOMA_LAUNCHER_WORKSPACE_ROOT'] : undefined
    );
    let lease: RunLease | undefined;
    try {
      if (this.store.listQueuedRuns().length === 0) lease = await this.acquireLeasePreempting(`project:${candidateRunId}`, input.orgId);
    } catch (error) {
      if (error instanceof RunLockBusyError) {
        // A concurrent identical request may have reserved its row while
        // this caller waited for the lease. It is a read, not a second run.
        const retry = findRetry();
        if (retry) return { run: retry, created: false };
        if (error.condition !== 'capacity') {
          process.stderr.write(`[atoma projects] run refused, slot busy: ${error.message}\n`);
          const own = this.store.liveRunOf(input.orgId, input.principalId);
          throw new ProjectRunBusy(own && error.owner?.runId === `project:${own.projectRunId}`
            ? ownLiveRunMessage(own)
            : tenantBusyMessage(error.owner, error.condition));
        }
      } else throw error;
    }
    let reservation: { readonly run: ProjectRun; readonly created: boolean } | null;
    try {
      reservation = this.store.createProjectRun({
        orgId: input.orgId,
        projectId: input.projectId,
        principalId: input.principalId,
        request: input.request,
        ...(rerun ? { origin: { goal: rerun.origin.goal, acceptance: rerun.acceptance,
          ...(rerun.origin.depth ? { depth: rerun.origin.depth } : {}) } } : {}),
        projectRunId: candidateRunId,
        enforceCapacity: true,
        ...(this.explicitTimeoutMs !== undefined ? { requestedTimeoutMs: this.explicitTimeoutMs } : {}),
        hostPaths: {
          workspacePath: candidatePaths.workspacePath,
          runsPath: candidatePaths.runsPath,
          logPath: candidatePaths.logPath,
          skillsPath: this.skillsRoot,
        },
      });
    } catch (error) {
      lease?.release();
      throw this.namingOwnRun(error, input.orgId, input.principalId);
    }
    if (!reservation) {
      lease?.release();
      throw new Error('project not found');
    }
    const run = reservation.run;
    if (
      run.projectRunId !== candidateRunId ||
      run.status !== 'queued' ||
      this.active.has(run.projectRunId)
    ) {
      lease?.release();
      return { run, created: false };
    }
    if (!lease) {
      this.resumeQueuedRuns();
      return { run, created: true };
    }
    try { return await this.launchReservedRun(run, lease, rerun, timeoutMs); }
    catch (error) {
      lease.release();
      if (this.store.getProjectRun(run.orgId, run.projectRunId)?.status === 'queued') {
        this.store.transitionProjectRun({ orgId: run.orgId, projectRunId: run.projectRunId,
          from: 'queued', to: 'failed', error: String(error).slice(0, 1500) });
      }
      throw error;
    }
  }

  private async launchReservedRun(run: ProjectRun, lease: RunLease, rerun: RerunOrigin | null, admittedTimeoutMs?: number): Promise<{ run: ProjectRun; created: boolean }> {
    const input = { orgId: run.orgId, projectId: run.projectId, principalId: run.requestedByPrincipalId };
    let timeoutMs: number;
    let retrievalLaunch: ReturnType<typeof readHaystackLaunch>;
    try {
      timeoutMs = admittedTimeoutMs ?? projectRunTimeoutMs(this.hostEnv, run.requestedTimeoutMs, this.platformLimits());
      retrievalLaunch = readHaystackLaunch(this.hostEnv);
    } catch (error) { lease.release(); throw error; }
    const project = this.store.getProject(input.orgId, input.projectId);
    if (!project) {
      lease.release();
      throw new Error('project not found');
    }
    const layout = projectRunHostLayout(
      this.root,
      input.orgId,
      input.projectId,
      run.projectRunId
    );
    const paths = {
      ...run.hostPaths,
      skillsPath: run.hostPaths.skillsPath ?? layout.skillsPath,
      artifactManifestPath: layout.artifactManifestPath,
    };
    let environment: NodeJS.ProcessEnv;
    try {
      const { built, principalCodexProfile } = this.configuredEnvironment({
        principalId: input.principalId,
        workspacePath: paths.workspacePath,
        runsPath: paths.runsPath,
        skillsPath: paths.skillsPath,
        runId: run.projectRunId,
        artifactManifestPath: paths.artifactManifestPath,
        orgId: input.orgId,
        // Read back from the RESERVED ROW, like the acceptance list below: the
        // row is what the rerun was admitted as.
        ...(run.modelOverrides ? { runModels: run.modelOverrides } : {}),
      });
      environment = built.environment;
      // Before anything spends: a pin to a slug the host subscription stopped
      // serving failed a minute in, its planner already paid (2026-09-28).
      if (principalSubscriptionTiers(built.payers).length > 0) {
        if (!this.principalCodexModelsFor) {
          throw new ProjectRunConfigurationError('ChatGPT model discovery is unavailable. Refresh your models in Settings.');
        }
        const inventory = await this.principalCodexModelsFor(input.principalId);
        assertPersonalCodexModels(Object.values(built.payers).map((row) => row.selection), inventory);
        if (this.resolvePrincipalCodexProfile(input.principalId)?.profileId !== principalCodexProfile?.profileId) {
          throw new ProjectRunConfigurationError('Your ChatGPT connection changed. Start the run again.');
        }
        environment[CODEX_MODEL_CAPABILITIES_ENV] = JSON.stringify(inventory.models);
      }
      // FIRED FROM THE LEDGER, not from the host env. A run may now spend the
      // subscription on some tiers and a key on others, so "did this run touch
      // a CLI login" is a question about what was RESOLVED — the old
      // whole-deployment `ATOMA_LLM` test could only see the
      // whole-deployment regime and would stay silent on every mixed run.
      if (ledgerTouchesAnySubscription(built.payers)) {
        this.onSubscriptionTransport?.({
          orgId: input.orgId,
          projectId: input.projectId,
          projectRunId: run.projectRunId,
          principalId: input.principalId,
          transport: subscriptionTransports(built.payers).join(','),
          payers: built.payers,
        });
      }
      // The run starts and its payer ledger lands in one transaction. A run
      // observed as `running` therefore always says who pays for it, whatever
      // funded it — the subscription hook above journals only the runs that
      // touch a CLI login, and an organisation- or host-key run used to leave
      // no durable payer record at all.
      if (this.store.getProjectRun(run.orgId, run.projectRunId)?.status !== 'queued') {
        lease.release();
        return { run: this.store.getProjectRun(run.orgId, run.projectRunId)!, created: false };
      }
      this.store.startProjectRun({
        orgId: input.orgId,
        projectRunId: run.projectRunId,
        payers: built.payers,
      });
    } catch (error) {
      try {
        this.store.transitionProjectRun({
          orgId: input.orgId,
          projectRunId: run.projectRunId,
          from: 'queued',
          to: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        });
      } catch (transitionError) {
        process.stderr.write(
          `[atoma projects] failed to persist configuration error for ${run.projectRunId}: ${String(transitionError)}\n`
        );
      }
      lease.release();
      throw error;
    }
    const controller = new AbortController();
    this.active.set(run.projectRunId, {
      orgId: input.orgId,
      principalId: input.principalId,
      controller,
    });

    let driven: Promise<string>;
    try {
      // Continuations, explicit versions and comparisons keep their own base;
      // an ordinary request without a selection follows automatic seeding.
      const continuation = run.resumeOf ? this.continuation(run.orgId, run.projectId, run.requestedByPrincipalId, run.resumeOf) : null;
      const selectedBase = run.baseRunId ? this.selectedIterationBase(run.orgId, run.projectId, run.baseRunId) : null;
      const seedRun = continuation ?? selectedBase ?? (rerun ? rerun.seedRun : previousSeedRun(this.store, input.orgId, input.projectId));
      let seedFrom = seedRun?.hostPaths.workspacePath;
      // The tenant's wall clock starts when the CHILD does, not here: the
      // repository import and corpus preparation below have their own bound
      // (`PROJECT_RUN_PREPARATION_TIMEOUT_MS`) and are no longer billed to the
      // run budget. See that constant for the measurement.
      const preparationDeadlineAt = Date.now() + PROJECT_RUN_PREPARATION_TIMEOUT_MS;
      const launch = () => this.driver({
        goal: run.goal,
        timeoutMs,
        logPath: paths.logPath,
        cwd: this.cwd,
        npmScript: 'run:build',
        signal: controller.signal,
        cleanWorkspace: !continuation,
        extraArgs: [
          // Container isolation is the one thing a tenant launch insists on.
          // No lifecycle veto travels: a project run promotes, dispatches and
          // caches like any run (docs/platform-trust-2026-09-15.md).
          '--container',
          ...(continuation ? ['--resume', continuation.projectRunId] : seedFrom ? ['--seed', seedFrom] : []),
          ...(!run.rerunOf && (run.depth ?? 'deep') === 'deep' ? ['--checkpoint'] : []),
          ...(run.depth ? ['--depth', run.depth] : []),
        ],
        env: environment,
        onSpawn: (pid) => lease.attachChild(pid),
      });
      driven = (async () => {
        const preparationSignal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(PROJECT_RUN_PREPARATION_TIMEOUT_MS),
        ]);
        if (continuation) {
          if (continuation.repositoryBase) this.store.saveRepositoryRunBase(run.orgId, run.projectRunId, continuation.repositoryBase);
          const originalSync = this.store.getRepositorySync(run.orgId, continuation.projectRunId);
          if (originalSync) this.store.saveRepositorySync(run.orgId, run.projectRunId, originalSync);
        } else if (selectedBase) {
          // An explicit version is exact: do not materialise today's GitHub tree
          // over it. Publication still reconciles against the captured BASE.
          if (selectedBase.repositoryBase) this.store.saveRepositoryRunBase(run.orgId, run.projectRunId, selectedBase.repositoryBase);
          const original = this.store.getRepositorySync(run.orgId, selectedBase.projectRunId);
          const ours = inventoryRepositoryWorkspace(selectedBase.hostPaths.workspacePath);
          const published = this.store.getPublicationForRun(run.orgId, selectedBase.projectRunId)?.status === 'published';
          this.store.saveRepositorySync(run.orgId, run.projectRunId, {
            status: 'unchanged', head: original?.head ?? null,
            base: original?.debtResolved ? carryRepositoryBase(original.base, ours, published) : ours,
            debtResolved: original?.debtResolved ?? false,
            materialised: false, seedPath: null, taken: 0, conflicts: 0, paths: [],
          });
        } else if (project.repositoryTarget.source) {
          if (!this.publisher?.prepareRun) throw new ProjectRunConfigurationError('GitHub repository import is unavailable');
          seedFrom = await this.publisher.prepareRun(project, run, preparationSignal);
        } else if (rerun) {
          const originSync = this.store.getRepositorySync(project.orgId, rerun.origin.projectRunId);
          if (originSync) {
            if (originSync.materialised) {
              if (!originSync.seedPath || !lstatSync(originSync.seedPath).isDirectory()) throw new ProjectStateConflict('The original repository seed has expired');
              seedFrom = originSync.seedPath;
            }
            this.store.saveRepositorySync(project.orgId, run.projectRunId, originSync);
          }
        } else if (this.publisher?.syncRun) {
          seedFrom = await this.publisher.syncRun(project, run, seedRun, preparationSignal);
        } else {
          let base = {};
          let debtResolved = true;
          try {
            if (seedRun) {
              const ours = inventoryRepositoryWorkspace(seedRun.hostPaths.workspacePath);
              const previous = this.store.getRepositorySync(project.orgId, seedRun.projectRunId);
              base = { ...ours };
              if (previous?.debtResolved) {
                base = carryRepositoryBase(previous.base, ours,
                  this.store.getPublicationForRun(project.orgId, seedRun.projectRunId)?.status === 'published');
              } else debtResolved = false;
            }
          } catch { debtResolved = false; }
          this.store.saveRepositorySync(project.orgId, run.projectRunId, { status: 'no_anchor', head: null,
            base, debtResolved, materialised: false, seedPath: null, taken: 0, conflicts: 0, paths: [] });
        }
        // WHERE THIS RUN STARTED, recorded for every run: it is what a later
        // comparison rerun of THIS run copies (src/projects/rerun.ts).
        this.store.recordRunSeed(run.orgId, run.projectRunId,
          continuation ? { kind: 'run', runId: continuation.projectRunId } : selectedBase ? { kind: 'run', runId: selectedBase.projectRunId } : project.repositoryTarget.source ? { kind: 'repository' }
            : seedRun ? { kind: 'run', runId: seedRun.projectRunId } : { kind: 'none' });
        const retrievalStore = ProjectRetrievalLaunchStore.open(this.dbPath);
        // A crashed run has no accepted artifact manifest. Keep the corpus it
        // started with; never promote its interrupted workspace into a receipt.
        const retrievalSource = continuation?.status === 'failed'
          ? retrievalStore.recordedSourceRunId(continuation.projectRunId) : seedRun?.projectRunId ?? null;
        if (retrievalSource === undefined) throw new ProjectStateConflict('The interrupted run has no recorded document corpus');
        await retrievalStore.prepare(run.projectRunId,
          retrievalSource, { signal: preparationSignal, deadlineAt: preparationDeadlineAt });
        if (preparationSignal.aborted || Date.now() >= preparationDeadlineAt) throw new Error('project document preparation cancelled');
        environment[HAYSTACK_LAUNCH_ENV] = JSON.stringify(retrievalLaunch);
        // WHY THE PREVIOUS RUN DID NOT DELIVER, handed to this one.
        //
        // Written HERE and not beside `previousSeedRun`, because a
        // repository-backed project replaces `seedFrom` with a fresh repo-HEAD
        // snapshot just above: the refused workspace never reaches the child,
        // so telling it about that workspace's refusal would describe files it
        // does not have. Gated on the seed actually being the previous run's.
        const landing = (!project.repositoryTarget.source || selectedBase) && seedRun
          ? encodePreviousLanding(seedRun?.stats?.landingReasons)
          : null;
        if (landing) environment[PREVIOUS_LANDING_ENV] = landing;
        // Text is a deliverable too. Comparisons use their origin's seed;
        // imported repository snapshots must not inherit a different workspace's history.
        const previousResults = (!project.repositoryTarget.source || selectedBase) && seedRun
          ? previousResultsFor(this.store, seedRun ?? null) : undefined;
        if (previousResults) environment[PREVIOUS_RESULTS_ENV] = previousResults;
        // What the host recorded of the seed lineage's own HTTP probes, which root
        // acceptance counts while the server code is unchanged (standingHttpEvidence).
        const standing = !continuation && seedFrom === seedRun?.hostPaths.workspacePath && !this.store.getRepositorySync(project.orgId, run.projectRunId)?.taken
          ? standingHttpEvidenceFor(this.store, seedRun ?? null) : undefined;
        if (standing) environment[STANDING_HTTP_EVIDENCE_ENV] = standing;
        // THE USER'S APPROVED CRITERIA, read back from the STORE the
        // reservation wrote them to, never from the request: the child runs
        // against the captured version, and a row that no longer matches its
        // digest fails the run here instead of launching it without them.
        const acceptance = continuation
          ? this.store.getRunAcceptance(continuation.orgId, continuation.projectRunId)
          : this.store.getRunAcceptance(run.orgId, run.projectRunId);
        if (acceptance) {
          environment[ACCEPTANCE_SPEC_ENV] = encodeAcceptanceSpec(acceptance.spec);
          // A rerun of a run that drafted its own list carries that draft, and
          // is judged as a draft is judged — not as a list a person approved.
          if (acceptance.source === 'drafted') environment[ACCEPTANCE_SOURCE_ENV] = 'drafted';
        } else if (run.rerunOf) {
          // `resolveRerunOrigin` refused every origin whose list it could not
          // recover, so a rerun with no row re-runs an origin judged WITHOUT a
          // list: it must not draft one from its own models either.
          environment[ACCEPTANCE_SOURCE_ENV] = 'none';
        }
        return launch();
      })();
    } catch (error) {
      driven = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void this.finish(project, run, paths.artifactManifestPath, driven, lease, controller.signal);
    return { run: this.store.getProjectRun(input.orgId, run.projectRunId)!, created: true };
  }

  /**
   * A capacity refusal whose cause is the caller's OWN live run says so: a
   * model whose start was cut and that sent a different request must learn
   * that its run is going, not that "the limit is reached".
   */
  private namingOwnRun(error: unknown, orgId: string, principalId: string): unknown {
    if (!(error instanceof ProjectStateConflict) || !/concurrent run limit/.test(error.message)) return error;
    const own = this.store.liveRunOf(orgId, principalId);
    return own ? new ProjectStateConflict(`${error.message}: ${ownLiveRunMessage(own)}`) : error;
  }

  private async finish(
    project: Project,
    reservedRun: ProjectRun,
    artifactManifestPath: string,
    driven: Promise<string>,
    lease: RunLease,
    signal: AbortSignal
  ): Promise<void> {
    let stats: RunStats | null = null;
    try {
      const log = await driven;
      stats = parseRunLog(log);
      if (signal.aborted || stats.outcome === 'cancelled') {
        this.store.transitionProjectRun({
          orgId: reservedRun.orgId,
          projectRunId: reservedRun.projectRunId,
          from: 'running',
          to: 'cancelled',
          stats: { ...stats, outcome: 'cancelled' },
        });
        return;
      }
      // A LANDED run takes this whole path. Its trace, its declared manifest
      // and the files in its workspace are as real as a delivery's — the run
      // reached its budget with phases already accepted and reported those
      // (`dispatchWithAggregation`) instead of discarding them, which is the
      // 2026-09-21 defect this exists to close. Only two things differ, both
      // below: the status it completes into, and that publication never sees
      // it. The declared manifest is NOT cross-checked against the workspace
      // here, so a plan that declared artefacts its unrun phases would have
      // produced is not a contradiction; `buildWorkspaceArtifactManifest`
      // reports what is actually on disk.
      const landed = stats.outcome === 'partial';
      if (stats.outcome !== 'delivered' && !landed) {
        throw new Error(runnerFailureDetail(log, stats.outcome));
      }
      const tracePath = path.join(reservedRun.hostPaths.runsPath, `${reservedRun.projectRunId}.json`);
      verifiedTrace(tracePath, reservedRun.projectRunId, { forPublication: !landed });
      const declarations = declaredArtifactManifestSchema.parse(
        boundedOwnJson(artifactManifestPath)
      );
      if (declarations.runId !== reservedRun.projectRunId) {
        throw new Error('declared artifact manifest belongs to another run');
      }
      const built = buildWorkspaceArtifactManifest({
        workspaceRoot: reservedRun.hostPaths.workspacePath,
        ...(declarations.delivery ? { delivery: declarations.delivery } : {}),
        allowEmpty: landed,
      });
      const completed = this.store.completeProjectRun({
        orgId: reservedRun.orgId,
        projectRunId: reservedRun.projectRunId,
        traceId: reservedRun.projectRunId,
        stats,
        manifest: built.manifest,
        ...(landed
          ? {
              to: 'partial' as const,
              // The runner prints the phases it never ran; keep the first line
              // of that as the row's own explanation, because 'partial' alone
              // does not tell the customer WHAT is missing.
              error: landedRunDetail(stats, log),
            }
          : {}),
      });
      if (!completed) throw new Error('project run disappeared before completion');
      // BEFORE publication and AFTER the run is durably delivered, in its own
      // guard. The surrounding catch only repairs a row that is still
      // `running`, so a throw from here would be swallowed silently and the
      // run would stay delivered with no preview and no explanation; the
      // explicit stderr line is that explanation.
      // NOT on a landed run, and this is a deliberate refusal rather than an
      // inheritance from the delivered case. The preview runtime EXECUTES the
      // workspace and serves it to the customer; doing that for a deliverable
      // root acceptance explicitly refused would hand them, running, the very
      // artefact the judge said was unproven. A landed run is still readable
      // (its manifest and its bytes are kept and seeded) — it is just not
      // offered as something to click.
      const fileDelivery = built.manifest.delivery !== 'text' && built.manifest.files.length > 0;
      if (this.describeDeliveredPreview && !landed && fileDelivery) {
        try {
          this.describeDeliveredPreview({
            orgId: reservedRun.orgId,
            projectId: reservedRun.projectId,
            projectRunId: reservedRun.projectRunId,
            workspaceRoot: reservedRun.hostPaths.workspacePath,
          });
        } catch (error) {
          process.stderr.write(
            `[atoma projects] preview descriptor unavailable for ${reservedRun.projectRunId}: ${String(error)}\n`
          );
        }
      }
      // Delivery and preview are available for client testing. Only explicit
      // client acceptance may subsequently authorize GitHub publication.
    } catch (error) {
      try {
        const current = this.store.getProjectRun(reservedRun.orgId, reservedRun.projectRunId);
        if (current?.status === 'running') {
          const tracePath = path.join(
            reservedRun.hostPaths.runsPath,
            `${reservedRun.projectRunId}.json`
          );
          this.store.transitionProjectRun({
            orgId: reservedRun.orgId,
            projectRunId: reservedRun.projectRunId,
            from: 'running',
            to: signal.aborted ? 'cancelled' : 'failed',
            ...(!signal.aborted && error instanceof GitHubAccessRequiredError ? { githubAccess: error.access } : {}),
            ...(existsSync(tracePath) ? { traceId: reservedRun.projectRunId } : {}),
            // Preserve the actual spend when host-side finalization refuses
            // a runner delivery. Only the outcome changes to match this row;
            // the original runner outcome remains in its immutable trace.
            ...(stats ? { stats: { ...stats, outcome: signal.aborted ? 'cancelled' as const : stats.outcome === 'delivered' || stats.outcome === 'partial' ? 'failed' as const : stats.outcome } } : {}),
            ...(signal.aborted
              ? {}
              : {
                  error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
                }),
          });
        }
      } catch (transitionError) {
        process.stderr.write(
          `[atoma projects] failed to persist completion for ${reservedRun.projectRunId}: ${String(transitionError)}\n`
        );
      }
    } finally {
      // Terminal-outcome hook, AFTER the state transition above persisted and
      // read back from the store so listeners see exactly what the run table
      // says. Fire-and-forget: notification latency or failure must never
      // delay the lease release below or fail the run.
      try {
        const settled = this.onRunFinished
          ? this.store.getProjectRun(reservedRun.orgId, reservedRun.projectRunId)
          : null;
        if (
          this.onRunFinished &&
          settled &&
          (settled.status === 'delivered' ||
            settled.status === 'partial' ||
            settled.status === 'failed' ||
            settled.status === 'cancelled')
        ) {
          const emit = this.onRunFinished;
          void Promise.resolve(
            emit({
              orgId: settled.orgId,
              projectId: settled.projectId,
              projectRunId: settled.projectRunId,
              principalId: settled.requestedByPrincipalId,
              goal: settled.goal,
              status: settled.status,
            })
          ).catch((error: unknown) => {
            process.stderr.write(
              `[atoma projects] run-finished listener failed for ${reservedRun.projectRunId}: ${String(error)}\n`
            );
          });
        }
      } catch (error) {
        process.stderr.write(
          `[atoma projects] run-finished listener failed for ${reservedRun.projectRunId}: ${String(error)}\n`
        );
      }
      // DETACHED from the slot: the next run may start while this one is
      // being named. Tracked only so `waitForIdle` (the CLI's exit, the tests)
      // sees the title land.
      if (this.runTitler) {
        const naming: Promise<void> = this.nameRun(this.runTitler, reservedRun).finally(() => {
          this.titling.delete(naming);
          this.resolveIdleIfSettled();
        });
        this.titling.add(naming);
      }
      try {
        lease.release();
      } catch (error) {
        process.stderr.write(
          `[atoma projects] failed to release run lease for ${reservedRun.projectRunId}: ${String(error)}\n`
        );
      }
      this.active.delete(reservedRun.projectRunId);
      if (!this.queueStopped) this.resumeQueuedRuns();
      this.resolveIdleIfSettled();
    }
  }

  /** Name an ended run once; every failure is a run that keeps showing its goal. */
  private async nameRun(titler: RunTitler, run: ProjectRun): Promise<void> {
    try {
      const settled = this.store.getProjectRun(run.orgId, run.projectRunId);
      if (!settled || settled.title || !TITLED_STATUSES.has(settled.status)) return;
      if (settled.githubAccess?.phase === 'run') return; // Preparation must spend no model quota, including naming.
      const named = await titler({ goal: settled.goal });
      if (!named) return;
      this.store.recordRunTitle({
        orgId: settled.orgId,
        projectRunId: settled.projectRunId,
        title: named.title,
        receipt: named.receipt,
      });
    } catch (error) {
      process.stderr.write(
        `[atoma projects] run title unavailable for ${run.projectRunId}: ${String(error)}\n`
      );
    }
  }

  /** Stop polling on shutdown; queued rows remain durable for the next owner. */
  stopQueue(): void {
    this.queueStopped = true;
    clearTimeout(this.queueTimer);
    this.queueTimer = undefined;
  }

  /** Resume persisted work, also used after a lease release or server restart. */
  resumeQueuedRuns(): void {
    this.queueStopped = false;
    if (this.queueTimer || this.queuePumping || this.store.listQueuedRuns().length === 0) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = undefined;
      void this.drainQueue();
    }, 250);
    if (this.idleWaiters.size === 0) this.queueTimer.unref();
  }

  private async drainQueue(): Promise<void> {
    if (this.queuePumping || this.queueStopped) return;
    this.queuePumping = true;
    try {
      for (const queued of this.store.listQueuedRuns()) {
        if (this.queueStopped) break;
        if (this.store.runCapacity(queued.orgId).maxConcurrent === 0) continue;
        let lease: RunLease;
        try { lease = await this.acquireLeasePreempting(`project:${queued.projectRunId}`, queued.orgId); }
        catch (error) {
          if (error instanceof RunLockBusyError) {
            if (error.condition === 'capacity' || error.condition === 'pending') break;
            continue;
          }
          throw error;
        }
        try {
          const run = this.store.getProjectRun(queued.orgId, queued.projectRunId);
          if (!run || run.status !== 'queued') { lease.release(); continue; }
          if (this.queuedRunAllowed && !this.queuedRunAllowed(run.requestedByPrincipalId, run.orgId)) throw new Error('Run requester no longer has permission to start runs');
          const project = this.store.getProject(run.orgId, run.projectId);
          if (!project || project.status !== 'active') throw new Error('Project is no longer active');
          const rerun = run.rerunOf ? resolveRerunOrigin({
            store: this.store, project, orgId: run.orgId, rerunOf: run.rerunOf,
            recordedSourceRunId: (id) => ProjectRetrievalLaunchStore.open(this.dbPath).recordedSourceRunId(id),
          }) : null;
          await this.launchReservedRun(run, lease, rerun);
        } catch (error) {
          lease.release();
          if (this.store.getProjectRun(queued.orgId, queued.projectRunId)?.status === 'queued') {
            this.store.transitionProjectRun({ orgId: queued.orgId, projectRunId: queued.projectRunId,
              from: 'queued', to: 'failed', error: 'Unable to start queued run: ' + String(error).slice(0, 1500) });
          }
        }
      }
    } catch (error) {
      process.stderr.write(`[atoma projects] queue dispatch failed: ${String(error)}\n`);
    } finally {
      this.queuePumping = false;
      if (!this.queueStopped) this.resumeQueuedRuns();
      this.resolveIdleIfSettled();
    }
  }

  private resolveIdleIfSettled(): void {
    if (this.active.size > 0 || this.titling.size > 0 || this.queuePumping || this.store.listQueuedRuns().length > 0) return;
    clearTimeout(this.queueTimer);
    this.queueTimer = undefined;
    for (const resolveIdle of this.idleWaiters) resolveIdle();
    this.idleWaiters.clear();
  }

  /**
   * Re-drive the publisher for a delivered run whose publication never made
   * it to GitHub — the missing caller behind the 'a retry never creates a
   * second repo' contract. The publication row stays the idempotency
   * boundary: 'published' returns as-is, a concurrent 'publishing' is left
   * alone, and only pending/failed rows are (re)driven. The publisher
   * revalidates the manifest byte-for-byte against the workspace before any
   * upload, so a workspace that changed since delivery is a refusal.
   */
  async retryPublication(orgId: string, projectRunId: string): Promise<ProjectRun | null> {
    if (!this.publisher) {
      throw new ProjectRunConfigurationError('GitHub App is not configured on this deployment');
    }
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run) return null;
    if (run.rerunOf) throw new ProjectStateConflict('a comparison rerun is never published');
    if (run.bytesExpiredAt) throw new ProjectStateConflict('Run bytes have expired; restore them before publication');
    if (run.status !== 'delivered' || !run.artifactManifest || !run.artifactManifestHash) {
      throw new ProjectStateConflict('publication retry requires a delivered run with artifacts');
    }
    this.store.assertPublicationAccepted(run);
    const project = this.store.getProject(orgId, run.projectId);
    if (!project) return null;
    const lease = await this.acquireLeasePreempting(`publication:${projectRunId}`);
    try {
      await this.publisher.publish({ project, run, workspaceRoot: run.hostPaths.workspacePath,
        manifest: run.artifactManifest, manifestHash: run.artifactManifestHash });
    } finally { lease.release(); }
    return run;
  }

  cancel(orgId: string, projectRunId: string): ProjectRun | null {
    const current = this.store.getProjectRun(orgId, projectRunId);
    if (!current) return null;
    if (current.status === 'queued') {
      const cancelled = this.store.transitionProjectRun({ orgId, projectRunId, from: 'queued', to: 'cancelled' });
      this.resolveIdleIfSettled();
      return cancelled;
    }
    const active = this.active.get(projectRunId);
    if (active?.orgId === orgId) active.controller.abort(new Error('project run cancelled'));
    return current;
  }

  /** Disconnecting a profile cannot race a run that already captured it. */
  hasActiveRunForPrincipal(principalId: string): boolean {
    for (const active of this.active.values()) {
      if (active.principalId === principalId) return true;
    }
    return false;
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0 && this.titling.size === 0 && !this.queuePumping && this.store.listQueuedRuns().length === 0) return Promise.resolve();
    this.resumeQueuedRuns();
    this.queueTimer?.ref();
    return new Promise<void>((resolveIdle) => this.idleWaiters.add(resolveIdle));
  }
}
