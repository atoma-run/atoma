import { ButtonIcon } from './ButtonIcon.js';
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CHATGPT_SUBSCRIPTION_FAMILY,
  findProvider,
  HOST_SUBSCRIPTION_FAMILY,
  orgHasBilledProviderKey,
  orgProviderIsReady,
  PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
  PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY,
  tierModelSelectionLabel,
} from '../../core/providerCatalog.js';
import { formatDate, formatDateTime } from '../client/date-format.js';
import { api } from '../client/data-api.js';
import { formatModelSelector, tryParseModelSelector } from '../../contracts/modelSelector.js';
import {
  CHATGPT_SUBSCRIPTION_MODELS,
  HOST_SUBSCRIPTION_ALIASES,
} from '../../contracts/runPayers.js';

// The selector prefixes of the four subscription families, as the catalogue
// states them — the form never spells a selector by hand.
const HOST_CLAUDE_ID = HOST_SUBSCRIPTION_FAMILY.id;
const HOST_CHATGPT_ID = CHATGPT_SUBSCRIPTION_FAMILY.id;
const PERSONAL_CHATGPT_ID = PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY.id;
const PERSONAL_CLAUDE_ID = PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY.id;
import type {
  VizAccountModels,
  VizAccountSubscriptions,
  VizLlmCatalogEntry,
  VizOrganisation,
  VizOrgModels,
} from '../client/types.js';
import { useAccountSubscriptions } from './queries.js';
import { PlatformLimitsForm } from './PlatformLimitsForm.js';

/** Settings sections in tab order; platform limits are visible only to platform admins. */
/**
 * Tab ORDER is the reading order of a first setup: who you are, then what pays
 * for a run (a subscription, else a key), then the models those choices make
 * available, and last the MCP address. Models sits after the two credential
 * tabs because an empty account arms its tiers from the subscription it just
 * connected, so the pins are already filled by the time it is reached.
 */
export const SETTINGS_TABS = ['general', 'subscriptions', 'keys', 'models', 'mcp', 'limits'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * SETTINGS BODY — ONE DOM scroll inside the Settings frame, split into tabs:
 * general (profile, organisation), LLM models (personal pins first, then the
 * organisation defaults), personal subscriptions, provider API keys, MCP.
 * Every panel stays MOUNTED and is hidden with `hidden`: the MCP panel holds
 * a token the server shows once, and the subscription panel a device login in
 * flight — switching tabs must lose neither.
 *
 * Organisation-level controls (defaults, keys) render for every member and
 * are DISABLED for non-admins: seeing what the organisation pays with is part
 * of understanding one's own picks; changing it is not.
 *
 * SaaS members need a billed-provider key before anyone can pick a model.
 *
 * PLATFORM ADMINS ARE THE EXCEPTION, AND THE REASON WAS WRONG UNTIL
 * 2026-08-28. The unlock was justified by "their runs use the host CLI
 * subscription", which is false on any deployment whose tiers are pinned to an
 * `api:` selector: there, an admin's unlocked pick of a billed model resolves
 * against the HOST's own API key and bills the operator's account, under a
 * comment claiming the subscription paid. The unlock now follows DECLARED
 * FACTS — a stored billed key, or an offered host subscription — and the
 * subscription is a named choice rather than an implied one.
 */
export function OrgModelsForm({
  t,
  locale,
  enabled,
  canManageOrg,
  platformAdmin,
  organisation,
  overlaysInert,
  onError,
  profile,
  initialTab = 'general',
  children,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: string;
  enabled: boolean;
  canManageOrg: boolean;
  platformAdmin: boolean;
  organisation: VizOrganisation | null;
  overlaysInert: boolean;
  onError: (message: string | null) => void;
  /** The General tab's profile block (display name), rendered above the organisation. */
  profile?: ReactNode;
  initialTab?: SettingsTab;
  /**
   * The MCP tab's content. The frame is `position: fixed` and is the ONE
   * scroll container of the Settings body; a sibling rendered beside it
   * lands under the tab bar.
   */
  children?: ReactNode;
}) {
  const [account, setAccount] = useState<VizAccountModels | null>(null);
  const [org, setOrg] = useState<VizOrgModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const tabs = SETTINGS_TABS.filter((tab) => tab !== 'limits' || platformAdmin);
  const selectedTab = tabs.includes(activeTab) ? activeTab : 'general';
  const queryClient = useQueryClient();
  const canUsePersonalSubscriptions =
    organisation !== null && roleCanUsePersonalSubscriptions(organisation.viewerRole);
  const subscriptions = useAccountSubscriptions(enabled && canUsePersonalSubscriptions);

  const refresh = useCallback(async (models = false): Promise<boolean> => {
    try {
      const [nextAccount, nextOrg] = await Promise.all([
        api.accountModels(models),
        api.orgModels(),
      ]);
      setAccount(nextAccount);
      setOrg(nextOrg);
      onError(null);
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
      return false;
    }
  }, [onError, t]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (subscriptions.data?.codex.state !== 'connected') return;
    void refresh();
  }, [refresh, subscriptions.data?.codex.state]);

  const apply = async (action: () => Promise<unknown>, successKey: string): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      if (await refresh()) setStatus(t(successKey));
    } catch (error) {
      setStatus(null);
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the host subscription to one member, or take it back. The member
   * list lives in the organisation query, not in this form's own state, so
   * the fresh answer comes from invalidating that query — never from
   * patching a row locally, which would show an authority the server may
   * have refused.
   */
  const applyDelegation = async (principalId: string, delegated: boolean): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      await api.setSubscriptionDelegate(principalId, delegated);
      await queryClient.invalidateQueries({ queryKey: ['viz', 'org'] });
      await refresh();
      setStatus(t(delegated ? 'settings.subscriptionDelegated' : 'settings.subscriptionDelegationWithdrawn'));
    } catch (error) {
      setStatus(null);
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const applySubscription = async (
    action: () => Promise<void>,
    successKey: string
  ): Promise<void> => {
    setBusy(true);
    setSubscriptionStatus(null);
    try {
      await action();
      const [subscriptionResult, modelsReady] = await Promise.all([
        subscriptions.refetch(),
        refresh(),
      ]);
      if (subscriptionResult.error) throw subscriptionResult.error;
      if (modelsReady) setSubscriptionStatus(t(successKey));
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const copyCodexCode = async (code: string): Promise<void> => {
    setSubscriptionStatus(null);
    try {
      await navigator.clipboard.writeText(code);
      setSubscriptionStatus(t('settings.subscriptionCodeCopied'));
      onError(null);
    } catch {
      onError(t('settings.subscriptionCopyFailed'));
    }
  };

  const selectTab = (tab: SettingsTab, focus = false): void => {
    setActiveTab(tab);
    if (focus) document.getElementById(`settings-tab-${tab}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = tabs.indexOf(selectedTab);
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    let next: SettingsTab | null = null;
    if (step !== 0) {
      next = tabs[(index + step + tabs.length) % tabs.length]!;
    } else if (event.key === 'Home') {
      next = tabs[0]!;
    } else if (event.key === 'End') {
      next = tabs[tabs.length - 1]!;
    }
    if (next === null) return;
    event.preventDefault();
    selectTab(next, true);
  };

  if (!enabled || !account || !org) return null;

  const catalog = org.catalog.length > 0 ? org.catalog : account.catalog;
  // Ollama runs on the PLATFORM's own infrastructure — an org picks its
  // models, never its endpoint — so the family is offered only where the
  // deployment declared one. An older server omits the flag: treat unknown
  // as available rather than refusing what might work.
  const ollamaAvailable = (org.ollamaAvailable ?? account.ollamaAvailable) !== false;
  const configuredProviders = new Set(org.keys.map((key) => key.provider));
  const billedKeyReady = orgHasBilledProviderKey(configuredProviders);
  // The operator's own login, offered per REQUESTER by the server. Absent
  // means not offered at all; a `reason` means offered-but-unusable, which is
  // shown greyed rather than hidden — hiding it would make an already-armed
  // pin invisible in the very select that must be used to clear it.
  const hostSubscriptions =
    account.hostSubscriptions ?? (account.hostSubscription ? [account.hostSubscription] : []);
  const subscriptionUsable = hostSubscriptions.some((subscription) => !subscription.reason);
  const canPickModels = billedKeyReady || subscriptionUsable;
  const personalSubscriptionState =
    canUsePersonalSubscriptions && subscriptions.error === null
      ? subscriptions.data?.codex.state
      : undefined;
  const personalClaudeState =
    canUsePersonalSubscriptions && subscriptions.error === null
      ? subscriptions.data?.claude.state
      : undefined;
  const personalSubscriptionUsable =
    (account.personalSubscriptions?.codex === true && personalSubscriptionState === 'connected') ||
    (account.personalSubscriptions?.claude === true && personalClaudeState === 'connected');
  const canPickAccountModels = canPickModels || personalSubscriptionUsable;
  const retainPersonalCodexFamily = Object.values(account.pins).some((selection) =>
    selection?.startsWith(`${PERSONAL_CHATGPT_ID}:`)
  );
  const retainPersonalClaudeFamily = Object.values(account.pins).some((selection) =>
    selection?.startsWith(`${PERSONAL_CLAUDE_ID}:`)
  );
  const personalCodexModelIds = (account.personalCodexModels?.models ?? []).map((model) => model.id);
  const tierIds = ['l1', 'l2', 'l3'] as const;

  const inheritLabel = (tier: (typeof tierIds)[number]): string => {
    const orgDefault = org.models[tier];
    if (!orgDefault) return t('settings.orgModelRequired');
    return t('settings.inheritOrg', { fallback: tierModelSelectionLabel(orgDefault) });
  };

  const panelProps = (tab: SettingsTab) => ({
    role: 'tabpanel' as const,
    id: `settings-panel-${tab}`,
    'aria-labelledby': `settings-tab-${tab}`,
    className: 'gpu-settings-panel',
    hidden: tab !== selectedTab,
  });

  return (
    <div
      className={`gpu-panel-skin gpu-org-models-form${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
      inert={overlaysInert}
    >
      <div className="gpu-settings-tabs" role="tablist" aria-label={t('settings.tabs')}>
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`settings-tab-${tab}`}
            className="gpu-settings-tab"
            aria-selected={tab === selectedTab}
            aria-controls={`settings-panel-${tab}`}
            tabIndex={tab === selectedTab ? 0 : -1}
            onClick={() => selectTab(tab)}
            onKeyDown={onTabKeyDown}
          >
            {t(`settings.tab.${tab}`)}
          </button>
        ))}
      </div>

      {platformAdmin ? (
        <section {...panelProps('limits')}>
          <PlatformLimitsForm t={t} enabled={enabled} onError={onError} />
        </section>
      ) : null}

      {status ? (
        <span role="status" className="gpu-org-models-status">
          {status}
        </span>
      ) : null}

      <section {...panelProps('general')}>
        {profile}
        {organisation ? (
          <section className="gpu-org-directory" aria-label={organisation.name}>
            <p className="gpu-org-models-title">{organisation.name}</p>
            <dl className="gpu-org-directory-facts">
              <div>
                <dt>{t('settings.orgId')}</dt>
                <dd>{organisation.id}</dd>
              </div>
              <div>
                <dt>{t('settings.orgCreated')}</dt>
                <dd>{formatDateTime(organisation.createdAt, locale)}</dd>
              </div>
              <div>
                <dt>{t('settings.yourRole')}</dt>
                <dd>{t(`auth.role.${organisation.viewerRole}`)}</dd>
              </div>
              <div>
                <dt>{t('settings.projects')}</dt>
                <dd>{organisation.projectCount}</dd>
              </div>
              {organisation.runCapacity ? (
                <div>
                  <dt>{t('settings.runCapacity')}</dt>
                  <dd>{t('settings.runCapacityValue', {
                    active: organisation.runCapacity.active,
                    limit: organisation.runCapacity.maxConcurrent,
                  })}</dd>
                </div>
              ) : null}
              {organisation.pendingInvitations !== null ? (
                <div>
                  <dt>{t('settings.pendingInvitations')}</dt>
                  <dd>{organisation.pendingInvitations}</dd>
                </div>
              ) : null}
            </dl>
            <p className="gpu-org-models-hint">
              {t('settings.members', { count: organisation.members.length })}
            </p>
            {/*
              The delegation control appears only where it can be exercised:
              this organisation is the one the deployment declares for its own
              login session, and the viewer may hand that spend out. Both facts
              are the server's answer, never inferred here from a chip.
            */}
            {organisation.subscriptionDelegation?.available &&
            organisation.subscriptionDelegation.mayManage ? (
              <p className="gpu-org-models-hint" role="note">
                {t('settings.subscriptionDelegateHint')}
              </p>
            ) : null}
            <ul className="gpu-org-directory-members">
              {organisation.members.map((member) => {
                const delegated = member.subscriptionDelegate === true;
                // A platform admin already spends the host login by flag, so a
                // toggle beside their name would offer an authority they
                // cannot lose here and did not need.
                const mayToggle =
                  organisation.subscriptionDelegation?.available === true &&
                  organisation.subscriptionDelegation.mayManage &&
                  !member.platformAdmin;
                return (
                  <li key={member.principalId}>
                    <span>{member.displayName}</span>
                    <span className="gpu-org-directory-meta">
                      {t(`auth.role.${member.role}`)}
                      {member.platformAdmin ? ` · ${t('auth.platformAdmin')}` : ''}
                      {delegated ? ` · ${t('auth.subscriptionDelegate')}` : ''}
                      {member.joinedAt
                        ? ` · ${t('settings.joined', { date: formatDate(member.joinedAt, locale) })}`
                        : ''}
                    </span>
                    {mayToggle ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void applyDelegation(member.principalId, !delegated)}
                      ><ButtonIcon kind="key" />
                        {t(
                          delegated
                            ? 'settings.subscriptionDelegateWithdraw'
                            : 'settings.subscriptionDelegateGrant'
                        )}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </section>

      <section {...panelProps('models')}>
        <p className="gpu-org-models-title">{t('settings.models')}</p>
        <p className="gpu-org-models-hint">{t('settings.modelsHint')}</p>
        {account.personalSubscriptions?.codex && (
          <>
            <button type="button" disabled={busy} onClick={() => {
              setBusy(true);
              void refresh(true).finally(() => setBusy(false));
            }}><ButtonIcon kind="refresh" />{t('settings.refreshModels')}</button>
            <p role="status">{t(`settings.modelCatalogue.${account.personalCodexModels?.state ?? 'unavailable'}`)}</p>
          </>
        )}
        {!canPickAccountModels && !canManageOrg ? (
          <p className="gpu-org-models-hint" role="note">
            {t('settings.modelsNeedKey')}
          </p>
        ) : null}
        {tierIds.map((tier, index) => (
          <div className="gpu-org-models-row" key={`account-${tier}`}>
            <label htmlFor={`accountmodel-${tier}`}>{t(`settings.tier${index + 1}`)}</label>
            <select
              id={`accountmodel-${tier}`}
              className="gpu-dom-input gpu-dom-select"
              disabled={busy}
              aria-describedby={`accountmodel-${tier}-origin`}
              value={account.pins[tier] ?? ''}
              onChange={(event) => {
                const value = event.target.value === '' ? null : event.target.value;
                if (!canPickAccountModels && value !== null) return;
                if (value === null && !org.models[tier]) return;
                void apply(
                  () => api.saveAccountModels(
                    reownSubscriptionPins(account.pins, tier, value, personalCodexModelIds)
                  ),
                  'settings.saved'
                );
              }}
            >
              <option value="" disabled={!org.models[tier]}>
                {inheritLabel(tier)}
              </option>
              {catalogOptions(t, catalog, configuredProviders, account.pins[tier], {
                billedKeyReady,
                ollamaAvailable,
                hostSubscriptions,
                personalSubscriptions: account.personalSubscriptions,
                personalCodexModels: account.personalCodexModels,
                personalSubscriptionState,
                personalClaudeState,
                retainPersonalCodexFamily,
                retainPersonalClaudeFamily,
              }, index + 1 as 1 | 2 | 3)}
            </select>
            <PinOrigin
              id={`accountmodel-${tier}-origin`}
              label={selectionOriginLabel(t, account.pins[tier] ?? org.models[tier], configuredProviders)}
            />
          </div>
        ))}

        <p className="gpu-org-models-title gpu-settings-subtitle">{t('settings.orgDefaults')}</p>
        {!canManageOrg ? (
          <p className="gpu-org-models-hint" role="note">
            {t('settings.orgDefaultsReadOnly')}
          </p>
        ) : !canPickModels ? (
          <p className="gpu-org-models-hint" role="note">
            {t('settings.orgModelsNeedKey')}
          </p>
        ) : (
          <p className="gpu-org-models-hint">{t('settings.orgModelsHint')}</p>
        )}
        {tierIds.map((tier, index) => (
          <div className="gpu-org-models-row" key={`org-${tier}`}>
            <label htmlFor={`orgmodel-${tier}`}>{t(`settings.tier${index + 1}`)}</label>
            <select
              id={`orgmodel-${tier}`}
              className="gpu-dom-input gpu-dom-select"
              disabled={busy || !canManageOrg}
              aria-describedby={`orgmodel-${tier}-origin`}
              value={org.models[tier] ?? ''}
              onChange={(event) => {
                const value = event.target.value === '' ? null : event.target.value;
                if (!canManageOrg || !canPickModels || value === null) return;
                void apply(
                  () => api.saveOrgModels({ ...org.models, [tier]: value }),
                  'settings.orgSaved'
                );
              }}
            >
              <option value="" disabled>
                {t('settings.orgModelRequired')}
              </option>
              {/* NO `hostSubscription` HERE. An org default is inherited by
                  every member by construction, so the subscription is an
                  ACCOUNT pin and the server refuses it at this level too. */}
              {catalogOptions(t, catalog, configuredProviders, org.models[tier], {
                billedKeyReady,
                ollamaAvailable,
              }, index + 1 as 1 | 2 | 3)}
            </select>
            <PinOrigin
              id={`orgmodel-${tier}-origin`}
              label={selectionOriginLabel(t, org.models[tier], configuredProviders)}
            />
          </div>
        ))}
      </section>

      <section {...panelProps('subscriptions')}>
        <PersonalSubscriptionsPanel
          t={t}
          subscriptions={subscriptions.data ?? null}
          loading={canUsePersonalSubscriptions && subscriptions.isPending}
          error={subscriptions.error instanceof Error ? subscriptions.error.message : null}
          canUse={canUsePersonalSubscriptions}
          busy={busy}
          status={subscriptionStatus}
          onStartCodex={() =>
            applySubscription(
              api.startCodexSubscriptionLogin,
              'settings.subscriptionLoginStarted'
            )
          }
          onCancelCodex={() =>
            applySubscription(
              api.cancelCodexSubscriptionLogin,
              'settings.subscriptionLoginCancelled'
            )
          }
          onDisconnectCodex={() =>
            applySubscription(
              api.disconnectCodexSubscription,
              'settings.subscriptionDisconnected'
            )
          }
          onCopyCodex={copyCodexCode}
          onConnectClaude={(token) =>
            applySubscription(
              async () => {
                await api.connectClaudeSubscription(token);
              },
              'settings.subscriptionClaudeConnected'
            )
          }
          onDisconnectClaude={() =>
            applySubscription(
              api.disconnectClaudeSubscription,
              'settings.subscriptionClaudeDisconnected'
            )
          }
        />
      </section>

      <section {...panelProps('keys')}>
        <p className="gpu-org-models-title">{t('settings.orgProviderKeys')}</p>
        {!canManageOrg ? (
          <p className="gpu-org-models-hint" role="note">
            {t('settings.orgKeysReadOnly')}
          </p>
        ) : (
          <p className="gpu-org-models-hint">
            {t(platformAdmin ? 'settings.orgKeysHintPlatform' : 'settings.orgKeysHint')}
          </p>
        )}
        {canManageOrg && !org.encryptionReady ? (
          <p className="gpu-org-models-hint" role="note">
            {t('settings.orgKeysUnavailable')}
          </p>
        ) : null}
        <form
          className="gpu-org-keys-form"
          autoComplete="off"
          onSubmit={(event) => event.preventDefault()}
        >
          {catalog
            .filter((provider) => provider.credentialEnvVar !== null)
            .map((provider) => {
              const configured = org.keys.find((key) => key.provider === provider.id) ?? null;
              const draft = draftKeys[provider.id] ?? '';
              const keyId = `orgkey-${provider.id}`;
              return (
                <div className="gpu-org-models-row" key={keyId}>
                  <label htmlFor={keyId}>{provider.label}</label>
                  <input
                    id={keyId}
                    className="gpu-dom-input gpu-org-key-input"
                    type="text"
                    name={keyId}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    placeholder={
                      configured
                        ? t('settings.keyConfigured', {
                            date: formatDate(configured.configuredAt, locale),
                          })
                        : t('settings.keyMissing')
                    }
                    disabled={busy || !canManageOrg}
                    value={draft}
                    onChange={(event) =>
                      setDraftKeys((previous) => ({ ...previous, [provider.id]: event.target.value }))
                    }
                  />
                  {canManageOrg ? (
                    <div className="gpu-settings-actions">
                      <button
                        type="button"
                        disabled={busy || !org.encryptionReady || draft.trim().length === 0}
                        onClick={() => {
                          const value = draft.trim();
                          void apply(
                            () => api.saveOrgProviderKey(provider.id, value),
                            'settings.keySaved'
                          ).then(() =>
                            setDraftKeys((previous) => ({ ...previous, [provider.id]: '' }))
                          );
                        }}
                      ><ButtonIcon kind="save" />
                        {t(configured ? 'settings.keyReplace' : 'settings.keySave')}
                      </button>
                      {configured ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void apply(
                              () => api.removeOrgProviderKey(provider.id),
                              'settings.keyRemoved'
                            );
                          }}
                        ><ButtonIcon kind="trash" />
                          {t('settings.keyRemove')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
        </form>
      </section>

      <section {...panelProps('mcp')}>{children}</section>
    </div>
  );
}

export interface PersonalSubscriptionsPanelProps {
  readonly t: (key: string, vars?: Record<string, unknown>) => string;
  readonly subscriptions: VizAccountSubscriptions | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canUse: boolean;
  readonly busy: boolean;
  readonly status: string | null;
  readonly onStartCodex: () => Promise<void>;
  readonly onCancelCodex: () => Promise<void>;
  readonly onDisconnectCodex: () => Promise<void>;
  readonly onCopyCodex: (code: string) => Promise<void>;
  /** The pasted `claude setup-token` value; the panel clears its draft after the call. */
  readonly onConnectClaude: (token: string) => Promise<void>;
  readonly onDisconnectClaude: () => Promise<void>;
}

export function roleCanUsePersonalSubscriptions(role: string): boolean {
  return role === 'org:owner' || role === 'org:admin' || role === 'org:member';
}

/**
 * ACCOUNT-OWNED LOGIN CARDS. They live inside the one existing Settings DOM
 * scroll, not in a new overlay. Device codes are rendered only from the
 * short-lived GET projection and are never put into component persistence.
 */
export function PersonalSubscriptionsPanel({
  t,
  subscriptions,
  loading,
  error,
  canUse,
  busy,
  status,
  onStartCodex,
  onCancelCodex,
  onDisconnectCodex,
  onCopyCodex,
  onConnectClaude,
  onDisconnectClaude,
}: PersonalSubscriptionsPanelProps) {
  // The draft token lives only in this component, for the length of one
  // paste: it is cleared the moment the call returns, success or refusal, so
  // the secret never outlives the action in the DOM.
  const [claudeToken, setClaudeToken] = useState('');
  const claude = subscriptions?.claude ?? null;
  const claudeConnected = claude?.state === 'connected';
  const claudeUnavailable =
    error !== null || claude?.state === 'unavailable' || claude?.state === 'error';
  const claudeReconnect = claude?.state === 'reauth_required';
  const claudeDisconnect =
    claudeConnected ||
    (Boolean(claude?.connectedAt) &&
      (error !== null || claude?.state === 'error' || claude?.state === 'unavailable'));
  const claudeReason = claude?.reason ?? null;
  const displayedClaudeState = error
    ? 'unavailable'
    : loading && !claude
      ? 'loading'
      : (claude?.state ?? 'disconnected');
  const submitClaude = (): void => {
    const token = claudeToken.trim();
    if (token.length === 0 || busy) return;
    setClaudeToken('');
    void onConnectClaude(token);
  };
  const codex = subscriptions?.codex ?? null;
  const attempt = subscriptions?.codexAttempt ?? null;
  const connecting = codex?.state === 'connecting' || attempt?.state === 'connecting';
  const codexUnavailable =
    error !== null || codex?.state === 'unavailable' || codex?.state === 'error';
  const reconnect = codex?.state === 'reauth_required';
  const disconnect =
    codex?.state === 'connected' ||
    (Boolean(codex?.connectedAt) &&
      (error !== null || codex?.state === 'error' || codex?.state === 'unavailable'));
  const codexReason = attempt?.reason ?? codex?.reason ?? null;
  const displayedCodexState = error
    ? 'unavailable'
    : loading && !codex
      ? 'loading'
      : (codex?.state ?? 'disconnected');

  return (
    <section className="gpu-personal-subscriptions" aria-labelledby="personal-subscriptions-title">
      <p id="personal-subscriptions-title" className="gpu-org-models-title">
        {t('settings.personalSubscriptions')}
      </p>
      <p className="gpu-org-models-hint">{t('settings.personalSubscriptionsHint')}</p>
      {!canUse ? (
        <p className="gpu-org-models-hint" role="note">
          {t('settings.personalSubscriptionsViewer')}
        </p>
      ) : null}
      {error ? (
        <p className="gpu-subscription-message gpu-subscription-error" role="alert">
          {t('settings.personalSubscriptionsLoadFailed')}: {error}
        </p>
      ) : null}

      <div className="gpu-subscription-grid">
        <article className="gpu-subscription-card">
          <div className="gpu-subscription-card-head">
            <span className="gpu-subscription-name">
              {t('settings.subscriptionClaude')}
              <span className="gpu-subscription-beta">{t('settings.subscriptionClaudeBeta')}</span>
            </span>
            <span className="gpu-subscription-state" data-state={displayedClaudeState}>
              {t(`settings.subscriptionState.${displayedClaudeState}`)}
            </span>
          </div>
          <p>{t('settings.subscriptionClaudeHint')}</p>

          {claudeReason ? (
            <p className="gpu-subscription-message" role="note">
              {t(`settings.subscriptionReason.${claudeReason}`)}
            </p>
          ) : null}

          {canUse && !claudeDisconnect && !claudeUnavailable ? (
            <div className="gpu-subscription-token">
              <label htmlFor="claude-subscription-token" className="gpu-subscription-token-label">
                {t('settings.subscriptionClaudeTokenLabel')}
              </label>
              <input
                id="claude-subscription-token"
                className="gpu-dom-input gpu-subscription-token-input"
                type="password"
                name="claude-subscription-token"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                placeholder={t('settings.subscriptionClaudeTokenPlaceholder')}
                disabled={busy || loading}
                value={claudeToken}
                onChange={(event) => setClaudeToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitClaude();
                  }
                }}
              />
              <div className="gpu-subscription-actions">
                <button
                  type="button"
                  disabled={busy || loading || claudeToken.trim().length === 0}
                  onClick={submitClaude}
                ><ButtonIcon kind="link" />
                  {t(
                    claudeReconnect
                      ? 'settings.subscriptionReconnectClaude'
                      : 'settings.subscriptionConnectClaude'
                  )}
                </button>
              </div>
            </div>
          ) : null}

          {canUse && claudeDisconnect ? (
            <div className="gpu-subscription-actions">
              <button type="button" disabled={busy} onClick={() => void onDisconnectClaude()}><ButtonIcon kind="logout" />
                {t('settings.subscriptionDisconnect')}
              </button>
            </div>
          ) : null}
        </article>

        <article className="gpu-subscription-card">
          <div className="gpu-subscription-card-head">
            <span className="gpu-subscription-name">{t('settings.subscriptionCodex')}</span>
            <span
              className="gpu-subscription-state"
              data-state={displayedCodexState}
            >
              {t(`settings.subscriptionState.${displayedCodexState}`)}
            </span>
          </div>
          <p>{t('settings.subscriptionCodexHint')}</p>

          {codexReason ? (
            <p className="gpu-subscription-message" role="note">
              {t(`settings.subscriptionReason.${codexReason}`)}
            </p>
          ) : null}

          {canUse && attempt?.state === 'connecting' ? (
            <div className="gpu-subscription-device">
              <p>{t('settings.subscriptionDeviceInstructions')}</p>
              {attempt.userCode ? (
                <div className="gpu-subscription-code-row">
                  <code>{attempt.userCode}</code>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (attempt.userCode) void onCopyCodex(attempt.userCode);
                    }}
                  ><ButtonIcon kind="copy" />
                    {t('settings.subscriptionCopyCode')}
                  </button>
                </div>
              ) : null}
              <div className="gpu-subscription-actions">
                {attempt.verificationUrl ? (
                  <a
                    className="gpu-subscription-link"
                    href={attempt.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('settings.subscriptionOpenLogin')}
                  </a>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void onCancelCodex()}><ButtonIcon kind="close" />
                  {t('settings.subscriptionCancelLogin')}
                </button>
              </div>
            </div>
          ) : null}

          {canUse ? (
            <div className="gpu-subscription-actions">
              {disconnect ? (
                <button type="button" disabled={busy} onClick={() => void onDisconnectCodex()}><ButtonIcon kind="logout" />
                  {t('settings.subscriptionDisconnect')}
                </button>
              ) : !connecting && !codexUnavailable ? (
                <button type="button" disabled={busy || loading} onClick={() => void onStartCodex()}><ButtonIcon kind="link" />
                  {t(
                    reconnect
                      ? 'settings.subscriptionReconnect'
                      : 'settings.subscriptionConnect'
                  )}
                </button>
              ) : null}
              {attempt && attempt.state !== 'connecting' ? (
                <button type="button" disabled={busy} onClick={() => void onCancelCodex()}><ButtonIcon kind="close" />
                  {t('settings.subscriptionDismissAttempt')}
                </button>
              ) : null}
            </div>
          ) : null}
        </article>
      </div>

      {status ? (
        <p className="gpu-subscription-message" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

/**
 * WHO PAYS FOR A STORED SELECTION, in one line under the picker. A closed
 * native select shows only the option text ("Haiku"), and its optgroup — the
 * family that names the payer — only while the list is open (2026-10-08). The
 * rule is the contract's (`payerForSelector`): the mode decides, and only an
 * `api:` vendor needs the second fact, whether the organisation brought its key.
 */
export function selectionOriginLabel(
  t: (key: string, vars?: Record<string, unknown>) => string,
  value: string | null | undefined,
  configuredProviders: ReadonlySet<string>
): string | null {
  if (!value) return null;
  const selector = tryParseModelSelector(value);
  if (!selector) return null;
  if (selector.mode === 'sub') return t('settings.pinOrigin.host', { vendor: cliVendorLabel(selector.vendor) });
  if (selector.mode === 'own') return t('settings.pinOrigin.own', { vendor: cliVendorLabel(selector.vendor) });
  if (selector.vendor === 'ollama') return t('settings.pinOrigin.ollama');
  const vendor = findProvider(selector.vendor)?.label ?? selector.vendor;
  return t(
    configuredProviders.has(selector.vendor) ? 'settings.pinOrigin.orgKey' : 'settings.pinOrigin.hostKey',
    { vendor }
  );
}

/** The product a CLI login belongs to, as the subscription cards name it. */
function cliVendorLabel(vendor: string): string {
  return vendor === 'anthropic' ? 'Claude' : vendor === 'openai' ? 'ChatGPT' : vendor;
}

/** The caption element keeps its id even when empty, so `aria-describedby` never dangles. */
function PinOrigin({ id, label }: { readonly id: string; readonly label: string | null }) {
  return (
    <p id={id} className="gpu-org-models-origin" hidden={label === null}>
      {label ?? ''}
    </p>
  );
}

/**
 * PURE, AND THAT IS THE POINT. Every unlock decision is computed here from
 * declared facts, so what the picker offers can be proven without a browser —
 * the browser smoke cannot run in CI, and "who may spend which payer" is not a
 * property to leave to a manual check.
 */
export interface CatalogueUnlocks {
  readonly personalCodexModels?: VizAccountModels['personalCodexModels'];
  readonly billedKeyReady: boolean;
  readonly ollamaAvailable: boolean;
  /** The operator's login, when the server offered it to THIS requester. */
  readonly hostSubscriptions?: VizAccountModels['hostSubscriptions'];
  /** The requester's own provider login, usable only by that account. */
  readonly personalSubscriptions?: VizAccountModels['personalSubscriptions'];
  /** Detailed state independently read from the account self-care endpoint. */
  readonly personalSubscriptionState?: VizAccountSubscriptions['codex']['state'];
  readonly personalClaudeState?: VizAccountSubscriptions['claude']['state'];
  /** Keep a disconnected selected family visible so its pin can be cleared. */
  readonly retainPersonalCodexFamily?: boolean;
  readonly retainPersonalClaudeFamily?: boolean;
}

export function providerIsUnlocked(
  provider: { readonly id: string },
  configuredProviders: ReadonlySet<string>,
  opts: CatalogueUnlocks
): boolean {
  if (provider.id === 'ollama') return opts.ollamaAvailable;
  if (
    provider.id === HOST_CLAUDE_ID ||
    provider.id === HOST_CHATGPT_ID
  ) {
    return Boolean(
      opts.hostSubscriptions?.some(
        (subscription) => subscription.family.id === provider.id && !subscription.reason
      )
    );
  }
  if (provider.id === PERSONAL_CHATGPT_ID) {
    return (
      opts.personalSubscriptions?.codex === true && opts.personalSubscriptionState === 'connected'
      && opts.personalCodexModels?.state === 'ready'
    );
  }
  if (provider.id === PERSONAL_CLAUDE_ID) {
    // No inventory to discover: the family serves its three aliases.
    return opts.personalSubscriptions?.claude === true && opts.personalClaudeState === 'connected';
  }
  // NO BLANKET ADMIN UNLOCK. A platform admin picking a billed model still
  // needs the key that pays for it; the subscription is its own family, named.
  return (
    opts.billedKeyReady &&
    orgProviderIsReady(
      provider as { id: string; credentialEnvVar: string | null },
      configuredProviders
    )
  );
}

function catalogOptions(
  t: (key: string, vars?: Record<string, unknown>) => string,
  catalog: VizLlmCatalogEntry[],
  configuredProviders: ReadonlySet<string>,
  selected: string | null,
  opts: CatalogueUnlocks,
  tier: 1 | 2 | 3
): ReactNode {
  const families = [
    ...catalog,
    ...(opts.hostSubscriptions ?? []).map((subscription) => subscription.family),
    ...personalSubscriptionFamilies(opts),
  ];
  const options = families.map((provider) => {
    // The honest label: ollama compute is the platform's, and where the
    // deployment declared no endpoint the family stays visible but locked —
    // hiding it would make the operator's choice look like a client bug.
    const isOllama = provider.id === 'ollama';
    const isSubscription =
      provider.id === HOST_CLAUDE_ID || provider.id === HOST_CHATGPT_ID;
    const isPersonalSubscription =
      provider.id === PERSONAL_CHATGPT_ID || provider.id === PERSONAL_CLAUDE_ID;
    const unlocked = providerIsUnlocked(provider, configuredProviders, opts);
    const label = isOllama
      ? t(opts.ollamaAvailable ? 'settings.ollamaHosted' : 'settings.ollamaUnavailable', {
          label: provider.label,
        })
      : isSubscription
        ? t(unlocked ? 'settings.hostSubscription' : 'settings.hostSubscriptionUnavailable', {
            label: provider.label,
          })
        : isPersonalSubscription
          ? t(
              unlocked
                ? 'settings.personalSubscription'
                : 'settings.personalSubscriptionUnavailable',
              { label: provider.label }
            )
        : provider.label;
    return (
      <optgroup key={provider.id} label={label}>
        {provider.models.filter((model) => !model.tiers || model.tiers.includes(tier)).map((model) => {
          const value = `${provider.selectorPrefix}:${model.id}`;
          return (
            <option
              key={model.id}
              value={value}
              disabled={!unlocked && value !== selected}
            >
              {model.label}
            </option>
          );
        })}
      </optgroup>
    );
  });
  const present = families.some((provider) => provider.models.some((model) =>
    `${provider.selectorPrefix}:${model.id}` === selected && (!model.tiers || model.tiers.includes(tier))
  ));
  if (selected && !present) options.unshift(
    <option key="unavailable-selection" value={selected} disabled>
      {t('settings.modelUnavailable', { model: selected })}
    </option>
  );
  return options;
}

/**
 * ONE OWNER PER VENDOR, IN ONE SAVE. A run process reads one credential —
 * `CLAUDE_CODE_OAUTH_TOKEN`, one `CODEX_HOME` — so a pin set may not hold the
 * host's login on one tier and the member's on another (the server refuses it
 * with 409). The picker used to HIDE the other owner's family, which forced a
 * member to empty every tier of that vendor before their own subscription even
 * appeared (seen twice on 2026-10-08, Claude then ChatGPT). Both families are
 * offered now, and choosing an owner on one tier carries the vendor's other
 * tiers to that owner: the model is kept where the new owner serves it (the
 * three Claude aliases always; a ChatGPT slug only when the host list or the
 * member's discovered inventory has it) and is otherwise the model just
 * chosen, which that owner serves by construction. Every moved selection is
 * journaled by the save as a chosen pin.
 */
export function reownSubscriptionPins(
  pins: { l1: string | null; l2: string | null; l3: string | null },
  tier: 'l1' | 'l2' | 'l3',
  value: string | null,
  personalCodexModelIds: readonly string[]
): { l1: string | null; l2: string | null; l3: string | null } {
  const next = { ...pins, [tier]: value };
  const chosen = value === null ? null : tryParseModelSelector(value);
  if (!chosen || (chosen.mode !== 'sub' && chosen.mode !== 'own')) return next;
  const serves = (model: string): boolean =>
    chosen.vendor === 'anthropic'
      ? (HOST_SUBSCRIPTION_ALIASES as readonly string[]).includes(model)
      : chosen.mode === 'sub'
        ? (CHATGPT_SUBSCRIPTION_MODELS as readonly string[]).includes(model)
        : personalCodexModelIds.includes(model);
  for (const other of ['l1', 'l2', 'l3'] as const) {
    if (other === tier) continue;
    const current = next[other];
    const sibling = current ? tryParseModelSelector(current) : null;
    if (!sibling || sibling.vendor !== chosen.vendor || sibling.mode === chosen.mode) continue;
    if (sibling.mode !== 'sub' && sibling.mode !== 'own') continue;
    next[other] = formatModelSelector({
      mode: chosen.mode,
      vendor: chosen.vendor,
      model: serves(sibling.model) ? sibling.model : chosen.model,
    });
  }
  return next;
}

/** A personal family appears when usable, or while one of its pins remains selected. */
export function personalSubscriptionFamilies(opts: CatalogueUnlocks): VizLlmCatalogEntry[] {
  const families: VizLlmCatalogEntry[] = [];
  if (opts.personalSubscriptions?.claude || opts.retainPersonalClaudeFamily) {
    families.push({
      ...PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY,
      models: PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY.models.map((model) => ({ id: model.id, label: model.label })),
    });
  }
  if (opts.personalSubscriptions?.codex || opts.retainPersonalCodexFamily) {
    families.push({
      ...PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
      models: (opts.personalCodexModels?.models ?? []).map((model) => ({ id: model.id, label: model.label })),
    });
  }
  return families;
}
