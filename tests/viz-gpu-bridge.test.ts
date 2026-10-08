// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { SUPPORTED_LOCALES } from '../src/contracts/locales.js';
import { DomBridge, GpuDomBridge } from '../src/viz/client-gl/DomBridge.js';
import { projectMcpAccessState } from '../src/viz/client-gl/queries.js';
import type { RunIndexEntry, VizGitHubInstallation } from '../src/viz/client/types.js';
import {
  ENTRY_FADE_IN_MS,
  ENTRY_FADE_OUT_MS,
  useEntryFade,
} from '../src/viz/client-gl/entry-fade.js';
import { EntryVeilLayer } from '../src/viz/client-gl/EntryVeilLayer.js';
import { GpuErrorBoundary } from '../src/viz/client-gl/GpuErrorBoundary.js';
import { SceneTuningPanel } from '../src/viz/client-gl/SceneTuningPanel.js';
import { readTuning, resetTuning } from '../src/viz/client-gl/tuning-live.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import {
  markBeadVisible,
  markClockIsPinned,
  pinMarkElapsedMs,
  pinMarkTurnDegrees,
  setMarkBeadVisible,
} from '../src/viz/client-gl/renderer/mark-clock.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';
import { AccessibleRunActivity } from '../src/viz/client-gl/AccessibleRunActivity.js';

const runs = [
  {
    id: 'run-1',
    label: 'build-app: GPU dashboard',
    startedAt: '2026-08-13T10:00:00.000Z',
  },
];

beforeEach(() => {
  localStorage.removeItem('atoma.viz.theme');
  useGpuStore.setState({
    view: 'runs',
    sceneCameraMode: 'overview',
    locale: 'en',
    selectedRunId: 'run-1',
    runActivityOpen: false,
    runActivityFile: null,
    runActivityPage: 0,
    runActivityExpandedChanges: {},
    selectedProjectId: null,
    projectSection: 'runs',
    selectedDocsTheme: 'quick',
    appearanceTheme: 'nocturne',
    themeDropdownOpen: false,
    focusedInput: null,
    runPickerActiveIndex: 0,
    runPickerScrollY: 0,
    accountMenuOpen: false,
    localeMenuOpen: false,
    tuningPanelOpen: false,
    search: {
      run: '',
      registry: '',
      skills: '',
      displayName: '',
    },
    entered: true,
  });
});

afterEach(() => {
  cleanup();
  setReducedMotionOverrideForTests(null);
  pinMarkElapsedMs(null);
  setMarkBeadVisible(true);
  vi.useRealTimers();
  resetTuning();
});

function renderBridge(
  onSelectRun = vi.fn(),
  runItems: RunIndexEntry[] = runs,
  onEnter?: () => void,
  githubInstallations: VizGitHubInstallation[] = [],
  selectedProjectName: string | null = null
) {
  const selectedProjectId = selectedProjectName ? 'project-selected' : null;
  if (selectedProjectId) useGpuStore.setState({ selectedProjectId });
  render(
    createElement(DomBridge, {
      runs: runItems,
      releaseVersion: '9.8.7',
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      onSelectRun,
      onEnter,
      githubInstallations,
      mcpAccessState: 'unconnected',
      projects: selectedProjectName
        ? [{ projectId: selectedProjectId!, name: selectedProjectName }]
        : [],
    })
  );
  return { onSelectRun, onEnter };
}

function EntryFadeProbe() {
  const { phase, begin } = useEntryFade();
  return createElement(
    'div',
    null,
    createElement('button', { onClick: begin }, 'go'),
    createElement(EntryVeilLayer, { phase }),
    createElement('span', { 'data-testid': 'phase' }, phase ?? 'idle')
  );
}

describe('full-GL minimal DOM bridge', () => {
  it('opens recorded changes by keyboard and returns to the same source event', async () => {
    const user = userEvent.setup();
    render(createElement(AccessibleRunActivity, {
      run: { id: 'run-1', label: 'Build the page', startedAt: new Date().toISOString(), events: [
        { id: 'write-1', kind: 'tool', ts: Date.now(), name: 'edit_file',
          args: { path: 'app.js', old_string: 'old value', new_string: 'new value\n' + 'complete line\n'.repeat(80) + 'LAST RECORDED LINE' }, result: { ok: true } },
      ] },
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
    }));
    await user.click(screen.getByRole('button', { name: 'Progress · 1 file' }));
    await user.click(screen.getByRole('button', { name: 'View changes to app.js' }));
    expect(screen.getByText('− old value')).toBeInTheDocument();
    expect(screen.getByText('+ new value')).toBeInTheDocument();
    expect(screen.getByText('+ LAST RECORDED LINE')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Hide diff/ }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const expand = screen.getByRole('button', { name: /^Show diff/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await user.click(expand);
    expect(screen.getByText('+ LAST RECORDED LINE')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Before' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'After' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View source event' }));
    expect(useGpuStore.getState()).toMatchObject({ selectedEventId: 'write-1', runActivityOpen: false });
    act(() => useGpuStore.getState().selectRun('another-run'));
    expect(useGpuStore.getState()).toMatchObject({ runActivityFile: null, runActivityPage: 0, runActivityExpandedChanges: {} });
  });
  it('keeps the selected theme after an account-menu choice', () => {
    useGpuStore.getState().toggleThemeDropdown();
    expect(useGpuStore.getState().accountMenuOpen).toBe(true);
    useGpuStore.getState().setAppearanceTheme('aurora');
    expect(useGpuStore.getState().accountMenuOpen).toBe(false);
    expect(useGpuStore.getState().themeDropdownOpen).toBe(false);
    expect(useGpuStore.getState().appearanceTransitionTarget).toBe('aurora');
    useGpuStore.getState().commitAppearanceTheme('aurora');
    expect(useGpuStore.getState()).toMatchObject({
      appearanceTheme: 'aurora',
      themeDropdownOpen: false,
    });
    expect(localStorage.getItem('atoma.viz.theme')).toBe('aurora');
  });
  it('recognizes only active MCP access in the current organisation', () => {
    const tokens = {
      mcpUrl: 'https://atoma.example.com/mcp',
      tokens: [
        { tokenId: 'used-other-org', orgId: 'org-b', orgName: 'Other', label: 'Codex',
          createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-02T00:00:00Z', revokedAt: null },
        { tokenId: 'revoked-current-org', orgId: 'org-a', orgName: 'Current', label: 'Claude',
          createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-02T00:00:00Z', revokedAt: '2026-10-03T00:00:00Z' },
      ],
    };
    expect(projectMcpAccessState(undefined, 'org-a')).toBe('unknown');
    expect(projectMcpAccessState(tokens, 'org-a')).toBe('unconnected');
    expect(projectMcpAccessState(tokens, 'org-b')).toBe('connected');
    expect(projectMcpAccessState({ ...tokens, tokens: [
      ...tokens.tokens,
      { ...tokens.tokens[0]!, tokenId: 'new-current-org', orgId: 'org-a', lastUsedAt: null },
    ] }, 'org-a')).toBe('authorized');
  });
  it('renders Scene Tuning above DOM forms and writes live slider values', () => {
    useGpuStore.setState({ tuningPanelOpen: true });
    render(createElement(SceneTuningPanel));
    expect(screen.getByLabelText('Scene tuning')).toHaveClass('gpu-panel-skin');
    // Eight knobs: six scene multipliers plus independent caustic structure
    // and spectral-dispersion controls.
    expect(screen.getAllByRole('slider')).toHaveLength(8);
    fireEvent.change(screen.getByRole('slider', { name: 'Light hue' }), {
      target: { value: '45' },
    });
    expect(readTuning().lightHue).toBe(45);
    fireEvent.change(screen.getByRole('slider', { name: 'Caustic detail' }), {
      target: { value: '0' },
    });
    expect(readTuning().causticDetail).toBe(0);
    fireEvent.change(screen.getByRole('slider', { name: 'Caustic dispersion' }), {
      target: { value: '2' },
    });
    expect(readTuning().causticDispersion).toBe(2);
  });

  it('exposes Continue on the arrival gate and admits the chrome', async () => {
    useGpuStore.setState({ entered: false });
    const user = userEvent.setup();
    renderBridge();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('v9.8.7')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useGpuStore.getState().entered).toBe(true);
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('replaces Continue with real provider anchors when the gate is a login', () => {
    useGpuStore.setState({ entered: false });
    render(
      createElement(GpuDomBridge, {
        authSnapshot: null,
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        loginLinks: [
          { id: 'github', label: 'GitHub', href: '/auth/login?provider=github&invite=tok' },
        ],
      })
    );
    // Real anchors, so keyboard and assistive tech reach the provider flow
    // without the GL canvas — and the invitation rides the href.
    const anchor = screen.getByRole('link', { name: 'Continue with GitHub' });
    expect(anchor).toHaveAttribute('href', '/auth/login?provider=github&invite=tok');
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('replaces the provider label with a spinner when that login starts', async () => {
    const user = userEvent.setup();
    const onLoginStart = vi.fn();
    useGpuStore.setState({ entered: false });
    render(
      createElement(GpuDomBridge, {
        authSnapshot: null,
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        loginLinks: [
          { id: 'github', label: 'GitHub', href: '/auth/login?provider=github' },
        ],
        pendingLoginProvider: null,
        onLoginStart,
      })
    );
    await user.click(screen.getByRole('link', { name: 'Continue with GitHub' }));
    expect(onLoginStart).toHaveBeenCalledWith('github');
  });

  it('shows a busy spinner on the pending provider link', () => {
    useGpuStore.setState({ entered: false });
    render(
      createElement(GpuDomBridge, {
        authSnapshot: null,
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        loginLinks: [
          { id: 'github', label: 'GitHub', href: '/auth/login?provider=github' },
        ],
        pendingLoginProvider: 'github',
      })
    );
    const anchor = screen.getByRole('link', { name: 'Signing in with GitHub' });
    expect(anchor).toHaveAttribute('aria-busy', 'true');
    expect(anchor.querySelector('.gpu-login-spinner')).not.toBeNull();
    expect(anchor).not.toHaveTextContent('Continue with GitHub');
  });

  it('routes Continue through onEnter so the fade can own admission', async () => {
    useGpuStore.setState({ entered: false });
    const onEnter = vi.fn();
    const user = userEvent.setup();
    renderBridge(vi.fn(), runs, onEnter);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(useGpuStore.getState().entered).toBe(false);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('keeps all six canvas views reachable to assistive technology', async () => {
    const user = userEvent.setup();
    renderBridge();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    // Projects keeps the MCP setup route beside the project history.
    expect(screen.queryByRole('tab', { name: 'Launch' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(useGpuStore.getState().view).toBe('projects');
    expect(screen.getByRole('tab', { name: 'Projects', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Continue with Atoma' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect your agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start run/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Plan a project for this repository/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Run prompt' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Registry' }));
    expect(useGpuStore.getState().view).toBe('registry');
    expect(screen.getByText('Registry')).toBeInTheDocument();
  });

  it('mirrors the complete Docs guide as semantic, selectable content', async () => {
    useGpuStore.setState({ view: 'docs', selectedDocsTheme: 'quick', entered: true });
    const user = userEvent.setup();
    renderBridge();

    const topics = screen.getByRole('navigation', { name: 'Guide topics' });
    expect(within(topics).getAllByRole('button')).toHaveLength(7);
    expect(
      within(topics).getByRole('button', { name: 'Quick start' })
    ).toHaveAttribute('aria-current', 'page');
    const article = screen.getByRole('article');
    expect(
      within(article).getByRole('heading', {
        level: 1,
        name: 'From business outcome to reviewable software',
      })
    ).toBeInTheDocument();
    expect(within(article).getByText('Choose the project')).toBeInTheDocument();

    await user.click(within(topics).getByRole('button', { name: 'Trust & limits' }));
    expect(useGpuStore.getState().selectedDocsTheme).toBe('trust');
    expect(
      within(topics).getByRole('button', { name: 'Trust & limits' })
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(screen.getByRole('article')).getByRole('heading', {
        level: 1,
        name: 'Know what Atoma proves and where humans decide',
      })
    ).toBeInTheDocument();
    expect(within(topics).queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('hides Connect GitHub once an App installation is active', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [
      {
        installationId: '501',
        accountLogin: 'mgtf',
        targetType: 'User',
        status: 'active',
        repositorySelection: 'all',
      },
    ]);
    expect(screen.queryByRole('link', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Continue with Atoma' })).toBeInTheDocument();
  });

  it('guides project creation through the agent and opens MCP setup', async () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    const onOpenMcp = vi.fn();
    render(createElement(DomBridge, {
      runs, releaseVersion: '9.8.7', onSelectRun: vi.fn(), onOpenMcp,
      mcpAccessState: 'unconnected',
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
    }));
    expect(screen.getByRole('region', { name: 'Continue with Atoma' })).toBeInTheDocument();
    expect(screen.getByText('Plan a project for this repository with Atoma.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Project name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Run prompt' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Copy request' }));
    expect(await navigator.clipboard.readText()).toBe('Plan a project for this repository with Atoma.');
    expect(screen.getByRole('status')).toHaveTextContent('Copied — paste it into your agent.');
    await user.click(screen.getByRole('button', { name: 'Connect your agent' }));
    expect(onOpenMcp).toHaveBeenCalledOnce();
  });

  it('uses the selected project in a short agent request without showing a run form', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    expect(screen.getByText('Continue Weather Lab with Atoma.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Run prompt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start run/ })).not.toBeInTheDocument();
  });

  it('does not ask an authorized MCP user to connect again', () => {
    useGpuStore.setState({ view: 'projects', entered: true, selectedProjectId: 'project-selected' });
    render(createElement(DomBridge, {
      runs, releaseVersion: '9.8.7', onSelectRun: vi.fn(),
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      mcpAccessState: 'authorized',
      projects: [{ projectId: 'project-selected', name: 'Weather Lab' }],
    }));
    expect(screen.getByText('Continue Weather Lab with Atoma.')).toBeInTheDocument();
    expect(screen.getByText('Atoma MCP access approved. Open your agent to start working.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect your agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MCP settings' })).not.toBeInTheDocument();
  });

  it('collapses the connected MCP guide and lets the user reopen it', async () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    render(createElement(DomBridge, {
      runs, releaseVersion: '9.8.7', onSelectRun: vi.fn(),
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      mcpAccessState: 'connected',
    }));
    expect(screen.queryByRole('button', { name: 'Copy request' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Continue with Atoma' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(useGpuStore.getState().projectMcpCollapsed).toBe(true);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(useGpuStore.getState().projectMcpCollapsed).toBe(false);
    expect(screen.getByText('Atoma MCP connected for this organisation. Your agent is ready to work.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect your agent' })).not.toBeInTheDocument();
  });

  it('uses a neutral settings action until MCP access has loaded', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    render(createElement(DomBridge, {
      runs, releaseVersion: '9.8.7', onSelectRun: vi.fn(),
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      mcpAccessState: 'unknown',
    }));
    expect(screen.getByRole('button', { name: 'MCP settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect your agent' })).not.toBeInTheDocument();
  });

  it('mirrors project selection for keyboard and assistive navigation', async () => {
    useGpuStore.setState({ view: 'projects', entered: true, selectedProjectId: null });
    const user = userEvent.setup();
    render(createElement(DomBridge, {
      runs, releaseVersion: '9.8.7', onSelectRun: vi.fn(),
      t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
      projects: [
        { projectId: 'project-weather', name: 'Weather Lab' },
        { projectId: 'project-notes', name: 'Notes Lab' },
      ],
    }));
    const weather = screen.getByRole('button', { name: 'Weather Lab' });
    expect(weather).toHaveAttribute('aria-pressed', 'false');
    await user.click(weather);
    expect(useGpuStore.getState().selectedProjectId).toBe('project-weather');
    expect(screen.getByText('Continue Weather Lab with Atoma.')).toBeInTheDocument();
    expect(weather).toHaveAttribute('aria-pressed', 'true');
    await user.click(weather);
    expect(useGpuStore.getState().selectedProjectId).toBeNull();
    expect(screen.getByText(/Plan a project for this repository/)).toBeInTheDocument();
  });

  it('shows the MCP guide only in Runs after selecting a project', () => {
    useGpuStore.setState({ view: 'projects', entered: true, projectSection: 'runs' });
    renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    const tabs = within(screen.getByRole('tablist', { name: 'Weather Lab' })).getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual(['Runs', 'Files', 'Latest delivered results']);
    expect(document.querySelector('.gpu-project-mcp')).toHaveClass('gpu-project-mcp--selected');
    act(() => useGpuStore.getState().selectProjectSection('files'));
    expect(document.querySelector('.gpu-project-mcp')).not.toBeInTheDocument();
    act(() => useGpuStore.getState().selectProjectSection('result'));
    expect(document.querySelector('.gpu-project-mcp')).not.toBeInTheDocument();
    act(() => useGpuStore.getState().selectProjectSection('runs'));
    expect(document.querySelector('.gpu-project-mcp')).toBeInTheDocument();
  });

  it('keeps the GitHub connection reachable before any installation', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toBeInTheDocument();
  });

  it('renders DOM view overlays inert while the Pixi account menu is open', () => {
    useGpuStore.setState({ view: 'projects', entered: true, accountMenuOpen: true });
    renderBridge();
    const form = document.querySelector('.gpu-project-mcp');
    expect(form).toBeInstanceOf(HTMLElement);
    expect(form).toHaveAttribute('inert');
    expect(form).toHaveClass('gpu-overlays-veiled');
  });

  it('renders DOM view overlays inert while the Pixi locale menu is open', () => {
    useGpuStore.setState({
      view: 'projects',
      entered: true,
      accountMenuOpen: false,
      localeMenuOpen: true,
    });
    renderBridge();
    expect(document.querySelector('.gpu-project-mcp')).toHaveAttribute('inert');
    expect(document.querySelector('.gpu-project-mcp')).toHaveClass('gpu-overlays-veiled');
    const picker = screen.getByRole('combobox', { name: 'Language' });
    expect(picker).toHaveValue('en');
    expect(screen.getAllByRole('option').slice(0, SUPPORTED_LOCALES.length))
      .toHaveLength(SUPPORTED_LOCALES.length);
  });

  it('renders every other view overlay inert while the Pixi account menu is open', () => {
    const cases = [
      ['runs', '.gpu-run-input'],
      ['registry', '.gpu-view-search'],
      ['skills', '.gpu-view-search'],
    ] as const;
    for (const [view, selector] of cases) {
      cleanup();
      useGpuStore.setState({ view, entered: true, accountMenuOpen: true });
      renderBridge();
      expect(document.querySelector(selector), view).toHaveAttribute('inert');
      expect(document.querySelector(selector), view).toHaveClass('gpu-overlays-veiled');
    }
  });

  it('veils Scene Tuning with the rest — it sits exactly where the account menu opens', () => {
    // 2026-08-27, 2.10. The window is `position: fixed; z-index: 8` and its
    // default corner is the top-right, which is where the Pixi account menu
    // anchors: it painted over the menu and kept its sliders clickable above
    // it — the failure 4ab40b4 / 01ed50c closed everywhere else.
    useGpuStore.setState({ tuningPanelOpen: true, accountMenuOpen: true });
    render(createElement(SceneTuningPanel));
    const panel = screen.getByLabelText('Scene tuning');
    expect(panel).toHaveAttribute('inert');
    expect(panel).toHaveClass('gpu-overlays-veiled');
    // The clip is expressed in the element's own box, so the panel must
    // restate its dragged origin or the hole lands somewhere else entirely.
    expect(panel.style.getPropertyValue('--gpu-overlay-left')).toMatch(/^\d+px$/);
    expect(panel.style.getPropertyValue('--gpu-overlay-top')).toMatch(/^\d+px$/);
    expect(panel.style.getPropertyValue('--gpu-overlay-left')).toBe(`${panel.style.left}`);

    cleanup();
    useGpuStore.setState({ tuningPanelOpen: true, accountMenuOpen: false, localeMenuOpen: false });
    render(createElement(SceneTuningPanel));
    const restored = screen.getByLabelText('Scene tuning');
    expect(restored).not.toHaveAttribute('inert');
    expect(restored).not.toHaveClass('gpu-overlays-veiled');
  });

  it('restores interactive view overlays once both overlay menus are closed', () => {
    // Settings is absent here on purpose: its only DOM overlay is the tabbed
    // body GpuApp injects (`orgModelsForm`), which takes the veil from its
    // own `overlaysInert` prop rather than from the bridge.
    for (const view of ['runs', 'projects'] as const) {
      cleanup();
      useGpuStore.setState({
        view,
        entered: true,
        accountMenuOpen: true,
        localeMenuOpen: true,
      });
      renderBridge();
      expect(document.querySelectorAll('[inert]').length).toBeGreaterThan(0);
      cleanup();
      useGpuStore.setState({ accountMenuOpen: false, localeMenuOpen: false });
      renderBridge();
      expect(document.querySelector('[inert]')).not.toBeInTheDocument();
    }
  });

  it('does not offer project mutations on the ungated developer surface', () => {
    useGpuStore.setState({ view: 'projects', entered: true });
    render(
      createElement(GpuDomBridge, {
        authSnapshot: null,
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
      })
    );
    expect(document.querySelector('.gpu-project-mcp')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });

  it('describes the curated admin alert stream without promising every run', () => {
    render(
      createElement(GpuDomBridge, {
        authSnapshot: {
          viewer: {
            displayName: 'Operator',
            role: 'org:owner',
            activeOrganisation: null,
            organisations: [],
            platformAdmin: true,
            principalId: 'principal-admin',
            avatarUrl: null,
            displayNameSource: 'provider',
          },
          failure: false,
          signingOut: false,
          switchingOrganisationId: null,
        },
        runs,
        releaseVersion: '9.8.7',
        t: (key: string, vars?: Record<string, unknown>) => translate('en', key, vars),
        onSelectRun: vi.fn(),
        pushPrompt: 'offer',
      })
    );
    const dialog = screen.getByRole('dialog', { name: 'Platform alerts' });
    expect(dialog).toHaveTextContent('critical platform events');
    expect(dialog).not.toHaveTextContent('runs and events across the instance');
  });

  it('uses a real text input for IME/search and a textarea for the run prompt', async () => {
    const user = userEvent.setup();
    const { onSelectRun } = renderBridge(vi.fn(), runs, undefined, [], 'Weather Lab');
    const input = screen.getByRole('textbox', { name: /Search 1 run/ });
    await user.click(input);
    await user.type(input, 'GPU');
    await user.keyboard('{Enter}');
    expect(onSelectRun).toHaveBeenCalledWith('run-1');

    // Projects now routes setup through MCP instead of offering a goal field.
    useGpuStore.getState().setView('projects');
    expect(await screen.findByRole('region', { name: 'Continue with Atoma' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Run prompt' })).not.toBeInTheDocument();
  });

  it('navigates the complete run list with arrows and Enter', async () => {
    const user = userEvent.setup();
    const manyRuns = Array.from({ length: 20 }, (_, index) => ({
      id: `run-${index + 1}`,
      label: `build-app: Run ${index + 1}`,
      startedAt: '2026-08-13T10:00:00.000Z',
    }));
    const onSelectRun = vi.fn();
    renderBridge(onSelectRun, manyRuns);
    const input = screen.getByRole('textbox', { name: /Search 20 runs/ });
    await user.click(input);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelectRun).toHaveBeenCalledWith('run-4');
  });

  it('uses project order for focus, arrows, search and accessible selection', async () => {
    const user = userEvent.setup();
    const items = [
      { id: 'b', label: 'B change', projectId: 'b', projectSlug: 'Beta', startedAt: '2026-10-02', tokens: 1000, costUsd: 0.12 },
      { id: 'a-old', label: 'Old change', projectId: 'a', projectSlug: 'Alpha', startedAt: '2026-10-01', tokens: 2000, costUsd: 0.21 },
      { id: 'a-new', label: 'New change', projectId: 'a', projectSlug: 'Alpha', startedAt: '2026-10-03', tokens: 3000, costUsd: 0.31 },
    ];
    useGpuStore.setState({ selectedRunId: 'a-new' });
    const { onSelectRun } = renderBridge(vi.fn(), items);
    const select = screen.getByRole('combobox', { name: 'Runs by project' });
    expect(within(select).getAllByRole('group').map(group => group.getAttribute('label'))).toEqual([
      'Alpha · Total: 5.0k tokens · $0.52 USD',
      'Beta · Total: 1.0k tokens · $0.12 USD',
    ]);
    expect(within(select).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['a-new', 'a-old', 'b']);
    const input = screen.getByRole('textbox', { name: /Search 3 runs/ });
    await user.click(input);
    expect(useGpuStore.getState().runPickerActiveIndex).toBe(0);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelectRun).toHaveBeenLastCalledWith('a-old');
    await user.click(input);
    await user.type(input, 'Beta');
    await user.keyboard('{Enter}');
    expect(onSelectRun).toHaveBeenLastCalledWith('b');
  });

  it('keeps the run search when the input is refocused before its blur delay ends', async () => {
    const user = userEvent.setup();
    const items = [
      { id: 'b', label: 'B change', projectId: 'b', projectSlug: 'Beta', startedAt: '2026-10-02' },
      { id: 'a-new', label: 'New change', projectId: 'a', projectSlug: 'Alpha', startedAt: '2026-10-03' },
    ];
    useGpuStore.setState({ selectedRunId: 'a-new' });
    const { onSelectRun } = renderBridge(vi.fn(), items);
    const input = screen.getByRole('textbox', { name: /Search 2 runs/ });
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onSelectRun).toHaveBeenLastCalledWith('a-new');
    // Enter blurs the field and arms the picker's 240ms close; returning to it
    // inside that window must not let the stale close fire mid-typing
    // (CI run 37721952238, where a loaded runner made the window real).
    await user.click(input);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(input).toHaveValue('');
    await user.type(input, 'Beta');
    await user.keyboard('{Enter}');
    expect(onSelectRun).toHaveBeenLastCalledWith('b');
  });
});

describe('arrival entry fade', () => {
  it('covers the welcome, then admits the app, then lifts the veil', () => {
    vi.useFakeTimers();
    setReducedMotionOverrideForTests(false);
    useGpuStore.setState({ entered: false });
    render(createElement(EntryFadeProbe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(useGpuStore.getState().entered).toBe(false);
    expect(screen.getByTestId('phase')).toHaveTextContent('out');
    expect(document.querySelector('.gpu-entry-veil')?.getAttribute('data-phase')).toBe('out');
    act(() => {
      vi.advanceTimersByTime(ENTRY_FADE_OUT_MS);
    });
    expect(useGpuStore.getState().entered).toBe(true);
    expect(screen.getByTestId('phase')).toHaveTextContent('in');
    act(() => {
      vi.advanceTimersByTime(ENTRY_FADE_IN_MS);
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
    expect(document.querySelector('.gpu-entry-veil')?.getAttribute('data-phase')).toBeNull();
  });

  it('jumps to the app under reduced motion', () => {
    setReducedMotionOverrideForTests(true);
    useGpuStore.setState({ entered: false });
    render(createElement(EntryFadeProbe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(useGpuStore.getState().entered).toBe(true);
    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
  });

  it('clears welcome inspect knobs so the header mark is not left frozen', () => {
    setReducedMotionOverrideForTests(true);
    useGpuStore.setState({ entered: false });
    pinMarkTurnDegrees(90);
    setMarkBeadVisible(false);
    render(createElement(EntryFadeProbe));
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(markClockIsPinned()).toBe(false);
    expect(markBeadVisible()).toBe(true);
  });

  it('keeps both beats short', () => {
    expect(ENTRY_FADE_OUT_MS).toBeLessThanOrEqual(180);
    expect(ENTRY_FADE_IN_MS).toBeLessThanOrEqual(200);
  });
});

describe('full-GL recovery boundary', () => {
  it('offers a reload instead of leaving a blank canvas', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('shader pipeline failed');
    }
    render(
      createElement(
        GpuErrorBoundary,
        null,
        createElement(Broken)
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent('shader pipeline failed');
    expect(screen.getByRole('button', { name: 'Reload visualizer' })).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
