import { ButtonIcon } from './ButtonIcon.js';
import { pendingGitHubAccess, canContinueGitHubAccess, canRetryPublication, type GitHubRecoveryProgress } from './github-access.js';
import { WorkspaceAccessible } from './WorkspaceAccessible.js';
import type { WorkspaceBrowserData } from './workspace-browser.js';
import { UpstreamSetting } from './UpstreamSetting.js';
import { matchesSearchQuery, runSearchText } from '../client/search.js';
import {
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  type Locale,
} from '../../contracts/locales.js';
import type { RunIndexEntry, VizGitHubInstallation, VizProject, VizRun } from '../client/types.js';
import { AccessibleRunActivity } from './AccessibleRunActivity.js';
import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';
import type { AuthUiSnapshot } from './AuthControls.js';
import { DOC_PAGES, DOC_THEMES, type DocsThemeKey } from './docs-content.js';
import {
  projectSelectionAfterActivate,
  useGpuStore,
  type ViewName,
} from './store.js';
import { AnnouncementForm } from './AnnouncementForm.js';

const DEFAULT_VIEWS: ViewName[] = ['projects', 'runs', 'registry', 'skills', 'burnin', 'docs'];

/**
 * SETTINGS › GENERAL — the display-name field. Real DOM for the same reason
 * other settings inputs are: text entry, autofill and screen readers belong to the
 * browser. It is an ORDINARY block inside the Settings body's General tab
 * (`OrgModelsForm`'s `profile` slot), not a fixed overlay of its own: the
 * former `.gpu-settings-form` was one of the CSS-framed debts and is gone.
 * The draft lives in the store (`search.displayName`) so the GL keyboard
 * routing knows an input owns the keys while it has focus.
 */
export function SettingsProfileForm({
  t,
  onRenameAccount,
  accountError = null,
}: {
  t: (key: string, vars?: Record<string, unknown>) => string;
  onRenameAccount?: (displayName: string) => void;
  accountError?: string | null;
}) {
  const displayName = useGpuStore((state) => state.search.displayName);
  const setSearch = useGpuStore((state) => state.setSearch);
  const setFocusedInput = useGpuStore((state) => state.setFocusedInput);
  return (
    <form
      className="gpu-settings-rename"
      onSubmit={(event) => {
        event.preventDefault();
        const next = displayName.trim();
        if (next) onRenameAccount?.(next);
      }}
    >
      <label className="gpu-settings-username" htmlFor="settings-display-name">
        {t('settings.username')}
      </label>
      <input
        id="settings-display-name"
        className="gpu-dom-input gpu-settings-name"
        aria-label={t('settings.username')}
        value={displayName}
        placeholder={t('settings.displayName')}
        maxLength={120}
        onFocus={() => setFocusedInput('displayName')}
        onBlur={() => setFocusedInput(null)}
        onChange={(event) => setSearch('displayName', event.target.value)}
      />
      <div className="gpu-settings-actions">
        <button type="submit" disabled={displayName.trim().length === 0}><ButtonIcon kind="save" />
          {t('settings.save')}
        </button>
        {accountError ? <span role="alert">{accountError}</span> : null}
      </div>
    </form>
  );
}

function AccessibleDocs({
  selected,
  onSelect,
  t,
}: {
  selected: DocsThemeKey;
  onSelect: (theme: DocsThemeKey) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const page = DOC_PAGES[selected];
  const titleId = `docs-user-title-${selected}`;
  return (
    <div className="gpu-docs-guide">
      <nav className="gpu-docs-topic-nav" aria-label={t('docs.user.topics')}>
        {DOC_THEMES.map((theme) => (
          <button
            key={theme.key}
            type="button"
            aria-current={theme.key === selected ? 'page' : undefined}
            aria-pressed={theme.key === selected}
            onClick={() => onSelect(theme.key)}
          ><ButtonIcon kind="file" />
            {t(theme.navKey)}
          </button>
        ))}
      </nav>
      <article className="gpu-docs-article" aria-labelledby={titleId}>
        <p className="gpu-docs-eyebrow">{t(page.eyebrowKey)}</p>
        <h1 id={titleId}>{t(page.titleKey)}</h1>
        <p>{t(page.ledeKey)}</p>
        {page.sections.map((section) => {
          const List = section.flow ? 'ol' : 'ul';
          return (
            <section key={section.titleKey}>
              <h2>{t(section.titleKey)}</h2>
              {section.introKey ? <p>{t(section.introKey)}</p> : null}
              <List>
                {section.cards.map((card) => (
                  <li key={card.titleKey}>
                    {card.tagKey ? <span>{t(card.tagKey)}</span> : null}
                    <h3>{t(card.titleKey)}</h3>
                    <p>{t(card.bodyKey)}</p>
                  </li>
                ))}
              </List>
            </section>
          );
        })}
      </article>
    </div>
  );
}

export function DomBridge({
  runs,
  run = null,
  releaseVersion,
  views = DEFAULT_VIEWS,
  loginLinks = null,
  pendingLoginProvider = null,
  onLoginStart,
  t,
  onSelectRun,
  onEnter,
  githubInstallations = [],
  projects = [],
  projectRuns = [], githubRecovery = null, auth = null,
  workspace,
  onOpenMcp,
  mcpAccessState = 'unknown',
  projectGuideEnabled = true,
  projectAdmin = false,
  pushPrompt = 'hidden',
  pushAdmin = false,
  onEnablePush,
  onDismissPush,
  announcementsEnabled = false,
  orgModelsForm = null,
  domOverlaysVeiled = false,
  preview = null,
  onActivate,
}: {
  runs: RunIndexEntry[];
  run?: VizRun | null;
  releaseVersion: string;
  /** Nav tabs for this viewer — computed once by `visibleViews`, shared with the GL rail. */
  views?: ViewName[];
  /** Non-null when the arrival gate is a login: real anchors, one per provider. */
  loginLinks?: { id: string; label: string; href: string }[] | null;
  /** Provider whose OAuth redirect is in flight — that anchor shows a spinner. */
  pendingLoginProvider?: string | null;
  onLoginStart?: (providerId: string) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onSelectRun: (id: string) => void;
  onEnter?: () => void;
  githubInstallations?: VizGitHubInstallation[];
  projectRuns?: import('../client/types.js').VizProjectRun[];
  githubRecovery?: GitHubRecoveryProgress | null;
  auth?: AuthUiSnapshot | null;
  /** Minimal project index mirrored for keyboard and assistive navigation. */
  projects?: readonly (Pick<VizProject, 'projectId' | 'name'> & Partial<Pick<VizProject, 'repositoryTarget' | 'followUpstream'>>)[];
  onOpenMcp?: () => void;
  /** Authorized MCP access for the viewer's active organisation. */
  mcpAccessState?: 'connected' | 'authorized' | 'unconnected' | 'unknown';
  /** The MCP setup guide exists only behind the auth gate. */
  projectGuideEnabled?: boolean;
  workspace?: WorkspaceBrowserData;
  projectAdmin?: boolean;
  /** Notification offer (first live run for members, login for platform
   *  admins); real DOM buttons because the browser permission request needs a
   *  user gesture on an actual element. */
  pushPrompt?: 'hidden' | 'offer' | 'busy' | 'error';
  /** Admins see the standing-duty copy — no run may be underway after login. */
  pushAdmin?: boolean;
  onEnablePush?: () => void;
  onDismissPush?: () => void;
  /** Platform admins only: the broadcast composer lives on the admin view. */
  announcementsEnabled?: boolean;
  /** Settings: the whole tabbed body (profile, models, subscriptions, keys, MCP). */
  orgModelsForm?: ReactNode;
  /** Shared veil state applied to every DOM overlay (see overlaysInert below). */
  domOverlaysVeiled?: boolean;
  /**
   * The selected run's preview state, mirrored from the GL control.
   *
   * A MIRROR, not a second control: it dispatches the SAME activation ids
   * through the SAME `onActivate` the canvas uses, so a keyboard member and a
   * pointer member travel one code path. Reproducing the decision here — when
   * the control appears, what it is called — would be the second definition
   * this file exists to avoid.
   */
  preview?: { state: string; availability: string } | null;
  /** The one activation channel, shared with the canvas. */
  onActivate?: (id: string) => void;
}) {
  const view = useGpuStore((state) => state.view);
  const sceneCameraMode = useGpuStore((state) => state.sceneCameraMode);
  const entered = useGpuStore((state) => state.entered);
  const handheld = useGpuStore((state) => state.handheld && !state.handheldAccepted);
  const handheldBlocked = useGpuStore((state) => state.handheldBlocked);
  const locale = useGpuStore((state) => state.locale);
  const selectedRunId = useGpuStore((state) => state.selectedRunId);
  const workspaceRunId = useGpuStore(state => state.workspaceRunId);
  const selectedProjectId = useGpuStore((state) => state.selectedProjectId);
  const projectSection = useGpuStore((state) => state.projectSection);
  const selectedDocsTheme = useGpuStore((state) => state.selectedDocsTheme);
  const accountMenuOpen = useGpuStore((state) => state.accountMenuOpen);
  const localeMenuOpen = useGpuStore((state) => state.localeMenuOpen);
  const notificationsMenuOpen = useGpuStore((state) => state.notificationsMenuOpen);
  const focusedInput = useGpuStore((state) => state.focusedInput);
  const runPickerActiveIndex = useGpuStore((state) => state.runPickerActiveIndex);
  const search = useGpuStore((state) => state.search);
  const activateView = useGpuStore((state) => state.activateView);
  const activateCrystal = useGpuStore((state) => state.activateCrystal);
  const enter = useGpuStore((state) => state.enter);
  const setLocale = useGpuStore((state) => state.setLocale);
  const setSearch = useGpuStore((state) => state.setSearch);
  const setFocusedInput = useGpuStore((state) => state.setFocusedInput);
  const setRunPickerActiveIndex = useGpuStore((state) => state.setRunPickerActiveIndex);
  const setRunPickerScrollY = useGpuStore((state) => state.setRunPickerScrollY);
  const selectProject = useGpuStore((state) => state.selectProject);
  const selectDocsTheme = useGpuStore((state) => state.selectDocsTheme);
  const announcementResetSignal = useGpuStore((state) => state.announcementResetSignal);
  const activeGithubInstallations = githubInstallations.filter(
    (installation) => installation.status === 'active'
  );
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
  const selectedProjectName = selectedProject?.name ?? null;
  const projectRequest = selectedProjectName
    ? t('projects.mcpSelectedRequest', { name: selectedProjectName })
    : t('projects.mcpCreateRequest');
  const [copiedRequest, setCopiedRequest] = useState<{ text: string; ok: boolean } | null>(null);
  const copyProjectRequest = async () => {
    try {
      await navigator.clipboard.writeText(projectRequest);
      setCopiedRequest({ text: projectRequest, ok: true });
    } catch {
      setCopiedRequest({ text: projectRequest, ok: false });
    }
  };
  const runValue = focusedInput === 'run' ? search.run : selectedRun?.title ?? selectedRun?.label ?? '';
  const filteredRuns = runs.filter((run) =>
    matchesSearchQuery(runSearchText(run), search.run)
  );
  // The account menu is Pixi chrome while text-entry controls are real DOM
  // above the canvas. Forms stay mounted (store-backed values stay on screen),
  // `inert` takes them out of click/focus/a11y, and `.gpu-overlays-veiled`
  // dims them and clips the menu rectangle so fields cannot paint through it.
  const overlaysInert = accountMenuOpen || localeMenuOpen || notificationsMenuOpen;

  if (!entered) {
    return (
      <div
        className="gpu-a11y-bridge"
        role="application"
        aria-label="Atoma"
      >
        <h1>Atoma</h1>
        <p>{t('welcome.tagline')}</p>
        <span data-release-version={releaseVersion}>
          {t('welcome.version', { version: releaseVersion })}
        </span>
        {handheld ? (
          // HANDHELD GATE: one Continue whatever the auth gate says, the
          // mirror of the canvas control. Pressed, it re-labels and disables,
          // and the reason follows as plain copy while the light closes the
          // scene; the white page's `role="status"` notice is the announcement.
          <>
            <button
              disabled={handheldBlocked}
              aria-disabled={handheldBlocked}
              onClick={() => (onEnter ?? enter)()}
            ><ButtonIcon kind="forward" />
              {handheldBlocked ? t('welcome.handheld.blocked') : t('welcome.continue')}
            </button>
            {handheldBlocked ? <p>{t('welcome.handheld.hint')}</p> : null}
          </>
        ) : loginLinks ? (
          // The arrival gate is the login: real anchors so keyboard and
          // assistive tech reach the provider flow without the GL canvas.
          loginLinks.map((link) => {
            const pending = pendingLoginProvider === link.id;
            const name = t('welcome.signInWith', { label: link.label });
            return (
              <a
                key={link.id}
                href={link.href}
                aria-busy={pending}
                aria-disabled={pendingLoginProvider !== null}
                aria-label={
                  pending ? t('welcome.signInBusy', { label: link.label }) : name
                }
                onClick={(event) => {
                  if (!onLoginStart) return;
                  event.preventDefault();
                  if (pendingLoginProvider) return;
                  onLoginStart(link.id);
                }}
              >
                {pending ? <span className="gpu-login-spinner" aria-hidden="true" /> : name}
              </a>
            );
          })
        ) : (
          <button onClick={() => (onEnter ?? enter)()}><ButtonIcon kind="forward" />{t('welcome.continue')}</button>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="gpu-a11y-bridge"
        role="application"
        aria-label={t('app.accessibleName')}
      >
        <button onClick={activateCrystal}><ButtonIcon kind="eye" />
          {t(sceneCameraMode === 'focus' ? 'nav.crystalExpand' : 'nav.crystalWelcome')}
        </button>
        <nav role="tablist" aria-label={t('nav.views')}>
          {views.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={view === name}
              onClick={() => activateView(name)}
            ><ButtonIcon kind="forward" />
              {t(`nav.${name}`)}
            </button>
          ))}
        </nav>
        <label>
          {t('nav.language')}
          <select
            aria-label={t('nav.language')}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            {SUPPORTED_LOCALES.map((code) => (
              <option key={code} value={code}>{LOCALE_NAMES[code]}</option>
            ))}
          </select>
        </label>
        <div data-viz-live aria-live="polite" aria-atomic="true">
          {t(`nav.${view}`)}
          {selectedRun ? ` — ${selectedRun.title ?? selectedRun.label}` : ''}
        </div>
        {projectGuideEnabled && view === 'projects' && projects.length > 0 ? (
          <section aria-label={t('nav.projects')}>
            {projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                aria-pressed={project.projectId === selectedProjectId}
                onClick={() => {
                  selectProject(
                    projectSelectionAfterActivate(selectedProjectId, project.projectId)
                  );
                }}
              ><ButtonIcon kind="folder" />
                {project.name}
              </button>
            ))}
          </section>
        ) : null}
        {view === 'projects' && selectedProjectId ? (
          <nav role="tablist" aria-label={projects.find(project => project.projectId === selectedProjectId)?.name ?? t('nav.projects')}>
            {([
              ['runs', 'nav.runs', 'play'],
              ['files', 'workspace.title', 'folder'],
              ['result', 'result.latest', 'file'],
            ] as const).map(([section, labelKey, icon]) => (
              <button key={section} type="button" role="tab" aria-selected={projectSection === section}
                onClick={() => onActivate?.(`project.section.${section}`)}>
                <ButtonIcon kind={icon} />{t(labelKey)}
              </button>
            ))}
          </nav>
        ) : null}
        {view === 'projects' && selectedProjectId && !workspaceRunId ? projectRuns.filter(run => run.projectId === selectedProjectId && pendingGitHubAccess(run)).map(run => {
          const access = pendingGitHubAccess(run)!;
          const progress = githubRecovery?.runId === run.projectRunId ? githubRecovery : null;
          return <section key={run.projectRunId} aria-label={t('projects.githubAccess.title')}>
            <h3>{t('projects.githubAccess.title')}</h3>
            <p>{run.goal}</p>
            <p>{t(access.phase === 'run' ? 'projects.githubAccess.savedRequest' : 'projects.githubAccess.savedResult')}</p>
            <p>{t('projects.githubAccess.instructions', { repository: access.fullName })}</p>
            <button type="button" onClick={() => onActivate?.(`project.githubAuthorize.${run.projectRunId}`)}>{t('projects.githubAccess.authorize')}</button>
            <button type="button" disabled={!!progress?.busy || !canContinueGitHubAccess(run, auth)}
              onClick={() => onActivate?.(`project.githubContinue.${run.projectRunId}`)}>
              {t(progress?.busy ? 'projects.githubAccess.checking' : access.phase === 'run' ? 'projects.githubAccess.continue' : 'projects.githubAccess.publish')}
            </button>
            <p role="status">{progress?.message ?? (!canContinueGitHubAccess(run, auth) ? t('projects.githubAccess.requesterOnly') : '')}</p>
          </section>;
        }) : null}
        {view === 'projects' && selectedProjectId && !workspaceRunId ? projectRuns.filter(run => run.projectId === selectedProjectId && !pendingGitHubAccess(run) && run.publication?.status === 'failed').map(run =>
          <section key={run.projectRunId} aria-label={t('projects.githubAccess.retryPublication')}>
            <p>{t('projects.githubAccess.savedResult')}</p>
            <button type="button" disabled={!canRetryPublication(run, auth) || (githubRecovery?.runId === run.projectRunId && githubRecovery.busy)}
              onClick={() => onActivate?.(`project.githubRetry.${run.projectRunId}`)}>{t('projects.githubAccess.retryPublication')}</button>
            <p role="status">{githubRecovery?.runId === run.projectRunId ? githubRecovery.message : ''}</p>
          </section>) : null}
        {view === 'projects' && selectedProjectId && projectSection === 'files' && workspaceRunId ?
          <WorkspaceAccessible data={workspace} t={t} onActivate={onActivate} /> : null}
        {view === 'runs' && preview && preview.availability === 'available' && onActivate ? (
          <section aria-label={t('preview.region')}>
            <button
              type="button"
              onClick={() => onActivate('run.preview.open')}
              disabled={preview.state === 'starting'}
            ><ButtonIcon kind="eye" />
              {t(
                preview.state === 'ready'
                  ? 'preview.open'
                  : preview.state === 'starting'
                    ? 'preview.starting'
                    : preview.state === 'failed'
                      ? 'preview.retry'
                      : 'preview.start'
              )}
            </button>
            {preview.state === 'ready' ? (
              <button type="button" onClick={() => onActivate('run.preview.stop')}><ButtonIcon kind="stop" />
                {t('preview.stop')}
              </button>
            ) : null}
          </section>
        ) : null}
        {view === 'runs' && run ? <AccessibleRunActivity run={run} t={t} /> : null}
        {view === 'docs' ? (
          <AccessibleDocs
            selected={selectedDocsTheme}
            onSelect={selectDocsTheme}
            t={t}
          />
        ) : null}
      </div>

      {view === 'runs' ? (
        <input
          className={`gpu-dom-input gpu-run-input${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          aria-label={t('runs.search', { count: runs.length })}
          value={runValue}
          placeholder={t('runs.search', { count: runs.length })}
          inert={overlaysInert}
          onFocus={() => {
            setSearch('run', '');
            setFocusedInput('run');
            const selectedIndex = Math.max(
              0,
              runs.findIndex((run) => run.id === selectedRunId)
            );
            setRunPickerActiveIndex(selectedIndex);
            setRunPickerScrollY(Math.max(0, (selectedIndex - 4) * 43));
          }}
          onBlur={() => window.setTimeout(() => setFocusedInput(null), 240)}
          onChange={(event) => {
            setSearch('run', event.target.value);
            setRunPickerActiveIndex(0);
            setRunPickerScrollY(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setFocusedInput(null);
              event.currentTarget.blur();
            }
            let nextIndex = runPickerActiveIndex;
            if (event.key === 'ArrowDown') nextIndex++;
            else if (event.key === 'ArrowUp') nextIndex--;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = filteredRuns.length - 1;
            if (nextIndex !== runPickerActiveIndex) {
              event.preventDefault();
              nextIndex = Math.max(0, Math.min(filteredRuns.length - 1, nextIndex));
              setRunPickerActiveIndex(nextIndex);
              const rowTop = nextIndex * 43;
              const currentScroll = useGpuStore.getState().runPickerScrollY;
              if (rowTop < currentScroll) setRunPickerScrollY(rowTop);
              else if (rowTop + 43 > currentScroll + 387) {
                setRunPickerScrollY(rowTop + 43 - 387);
              }
            }
            const activeRun = filteredRuns[runPickerActiveIndex] ?? filteredRuns[0];
            if (event.key === 'Enter' && activeRun) {
              onSelectRun(activeRun.id);
              setFocusedInput(null);
              event.currentTarget.blur();
            }
          }}
        />
      ) : null}
      {view === 'registry' ? (
        <input
          className={`gpu-dom-input gpu-view-search${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          aria-label={t('nav.filterAtoms')}
          value={search.registry}
          placeholder={t('nav.filterAtoms')}
          inert={overlaysInert}
          onFocus={() => setFocusedInput('registry')}
          onBlur={() => setFocusedInput(null)}
          onChange={(event) => setSearch('registry', event.target.value)}
        />
      ) : null}
      {view === 'skills' ? (
        <input
          className={`gpu-dom-input gpu-view-search${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          aria-label={t('nav.filterSkills')}
          value={search.skills}
          placeholder={t('nav.filterSkills')}
          inert={overlaysInert}
          onFocus={() => setFocusedInput('skills')}
          onBlur={() => setFocusedInput(null)}
          onChange={(event) => setSearch('skills', event.target.value)}
        />
      ) : null}
      {projectGuideEnabled && view === 'projects' && (!selectedProjectId || projectSection === 'runs') ? (
        <section
          className={`gpu-panel-skin gpu-project-mcp${selectedProjectId ? ' gpu-project-mcp--selected' : ''}${overlaysInert ? ' gpu-overlays-veiled' : ''}`}
          inert={overlaysInert}
          aria-label={t('projects.mcpTitle')}
        >
          <h2>{t('projects.mcpTitle')}</h2>
          {mcpAccessState === 'connected' || mcpAccessState === 'authorized' ? (
            <p className="gpu-project-mcp-connection" aria-live="polite">
              {t(mcpAccessState === 'connected' ? 'projects.mcpConnected' : 'projects.mcpAuthorized')}
            </p>
          ) : null}
          <p>{selectedProjectName
            ? t('projects.mcpSelectedIntro', { name: selectedProjectName })
            : t('projects.mcpCreateIntro')}</p>
          <p className="gpu-project-mcp-request">{projectRequest}</p>
          <div className="gpu-project-mcp-actions">
            {projectAdmin && selectedProject?.repositoryTarget?.source?.mode === 'fork' ?
              <UpstreamSetting key={selectedProject.projectId} projectId={selectedProject.projectId}
                enabled={selectedProject.followUpstream ?? false} t={t} /> : null}
            <button type="button" onClick={() => { void copyProjectRequest(); }}><ButtonIcon kind="copy" />{t('projects.mcpCopy')}</button>
            {mcpAccessState !== 'connected' && mcpAccessState !== 'authorized' ? (
              <button type="button" onClick={() => onOpenMcp?.()}><ButtonIcon kind="link" />
                {t(mcpAccessState === 'unconnected' ? 'projects.mcpConnect' : 'projects.mcpSettings')}
              </button>
            ) : null}
            {activeGithubInstallations.length === 0 ? (
              <a href="/auth/github/connect"><ButtonIcon kind="link" />{t('projects.connectGithub')}</a>
            ) : null}
          </div>
          {copiedRequest?.text === projectRequest ? (
            <span role="status">{t(copiedRequest.ok ? 'projects.mcpCopied' : 'projects.mcpCopyFailed')}</span>
          ) : null}
        </section>
      ) : null}
      {view === 'settings' && orgModelsForm ? (
        <div data-veiled={domOverlaysVeiled ? 'true' : undefined}>{orgModelsForm}</div>
      ) : null}
      {view === 'announce' && announcementsEnabled ? (
        <AnnouncementForm t={t} locale={locale} resetSignal={announcementResetSignal} inert={overlaysInert} />
      ) : null}
      {pushPrompt !== 'hidden' ? (
        <div
          className="gpu-push-prompt"
          role="dialog"
          aria-label={t(pushAdmin ? 'push.admin.title' : 'push.title')}
        >
          <p>{t(pushAdmin ? 'push.admin.body' : 'push.body')}</p>
          {pushPrompt === 'error' ? <span role="alert">{t('push.error')}</span> : null}
          <div className="gpu-push-prompt-actions">
            <button
              type="button"
              disabled={pushPrompt === 'busy'}
              onClick={() => onEnablePush?.()}
            ><ButtonIcon kind="bell" />
              {t('push.enable')}
            </button>
            <button
              type="button"
              disabled={pushPrompt === 'busy'}
              onClick={() => onDismissPush?.()}
            ><ButtonIcon kind="clock" />
              {t('push.later')}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The production bridge boundary. Keeping auth-derived flags here makes the
 * wiring independently renderable: an ungated shell has no project MCP guide,
 * and admin alert copy follows the actual viewer.
 */
export function GpuDomBridge({
  authSnapshot,
  ...props
}: Omit<
  ComponentProps<typeof DomBridge>,
  'projectGuideEnabled' | 'pushAdmin' | 'announcementsEnabled' | 'projectAdmin'
> & {
  authSnapshot: AuthUiSnapshot | null;
}) {
  return (
    <DomBridge
      {...props}
      projectGuideEnabled={authSnapshot !== null}
      projectAdmin={authSnapshot?.viewer.role === 'org:owner' || authSnapshot?.viewer.role === 'org:admin'}
      pushAdmin={authSnapshot?.viewer.platformAdmin === true}
      // Derived HERE with the other auth flags rather than passed in: the
      // composer is operator power, and the server enforces the same
      // answer — a client that forgot the flag must not be the reason a
      // broadcast form appears for a member.
      announcementsEnabled={authSnapshot?.viewer.platformAdmin === true}
    />
  );
}
