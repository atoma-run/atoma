// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
  PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY,
} from '../src/core/providerCatalog.js';
import {
  OrgModelsForm,
  PersonalSubscriptionsPanel,
  personalSubscriptionFamilies,
  providerIsUnlocked,
  reownSubscriptionPins,
  roleCanUsePersonalSubscriptions,
  selectionOriginLabel,
  type PersonalSubscriptionsPanelProps,
} from '../src/viz/client-gl/OrgModelsForm.js';
import { api } from '../src/viz/client/data-api.js';
import { DEFAULT_PLATFORM_LIMITS, PLATFORM_SETTING_SPECS } from '../src/contracts/platformSettings.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type {
  VizAccountModels,
  VizAccountSubscriptions,
  VizOrganisation,
  VizOrgModels,
} from '../src/viz/client/types.js';

const CONNECTING: VizAccountSubscriptions = {
  claude: {
    provider: 'claude',
    state: 'disconnected',
    connectedAt: null,
    lastVerifiedAt: null,
    reason: null,
  },
  codex: {
    provider: 'codex',
    state: 'connecting',
    connectedAt: null,
    lastVerifiedAt: null,
    reason: null,
  },
  codexAttempt: {
    attemptId: 'a23ae0f6-f16a-4abc-84e1-6819d2f8d257',
    state: 'connecting',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    expiresAt: '2026-09-04T12:00:00.000Z',
    reason: null,
  },
};

const DISCONNECTED: VizAccountSubscriptions = {
  claude: CONNECTING.claude,
  codex: {
    provider: 'codex',
    state: 'disconnected',
    connectedAt: null,
    lastVerifiedAt: null,
    reason: null,
  },
  codexAttempt: null,
};

const ACCOUNT_MODELS: VizAccountModels = {
  pins: { l1: null, l2: null, l3: null },
  defaults: { l1: 'api:ollama:test', l2: 'api:ollama:test', l3: 'api:ollama:test' },
  catalog: [],
  personalSubscriptions: { claude: false, codex: false },
};

const ORG_MODELS: VizOrgModels = {
  models: { l1: null, l2: null, l3: null },
  keys: [{ provider: 'openai', configuredAt: '2026-09-02T08:00:00.000Z' }],
  encryptionReady: false,
  catalog: [
    {
      id: 'openai',
      label: 'OpenAI',
      selectorPrefix: 'api:openai',
      credentialEnvVar: 'OPENAI_API_KEY',
      suggestive: false,
      models: [{ id: 'gpt-test', label: 'GPT test' }],
    },
  ],
  operatorDefaults: { l1: 'api:ollama:test', l2: 'api:ollama:test', l3: 'api:ollama:test' },
};

function organisation(viewerRole: string): VizOrganisation {
  return {
    id: 'org-1',
    name: 'Example organisation',
    createdAt: '2026-09-04T10:00:00.000Z',
    viewerRole,
    members: [
      { principalId: 'p-1', displayName: 'Ada', role: 'org:owner', joinedAt: '2026-09-01T09:30:00.000Z' },
    ],
    projectCount: 0,
    pendingInvitations: null,
  };
}

const noop = vi.fn(async () => undefined);

function panel(overrides: Partial<PersonalSubscriptionsPanelProps> = {}) {
  const props: PersonalSubscriptionsPanelProps = {
    t: (key, vars) => translate('en', key, vars),
    subscriptions: CONNECTING,
    loading: false,
    error: null,
    canUse: true,
    busy: false,
    status: null,
    onStartCodex: noop,
    onCancelCodex: noop,
    onDisconnectCodex: noop,
    onCopyCodex: noop,
    onConnectClaude: noop,
    onDisconnectClaude: noop,
    ...overrides,
  };
  return render(createElement(PersonalSubscriptionsPanel, props));
}

function orgModelsForm(
  viewerRole: string,
  enabled = true,
  children?: ReactNode,
  profile?: ReactNode,
  platformAdmin = false
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        OrgModelsForm,
        {
          t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
          locale: 'en',
          enabled,
          canManageOrg: false,
          platformAdmin,
          organisation: organisation(viewerRole),
          overlaysInert: false,
          onError: vi.fn(),
          profile,
        },
        children
      )
    )
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('personal subscription settings', () => {
  it('shows the bounded Codex device flow with open, copy and cancel actions', async () => {
    const copy = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const user = userEvent.setup();
    panel({ onCopyCodex: copy, onCancelCodex: cancel });

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByLabelText('Claude Code token')).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute(
      'href',
      CONNECTING.codexAttempt!.verificationUrl
    );

    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    await user.click(screen.getByRole('button', { name: 'Cancel login' }));
    expect(copy).toHaveBeenCalledWith('ABCD-EFGH');
    expect(cancel).toHaveBeenCalledOnce();
  });

  // BETA, owner decision 2026-10-08: the Claude card takes a pasted
  // `claude setup-token` token instead of a device flow.
  it('connects a pasted Claude Code token and clears the draft at once', async () => {
    const connect = vi.fn(async () => undefined);
    const user = userEvent.setup();
    panel({ subscriptions: DISCONNECTED, onConnectClaude: connect });

    const input = screen.getByLabelText('Claude Code token');
    expect(input).toHaveAttribute('type', 'password');
    const button = screen.getByRole('button', { name: 'Connect Claude' });
    expect(button).toBeDisabled();
    await user.type(input, '  sk-ant-oat01-pasted-token  ');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(connect).toHaveBeenCalledWith('sk-ant-oat01-pasted-token');
    // The secret never outlives the action in the DOM.
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('offers only disconnect for a connected Claude token, and reconnect after a lost one', async () => {
    const disconnect = vi.fn(async () => undefined);
    const user = userEvent.setup();
    const { unmount } = panel({
      subscriptions: {
        ...DISCONNECTED,
        claude: {
          provider: 'claude',
          state: 'connected',
          connectedAt: '2026-10-08T10:00:00.000Z',
          lastVerifiedAt: '2026-10-08T10:00:00.000Z',
          reason: null,
        },
      },
      onDisconnectClaude: disconnect,
    });
    expect(screen.queryByLabelText('Claude Code token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnect).toHaveBeenCalledOnce();
    unmount();

    panel({
      subscriptions: {
        ...DISCONNECTED,
        claude: {
          provider: 'claude',
          state: 'reauth_required',
          connectedAt: '2026-10-08T10:00:00.000Z',
          lastVerifiedAt: null,
          reason: 'authentication-required',
        },
      },
    });
    expect(screen.getByLabelText('Claude Code token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Claude' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Your provider session is no longer valid');
  });

  it('keeps subscription actions unavailable to an organisation viewer', () => {
    panel({ canUse: false });

    expect(screen.getByRole('note')).toHaveTextContent(
      'Viewers cannot connect or use personal AI subscriptions.'
    );
    expect(screen.queryByRole('link', { name: 'Open sign-in page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel login' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Claude Code token')).not.toBeInTheDocument();
    expect(
      ['org:owner', 'org:admin', 'org:member'].every(roleCanUsePersonalSubscriptions)
    ).toBe(true);
    expect(roleCanUsePersonalSubscriptions('org:viewer')).toBe(false);
  });

  it.each([
    ['org:viewer', true],
    ['org:member', false],
  ] as const)(
    'does not request the self-care subscription endpoint for %s when enabled=%s',
    async (role, enabled) => {
      vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
      vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
      const subscriptions = vi
        .spyOn(api, 'accountSubscriptions')
        .mockResolvedValue(DISCONNECTED);
      orgModelsForm(role, enabled);

      if (enabled) await waitFor(() => expect(api.accountModels).toHaveBeenCalledOnce());
      expect(subscriptions).not.toHaveBeenCalled();
    }
  );

  it('splits the body into five tabs and keeps every panel mounted, hidden', async () => {
    const adminSettings = vi.spyOn(api, 'adminSettings');
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    const user = userEvent.setup();
    const { container } = orgModelsForm(
      'org:member',
      true,
      createElement('p', { 'data-testid': 'settings-child' }, 'child')
    );

    const tabs = await screen.findAllByRole('tab');
    // Reading order of a first setup: identity, then what pays, then the
    // models those choices unlock, then the MCP address.
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'General',
      'Your AI subscriptions',
      'Your AI API keys',
      'LLM models',
      'Atoma MCP',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(adminSettings).not.toHaveBeenCalled();
    // Every panel is in the DOM (a minted MCP token must survive a tab
    // switch); only the active one is visible.
    const panels = container.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(5);
    expect(Array.from(panels).filter((panel) => !panel.hasAttribute('hidden'))).toHaveLength(1);
    // Children land in the MCP tab, hidden until it is selected.
    const child = screen.getByTestId('settings-child');
    expect(child.closest('#settings-panel-mcp')).not.toBeNull();
    expect(child).not.toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Atoma MCP' }));
    expect(child).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Atoma MCP' })).toHaveAttribute('aria-selected', 'true');
    // Arrow keys move the selection and wrap.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Atoma MCP' })).toHaveAttribute('aria-selected', 'true');
  });

  it('contains admin limits in the one settings body and preserves drafts between tabs', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    vi.spyOn(api, 'adminSettings').mockResolvedValue({
      catalog: [...PLATFORM_SETTING_SPECS], limits: DEFAULT_PLATFORM_LIMITS, rows: [], env: {},
    });
    const user = userEvent.setup();
    const { container } = orgModelsForm('org:owner', true, undefined, undefined, true);
    const limit = await screen.findByLabelText('run.tokenMaxTotal');
    expect(limit).not.toBeVisible();
    expect(container.querySelectorAll('.gpu-org-models-form')).toHaveLength(1);
    expect(limit.closest('#settings-panel-limits')).not.toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Run limits' }));
    expect(limit).toBeVisible();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'settings-panel-limits');
    await user.clear(limit);
    await user.type(limit, '12345');
    await user.click(screen.getByRole('tab', { name: 'Atoma MCP' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Run limits' })).toHaveFocus();
    expect(limit).toHaveValue(12345);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveFocus();
    expect(limit).not.toBeVisible();
  });

  it('lets an admin save zero for an unlimited ceiling while rejecting values below its positive minimum', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    const settings = { catalog: [...PLATFORM_SETTING_SPECS],
      limits: { ...DEFAULT_PLATFORM_LIMITS, 'llm.codexCallTimeoutMs': 60_000 }, rows: [], env: {} };
    vi.spyOn(api, 'adminSettings').mockResolvedValue(settings);
    const save = vi.spyOn(api, 'saveAdminSettings').mockResolvedValue({ ...settings,
      limits: { ...settings.limits, 'llm.codexCallTimeoutMs': 0 } });
    const user = userEvent.setup();
    orgModelsForm('org:owner', true, undefined, undefined, true);
    const input = await screen.findByLabelText('llm.codexCallTimeoutMs');
    await user.click(screen.getByRole('tab', { name: 'Run limits' }));
    const button = within(input.closest('.gpu-org-models-row') as HTMLElement).getByRole('button', { name: 'Save' });
    await user.clear(input);
    await user.type(input, '1');
    expect(button).toBeDisabled();
    await user.clear(input);
    await user.type(input, '0');
    expect(input).toBeValid();
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ set: { 'llm.codexCallTimeoutMs': 0 } }));
  });

  it('shows the profile and the organisation in General, with a formatted join date', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    orgModelsForm(
      'org:member',
      true,
      undefined,
      createElement('p', { 'data-testid': 'settings-profile' }, 'profile')
    );

    const profile = await screen.findByTestId('settings-profile');
    expect(profile.closest('#settings-panel-general')).not.toBeNull();
    expect(profile).toBeVisible();
    // The raw ISO slice ("2026-09-01") is what shipped; a date is expected.
    expect(screen.getByText(/joined September 1, 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
  });

  it('orders personal pins before the organisation defaults, greyed for a plain member', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue(DISCONNECTED);
    const user = userEvent.setup();
    orgModelsForm('org:member');

    await user.click(await screen.findByRole('tab', { name: 'LLM models' }));
    const selects = screen.getAllByRole('combobox');
    expect(selects.map((select) => select.id)).toEqual([
      'accountmodel-l1', 'accountmodel-l2', 'accountmodel-l3',
      'orgmodel-l1', 'orgmodel-l2', 'orgmodel-l3',
    ]);
    for (const select of selects.slice(0, 3)) expect(select).toBeEnabled();
    for (const select of selects.slice(3)) expect(select).toBeDisabled();
    expect(screen.getByText(/Only organisation owners and admins can change these defaults/))
      .toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Your AI API keys' }));
    expect(screen.getByText(/Provider keys are managed by organisation owners and admins/))
      .toBeInTheDocument();
    for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save key|Replace key/ })).not.toBeInTheDocument();
  });

  it('requests the self-care subscription endpoint for an organisation member', async () => {
    vi.spyOn(api, 'accountModels').mockResolvedValue(ACCOUNT_MODELS);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    const subscriptions = vi
      .spyOn(api, 'accountSubscriptions')
      .mockResolvedValue(DISCONNECTED);
    orgModelsForm('org:member');

    await waitFor(() => expect(subscriptions).toHaveBeenCalledOnce());
  });

  it.each(['error', 'unavailable'] as const)(
    'offers disconnect, not reconnect, for a retained %s subscription',
    async (state) => {
      const disconnect = vi.fn(async () => undefined);
      const user = userEvent.setup();
      panel({
        subscriptions: {
          ...DISCONNECTED,
          codex: {
            provider: 'codex',
            state,
            connectedAt: '2026-09-04T10:00:00.000Z',
            lastVerifiedAt: null,
            reason: state === 'error' ? 'login-failed' : 'codex-cli-unavailable',
          },
        },
        onDisconnectCodex: disconnect,
      });

      expect(screen.queryByRole('button', { name: 'Reconnect ChatGPT' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Disconnect' }));
      expect(disconnect).toHaveBeenCalledOnce();
    }
  );

  it('offers reconnect for a subscription that requires authentication again', () => {
    panel({
      subscriptions: {
        ...DISCONNECTED,
        codex: {
          provider: 'codex',
          state: 'reauth_required',
          connectedAt: '2026-09-04T10:00:00.000Z',
          lastVerifiedAt: null,
          reason: 'authentication-required',
        },
      },
    });

    expect(screen.getByRole('button', { name: 'Reconnect ChatGPT' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('offers personal Codex only while connected, but retains an armed disconnected pin', () => {
    const family = PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY;
    const states: VizAccountSubscriptions['codex']['state'][] = [
      'disconnected',
      'connecting',
      'connected',
      'reauth_required',
      'unavailable',
      'error',
    ];
    for (const state of states) {
      expect(
        providerIsUnlocked(family, new Set(), {
          billedKeyReady: true,
          ollamaAvailable: true,
          personalSubscriptions: { claude: false, codex: true },
          personalSubscriptionState: state,
          personalCodexModels: { state: 'ready', checkedAt: null, models: [] },
        }),
        state
      ).toBe(state === 'connected');
    }
    expect(
      personalSubscriptionFamilies({
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: false, codex: false },
        retainPersonalCodexFamily: true,
      }).map((entry) => entry.id)
    ).toEqual(['own:openai']);
    // A host ChatGPT pin elsewhere no longer hides the member's own family:
    // choosing it re-owns the sibling tiers in the same save instead.
    expect(
      personalSubscriptionFamilies({
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: false, codex: true },
        personalSubscriptionState: 'connected',
      }).map((entry) => entry.id)
    ).toEqual(['own:openai']);
  });

  it('offers personal Claude beside personal Codex, whatever the host pins', () => {
    const both = personalSubscriptionFamilies({
      billedKeyReady: false,
      ollamaAvailable: false,
      personalSubscriptions: { claude: true, codex: true },
      personalClaudeState: 'connected',
      personalSubscriptionState: 'connected',
      personalCodexModels: { state: 'ready', checkedAt: null, models: [] },
    });
    expect(both.map((entry) => entry.id)).toEqual(['own:anthropic', 'own:openai']);
    expect(both[0]!.models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'haiku']);
    // Nothing hides behind a host pin any more: choosing the member's own
    // family re-owns that vendor's other tiers in the same save.
    expect(
      personalSubscriptionFamilies({
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: true, codex: true },
      }).map((entry) => entry.id)
    ).toEqual(['own:anthropic', 'own:openai']);
    // A disconnected token keeps its armed pin visible so it can be cleared.
    expect(
      personalSubscriptionFamilies({
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: false, codex: false },
        retainPersonalClaudeFamily: true,
      }).map((entry) => entry.id)
    ).toEqual(['own:anthropic']);
    expect(
      providerIsUnlocked(PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY, new Set(), {
        billedKeyReady: false,
        ollamaAvailable: false,
        personalSubscriptions: { claude: false, codex: false },
        retainPersonalClaudeFamily: true,
      })
    ).toBe(false);
  });

  // Seen live on 2026-10-08: with `sub:anthropic:haiku` armed, the member's
  // own Claude never appeared in the picker and there was no one-step way to
  // switch. One owner per vendor is the server's rule; the picker now honours
  // it by moving the sibling Claude tiers, alias kept, in the same save.
  it('moves the other Claude tiers to the chosen owner, alias kept, and touches nothing else', () => {
    const host = { l1: 'sub:anthropic:haiku', l2: 'sub:anthropic:sonnet', l3: 'api:zai:glm-4.5' };
    expect(reownSubscriptionPins(host, 'l2', 'own:anthropic:opus', [])).toEqual({
      l1: 'own:anthropic:haiku',
      l2: 'own:anthropic:opus',
      l3: 'api:zai:glm-4.5',
    });
    const own = { l1: 'own:anthropic:haiku', l2: 'own:openai:gpt-5.6-sol', l3: 'own:anthropic:opus' };
    expect(reownSubscriptionPins(own, 'l1', 'sub:anthropic:haiku', [])).toEqual({
      l1: 'sub:anthropic:haiku',
      l2: 'own:openai:gpt-5.6-sol',
      l3: 'sub:anthropic:opus',
    });
    // A key, an inherit or another vendor's choice re-owns nothing.
    expect(reownSubscriptionPins(host, 'l3', 'api:anthropic:claude-opus-5', [])).toEqual({ ...host, l3: 'api:anthropic:claude-opus-5' });
    expect(reownSubscriptionPins(host, 'l1', null, [])).toEqual({ ...host, l1: null });
    expect(reownSubscriptionPins(host, 'l3', 'own:openai:gpt-5.6-sol', ['gpt-5.6-sol'])).toEqual({ ...host, l3: 'own:openai:gpt-5.6-sol' });
    expect(host).toEqual({ l1: 'sub:anthropic:haiku', l2: 'sub:anthropic:sonnet', l3: 'api:zai:glm-4.5' });
  });

  // Seen live the same evening with ChatGPT: `sub:openai:gpt-5.6-terra` on a
  // tier hid the member's own ChatGPT entirely. The slug is kept only where the
  // new owner serves it; otherwise the tier takes the model just chosen.
  it('moves the other ChatGPT tiers to the chosen owner, slug kept only where that owner serves it', () => {
    const inventory = ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-terra'];
    const host = { l1: 'sub:openai:gpt-5.6-sol', l2: 'sub:openai:gpt-5.6-terra', l3: 'sub:anthropic:opus' };
    expect(reownSubscriptionPins(host, 'l1', 'own:openai:gpt-6-astra', inventory)).toEqual({
      l1: 'own:openai:gpt-6-astra',
      // Terra exists in the member's inventory: kept. Claude is another vendor: untouched.
      l2: 'own:openai:gpt-5.6-terra',
      l3: 'sub:anthropic:opus',
    });
    const luna = { ...host, l2: 'sub:openai:gpt-5.6-luna' };
    expect(reownSubscriptionPins(luna, 'l1', 'own:openai:gpt-6-astra', inventory).l2).toBe('own:openai:gpt-6-astra');
    // Back to the host: a GPT-6 slug the host list does not serve takes the chosen model.
    const own = { l1: 'own:openai:gpt-6-astra', l2: 'own:openai:gpt-5.6-terra', l3: null };
    expect(reownSubscriptionPins(own, 'l2', 'sub:openai:gpt-5.6-sol', inventory)).toEqual({
      l1: 'sub:openai:gpt-5.6-sol',
      l2: 'sub:openai:gpt-5.6-sol',
      l3: null,
    });
  });

  // A closed native select shows "Haiku" and nothing of the family that pays
  // for it (2026-10-08). The caption under each tier says who does.
  it('names the payer of every pinned or inherited tier under its picker', async () => {
    const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
    const keys = new Set(['openai']);
    expect(selectionOriginLabel(t, 'own:anthropic:haiku', keys)).toBe('Paid by your own subscription · Claude');
    expect(selectionOriginLabel(t, 'sub:openai:gpt-5.6-sol', keys)).toBe('Paid by the host subscription · ChatGPT');
    expect(selectionOriginLabel(t, 'api:openai:gpt-test', keys)).toBe('Billed to the organisation’s OpenAI key');
    expect(selectionOriginLabel(t, 'api:zai:glm-4.5', keys)).toBe('Billed to the host’s Z.ai key');
    expect(selectionOriginLabel(t, 'api:ollama:llama3', keys)).toBe('Self-hosted Ollama · nothing billed');
    expect(selectionOriginLabel(t, null, keys)).toBeNull();
    expect(selectionOriginLabel(t, 'claude-cli:opus', keys)).toBeNull();

    vi.spyOn(api, 'accountModels').mockResolvedValue({
      ...ACCOUNT_MODELS,
      pins: { l1: 'own:anthropic:haiku', l2: null, l3: 'api:zai:glm-4.5' },
      personalSubscriptions: { claude: true, codex: false },
    });
    vi.spyOn(api, 'orgModels').mockResolvedValue({ ...ORG_MODELS, models: { l1: null, l2: 'api:openai:gpt-test', l3: null } });
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue({
      ...DISCONNECTED,
      claude: { ...DISCONNECTED.claude, state: 'connected', connectedAt: '2026-10-08T10:00:00.000Z' },
    });
    const user = userEvent.setup();
    orgModelsForm('org:member');
    await user.click(await screen.findByRole('tab', { name: 'LLM models' }));
    const [l1, l2, l3] = screen.getAllByRole('combobox');
    expect(l1).toHaveAccessibleDescription('Paid by your own subscription · Claude');
    // An inherited tier describes the organisation default it will run on.
    expect(l2).toHaveAccessibleDescription('Billed to the organisation’s OpenAI key');
    expect(l3).toHaveAccessibleDescription('Billed to the host’s Z.ai key');
  });

  it('uses only the self-scoped account subscription endpoints', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.startCodexSubscriptionLogin();
    await api.cancelCodexSubscriptionLogin();
    await api.disconnectCodexSubscription();
    await api.connectClaudeSubscription('sk-ant-oat01-pasted');
    await api.disconnectClaudeSubscription();

    expect(
      fetchMock.mock.calls.map(([path, init]) => [path, (init as RequestInit).method])
    ).toEqual([
      ['/api/account/subscriptions/codex/login', 'POST'],
      ['/api/account/subscriptions/codex/login', 'DELETE'],
      ['/api/account/subscriptions/codex', 'DELETE'],
      ['/api/account/subscriptions/claude', 'POST'],
      ['/api/account/subscriptions/claude', 'DELETE'],
    ]);
    for (const [path, init] of fetchMock.mock.calls) {
      const body = path === '/api/account/subscriptions/claude' && (init as RequestInit).method === 'POST'
        ? JSON.stringify({ token: 'sk-ant-oat01-pasted' })
        : '{}';
      expect(init).toMatchObject({ credentials: 'same-origin', body });
    }
  });
});


describe('discovered model picker', () => {
  it('shows new models, preserves an unavailable selection and refreshes on request', async () => {
    const account: VizAccountModels = { ...ACCOUNT_MODELS,
      pins: { l1: 'own:openai:retired-model', l2: null, l3: null },
      personalSubscriptions: { codex: true, claude: false },
      personalCodexModels: { state: 'ready', checkedAt: '2026-09-21T00:00:00Z', models: [{
        id: 'future-model', label: 'Future model', isDefault: true,
        defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low'],
      }] },
    };
    vi.spyOn(api, 'accountModels').mockResolvedValue(account);
    vi.spyOn(api, 'orgModels').mockResolvedValue(ORG_MODELS);
    vi.spyOn(api, 'accountSubscriptions').mockResolvedValue({ ...DISCONNECTED, codex: { ...DISCONNECTED.codex, state: 'connected' } });
    orgModelsForm('org:member');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'LLM models' }));
    expect(await screen.findByRole('option', { name: 'own:openai:retired-model — unavailable' })).toBeDisabled();
    expect(screen.getAllByRole('option', { name: 'Future model' })).toHaveLength(3);
    expect(screen.queryByRole('option', { name: 'GPT-5.4 Mini' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh ChatGPT models' }));
    await waitFor(() => expect(api.accountModels).toHaveBeenCalledWith(true));
  });
});
