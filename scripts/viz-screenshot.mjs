/* global document, HTMLButtonElement, matchMedia, innerHeight, requestAnimationFrame */
/**
 * viz-screenshot — capture a PNG of the GPU client for visual review.
 *
 * Agent/developer tool, NOT a release gate: after editing the viz, run this to
 * SEE the change instead of asserting around it. Documented in
 * docs/viz-screenshot.md.
 *
 *   npm run viz:shot                                   # ungated Projects view
 *   npm run viz:shot -- --auth --select-first          # logged-in, project open
 *   npm run viz:shot -- --view Runs --out /tmp/runs.png
 *   npm run viz:shot -- --url http://127.0.0.1:5173    # attach to a running dev stack
 *
 * Flags:
 *   --view <Tab label>   Nav tab to open (Projects, Runs, Registry, Skills,
 *                        Burn-in, Docs — a gated session also has the admin
 *                        plane). Settings is not a rail tab: `--auth --view
 *                        Settings` opens the a11y account menu and clicks
 *                        Settings. Default: Projects, the arrival view.
 *   --auth               Logged-in rendering WITHOUT a real OAuth session:
 *                        /auth/whoami and the org-scoped reads are stubbed in
 *                        the browser (same technique as viz-gpu-smoke's
 *                        account arm), so the gate, the account orb and the
 *                        project surfaces all render as a member would see
 *                        them. Without it: the ungated developer rendering.
 *   --platform-admin     With --auth, include platform administrator controls.
 *   --settings-tab <id>   Settings panel to capture (default general).
 *   --select-first       Click the first project row after arrival (the run
 *                        list and selected-project MCP guide).
 *   --assistant-empty    Empty conversation before choosing a model.
 *   --assistant-history  Conversation without an approval card.
 *   --assistant-no-runs  Selected project has no runs yet.
 *   --assistant-model-probe Change model and prove retention across reload.
 *   --assistant-links-probe Verify compact receipt buttons and their destinations
 *                        (with --auth --select-first --url <frontend URL>).
 *   --project-tabs-probe Switch between Conversation and Runs, preserving a draft
 *                        (with --auth --select-first --assistant-history).
 *   --assistant-own-agent Open the external guide, check its usable height
 *                        and the return to a preserved draft (with --auth).
 *   --result             Open Result through its real canvas control (Runs,
 *                        or Projects with --select-first).
 *   --notifications      Open the header bell's notification tray after
 *                        arrival (gated only: the tray exists with an account).
 *   --account-menu       Open the account menu on the profile orb after
 *                        arrival (gated only, like the orb itself).
 *   --appearance <theme>  Switch to a named palette before capture (requires --auth).
 *   --appearance-reveal-ms <ms>  Capture this many milliseconds into the
 *                        white-to-theme reveal (requires --appearance).
 *   --scroll-end         Scroll the Settings body form to its end before
 *                        capture (org directory below the keys).
 *   --camera <mode>      Camera pose after navigation: focus (default) or
 *                        overview. Overview re-activates the selected menu,
 *                        exercising the real return transition.
 *   --tuning             Open the floating Scene Tuning window.
 *   --handheld           A phone (390x844, touch as the only pointer): the
 *                        mobile notice then login or authenticated entry
 *                        (-gate, -notice and -projects PNGs beside --out).
 *   --out <path>         PNG destination. Default:
 *                        screenshots/<view>-<auth-mode>-<camera>.png
 *   --url <base>         Attach to an already-running UI server instead of
 *                        spawning a dev stack. With no --url the script spawns
 *                        `scripts/viz-dev.mjs` on two free ports and tears it
 *                        down afterwards (source path — no build needed).
 *   --width/--height     Viewport (default 1600x900, deviceScaleFactor 2).
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { assertMobileProjects } from './viz-mobile-probe.mjs';
import { assertTimelineMinimap } from './viz-timeline-probe.mjs';
import { DEFAULT_PLATFORM_LIMITS, PLATFORM_SETTING_SPECS } from '../src/contracts/platformSettings.ts';

const READY_TIMEOUT_MS = 60_000;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const view = arg('--view', 'Projects');
const authed = has('--auth');
const platformAdmin = has('--platform-admin');
const settingsTab = arg('--settings-tab', 'general');
const tuning = has('--tuning');
const selectFirst = has('--select-first');
const assistantReconnect = has('--assistant-reconnect');
const assistantEmpty = has('--assistant-empty');
const assistantOwnAgent = has('--assistant-own-agent');
const assistantHistory = has('--assistant-history');
const assistantNoRuns = has('--assistant-no-runs');
const assistantModelProbe = has('--assistant-model-probe');
const assistantLinksProbe = has('--assistant-links-probe');
if (assistantLinksProbe && (!authed || !selectFirst || !arg('--url'))) {
  throw new Error('--assistant-links-probe needs --auth --select-first --url <frontend URL>');
}
const projectTabsProbe = has('--project-tabs-probe');
const showAssistant = has('--assistant') || assistantReconnect || assistantEmpty || assistantOwnAgent || assistantHistory || assistantModelProbe || assistantLinksProbe;
const assistantFixture = {
  choices: [{ id: 'own:anthropic:haiku', model: 'own:anthropic:haiku', label: 'Claude · Haiku (beta)', payer: 'principal-subscription' }], nextBefore: null, available: true, model: 'api:anthropic:claude-haiku-4-5-20251001', busy: false, run: null,
  conversation: { id: 'f1195226-8f11-4bca-b408-1e6c10f8b353', projectId: null, version: 1, lastRequestId: null, lastRun: null, modelChoice: 'own:anthropic:haiku', costUsd: 0.0012, inputTokens: 900, outputTokens: 240,
    messages: [
      { role: 'user', text: 'I need a stock tracker for my small shop. I want to see which products need reordering.', at: '2026-10-08T10:00:00.000Z' },
      { role: 'assistant', text: 'We can start with a stock list, quantities, and a low-stock warning for each product. Here is the project I suggest. You can change the proposal before creating it.', at: '2026-10-08T10:00:01.000Z' },
    ],
    proposal: { id: 'dddddddd-1111-4222-8333-aaaaaaaaaaaa', state: 'pending', action: { kind: 'create_project', project: {
      name: 'Shop stock tracker', slug: 'shop-stock-tracker', initialPrompt: 'Build a stock tracker with a product list, editable quantities, and a reorder threshold per product. Highlight low-stock items and include sample data.',
      repositoryTarget: { installationId: '123', owner: 'example', name: 'shop-stock-tracker', visibility: 'private' },
      followUpstream: false, showcase: 'listed',
    } } },
  },
};
if (assistantHistory) {
  assistantFixture.conversation.proposal = null;
  assistantFixture.conversation.messages.push(
    { role: 'user', text: 'Add filters and an alert when stock is low.', at: new Date(Date.now() - 300_000).toISOString() },
    { role: 'assistant', text: ['## Proposed goal', '',
      'Add **stock alerts** to the inventory table, with category filters and editable quantities.', '',
      '> Keep the first version simple: sample products, local storage, and no server dependency.', '',
      '**Acceptance criteria**', '- Highlight products below their reorder threshold.',
      '- Save changes and verify persistence with `node --test`.', '',
      '```js', 'const lowStock = products.filter(product => product.quantity < product.reorderThreshold);', '```', '',
      '| Check | Expected result |', '| --- | --- |', '| Reload inventory | Saved quantities remain available |', '',
      'Review the [project repository](https://example.com/stock-tracker) before starting the run.',
    ].join('\n'), at: new Date(Date.now() - 120_000).toISOString() },
  );
}
if (assistantModelProbe) assistantFixture.choices.push({ id: 'own:anthropic:opus', model: 'own:anthropic:opus', label: 'Claude · Opus (beta)', payer: 'principal-subscription' });
if (assistantEmpty) {
  assistantFixture.conversation = { ...assistantFixture.conversation, id: null, modelChoice: undefined,
    messages: [], proposal: null, costUsd: 0, inputTokens: 0, outputTokens: 0 };
}
if (assistantReconnect) {
  assistantFixture.choices = [];
  assistantFixture.available = false;
  assistantFixture.model = null;
  assistantFixture.subscriptions = ['claude', 'codex'].map(provider => ({ provider,
    state: 'reauth_required', connectedAt: null, lastVerifiedAt: null, reason: 'authentication-required' }));
  assistantFixture.conversation = { ...assistantFixture.conversation, id: null, modelChoice: undefined,
    messages: [], proposal: null, costUsd: 0, inputTokens: 0, outputTokens: 0 };
}
const githubAccess = has('--github-access');
const githubAccessProbe = has('--github-access-probe');
const resultArtwork = has('--result-artwork');
const showResult = has('--result') || resultArtwork;
const artworkFiles = ['coastal_plate.svg', 'marsh_icon.svg', 'seagrass_icon.svg', 'reef_icon.svg', 'production_notes.md'];
const artworkGoal = 'Finalize the Pelagic Atlas illustration suite. Check all four SVG files, their viewBoxes, labels and legends. Deliver the four original illustrations and production notes.';
const showActivity = has('--activity');
const activityFile = arg('--activity-file');
const notifications = has('--notifications');
const accountMenu = has('--account-menu');
const appearanceTheme = arg('--appearance', null);
const appearanceRevealArg = arg('--appearance-reveal-ms', null);
const appearanceRevealMs = appearanceRevealArg === null ? null : Number(appearanceRevealArg);
if (appearanceRevealMs !== null && (!appearanceTheme || !Number.isFinite(appearanceRevealMs) || appearanceRevealMs < 0)) {
  throw new Error('--appearance-reveal-ms needs --appearance and a non-negative number');
}
const showThemeMenu = has('--theme-menu');
const scrollEnd = has('--scroll-end');
const handheld = has('--handheld');
const cameraMode = arg('--camera', 'focus');
if (cameraMode !== 'overview' && cameraMode !== 'focus') {
  throw new Error(`--camera must be overview or focus, got ${cameraMode}`);
}
const width = Number(arg('--width', '1600'));
const height = Number(arg('--height', '900'));
const outPath = resolve(
  arg('--out', `screenshots/${view.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${authed ? 'gated' : 'ungated'}-${cameraMode}.png`)
);

/**
 * Reserve N distinct ports by holding them all open at once. Two sequential
 * `listen(0)` calls can hand back the SAME port (the first is freed before
 * the second asks), and the two dev-stack children then race one bind.
 */
async function freePorts(count) {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolvePort(server));
      })
    )
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())))
    )
  );
  return ports;
}

/** Same fixture shape as viz-gpu-smoke's account arm: the smallest stub set
 * that makes the client render as an authenticated org member. */
function gatedStubs() {
  const principalId = '11111111-2222-3333-4444-555555555555';
  const projectId = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
  // Registry is a member destination: the one platform store, named by its
  // basename only (the server redacts the host path for non-admins).
  const registry = { id: 'atoma', label: 'atoma', path: 'atoma.db', exists: true, counts: { 1: 1, 2: 0, 3: 0, total: 1 } };
  const sharedMolecule = {
    tier: 1, rank: 'molecule', ordinal: 1, name: 'Water',
    description: 'Verify browser behaviour from an observed interaction.',
    systemPrompt: 'You are a Molecule. Establish the initial state, activate one control, inspect the resulting state and report the observed evidence.',
    tools: ['read_file'], elements: [{ tool: 'read_file', number: 3, name: 'Lithium', symbol: 'Li' }], params: {},
    createdBy: 'bootstrap', createdAt: '2026-09-15T00:00:00.000Z', version: 1, successes: 3, failures: 0, history: [],
  };
  const runs = [
    ['delivered', 0.63, null, { status: 'published', commitSha: 'c28afe4f8e3d2b1a0c9e', repositoryUrl: 'https://github.com/example/stopwatch' }],
    ['failed', null, 'control-plane JSON is not a bounded regular file: /tmp/example/trace.json', null],
    ['failed', null, 'runner finished with outcome failed', null],
    ['delivered', 0.38, null, null],
    ['delivered', 0.25, null, { status: 'published', commitSha: 'f66b0fffceb1a2d3e4f5', repositoryUrl: 'https://github.com/example/stopwatch' }],
  ].map(([status, costUsd, error, publication], index) => ({
    projectRunId: `cccccccc-1111-4222-8333-dddddddddd${String(10 + index)}`,
    projectId,
    goal: [
      'Add a dark mode toggle button to the stopwatch page that switches the colour scheme and keeps the current elapsed time and laps.',
      'Add a dark mode toggle button to the stopwatch page that switches the colour scheme and keeps the current elapsed time and laps.',
      'Add a dark mode toggle button to the stopwatch page that switches the colour scheme and keeps the current elapsed time and laps.',
      'Add a lap button to the stopwatch: each press records the current elapsed time in a list below the controls, and reset clears the list.',
      'Build a single-page stopwatch in index.html: start, stop and reset buttons, elapsed time shown as mm:ss.cc, no external dependencies.',
    ][index],
    status,
    traceId: status === 'delivered' ? `trace-${index}` : null,
    costUsd,
    durationS: 60 + index,
    tokens: 12450 + index * 1000,
    llmCalls: 12 + index,
    jevCalls: 8 + index,
    error,
    createdAt: `2026-08-20T00:0${index}:00.000Z`,
    endedAt: `2026-08-20T00:0${index}:59.000Z`,
    publication,
  }));
  if (resultArtwork) Object.assign(runs[0], {
    traceId: 'run-fixture', goal: artworkGoal,
    artifactManifest: { version: 1, source: 'workspace', totalBytes: 16000,
      files: artworkFiles.map(path => ({ path, size: 3200, mode: '100644', sha256: 'b'.repeat(64) })) },
  });
  if (githubAccess) Object.assign(runs[0], {
    status: 'failed', traceId: null, costUsd: null, tokens: null, llmCalls: null, jevCalls: null,
    requestedByPrincipalId: principalId, publication: null,
    githubAccess: { phase: 'run', repositoryId: '123', fullName: 'example/stopwatch', settingsUrl: 'https://github.com/settings/installations/501' },
  });
  return {
    '/auth/whoami': {
      enabled: true,
      authenticated: true,
      principalId,
      displayName: 'Ada Lovelace',
      displayNameSource: 'provider',
      avatarUrl: null,
      role: 'org:owner',
      platformAdmin,
      activeOrganisation: { id: 'org-a', name: 'Analytical Engines', role: 'org:owner' },
      organisations: [{ id: 'org-a', name: 'Analytical Engines', role: 'org:owner' }],
      providers: [{ id: 'github', label: 'GitHub' }],
    },
    '/api/admin/settings': {
      catalog: PLATFORM_SETTING_SPECS, limits: DEFAULT_PLATFORM_LIMITS, rows: [], env: {},
    },
    '/api/tokens': { mode: 'bearer', mcpUrl: 'https://atoma.example.com/mcp', tokens: [] },
    '/api/account/subscriptions': {
      claude: { provider: 'claude', state: 'disconnected', connectedAt: null, lastVerifiedAt: null, reason: null },
      codex: { provider: 'codex', state: 'disconnected', connectedAt: null, lastVerifiedAt: null, reason: null },
      codexAttempt: null,
    },
    // The tray as the SERVER would answer it: copy pre-rendered per row.
    '/api/notifications': {
      notifications: [
        {
          seq: 41,
          at: new Date(Date.now() - 4 * 60_000).toISOString(),
          kind: 'platform.announcement',
          severity: 'info',
          title: 'Maintenance window tonight',
          // A newline plus enough prose to prove the measured wrap AND the
          // ellipsis past the line cap.
          body: 'Runs pause between 22:00 and 23:00 UTC while storage moves.\nDrafts are kept, live runs resume where they stopped, and no publication is retried without an operator looking at it first — this is the sentence that should end in an ellipsis.',
          orgId: null,
          projectId: null,
          runId: null,
          traceId: null,
        },
        {
          seq: 40,
          at: new Date(Date.now() - 38 * 60_000).toISOString(),
          kind: 'run.finished',
          severity: 'info',
          title: 'Atoma — run delivered',
          body: 'Build a churn dashboard from the August export',
          orgId: 'org-a',
          projectId: 'proj-1',
          runId: 'a2b8b7e4-4c8e-4e2a-9f2d-2f7f0c9d1e21',
          traceId: 'trace-demo-1',
        },
        {
          seq: 38,
          at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          kind: 'publication.failed',
          severity: 'error',
          title: 'Atoma — publication failed',
          body: 'The run delivered but could not be published (churn-dashboard). A retry is available.',
          orgId: 'org-a',
          projectId: 'proj-1',
          runId: null,
          traceId: null,
        },
        {
          seq: 33,
          at: new Date(Date.now() - 26 * 3_600_000).toISOString(),
          kind: 'org.member_joined',
          severity: 'info',
          title: 'Atoma — member joined',
          body: 'Grace Hopper joined Analytical Engines as org:member',
          orgId: 'org-a',
          projectId: null,
          runId: null,
          traceId: null,
        },
        {
          seq: 29,
          at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          kind: 'github.installation_status',
          severity: 'warning',
          title: 'Atoma — GitHub installation',
          body: 'Your GitHub installation is now suspended',
          orgId: 'org-a',
          projectId: null,
          runId: null,
          traceId: null,
        },
        {
          seq: 21,
          at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
          kind: 'run.finished',
          severity: 'info',
          title: 'Atoma — run failed',
          body: 'Wire the invoicing webhook to the ledger',
          orgId: 'org-a',
          projectId: 'proj-1',
          runId: 'e9d3c2a1-7b6f-4d5e-8a9b-0c1d2e3f4a5b',
          traceId: 'trace-demo-2',
        },
      ],
      nextBefore: 12,
    },
    '/api/org': {
      id: 'org-a',
      name: 'Analytical Engines',
      createdAt: '2026-08-01T10:00:00.000Z',
      viewerRole: 'org:owner',
      members: [{
        principalId,
        displayName: 'Ada Lovelace',
        role: 'org:owner',
        joinedAt: '2026-08-01T10:00:00.000Z',
        platformAdmin: false,
        avatarUrl: null,
      }],
      projectCount: 1,
      pendingInvitations: 0,
    },
    '/api/account/models': {
      pins: { l1: null, l2: null, l3: null },
      defaults: {
        l1: 'api:anthropic:claude-haiku-4-5-20251001',
        l2: 'api:anthropic:claude-sonnet-5',
        l3: 'api:anthropic:claude-opus-5',
      },
      catalog: [],
    },
    // Settings body fetches this on mount. A 401 here reload-loops the page.
    '/api/org/models': {
      models: { l1: null, l2: null, l3: null },
      keys: [],
      encryptionReady: true,
      catalog: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          selectorPrefix: 'api:anthropic',
          credentialEnvVar: 'ANTHROPIC_API_KEY',
          suggestive: false,
          models: [
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
            { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
            { id: 'claude-opus-5', label: 'Claude Opus 5' },
          ],
        },
        {
          id: 'zai',
          label: 'Z.ai',
          selectorPrefix: 'api:zai',
          credentialEnvVar: 'ZAI_API_KEY',
          suggestive: false,
          models: [{ id: 'glm-4.5', label: 'GLM-4.5' }],
        },
        {
          id: 'ollama',
          label: 'Ollama',
          selectorPrefix: 'api:ollama',
          credentialEnvVar: null,
          suggestive: true,
          models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }],
        },
      ],
      operatorDefaults: {
        l1: 'api:anthropic:claude-haiku-4-5-20251001',
        l2: 'api:anthropic:claude-sonnet-5',
        l3: 'api:anthropic:claude-opus-5',
      },
    },
    '/api/projects': [{
      projectId,
      name: resultArtwork ? 'Pelagic Atlas — Coastal Habitat Illustration Suite' : 'Stopwatch E2E two',
      slug: 'stopwatch-e2e-two',
      status: 'active',
      repositoryTarget: {
        installationId: '501',
        owner: 'example',
        name: 'atoma-e2e-stopwatch-2',
        visibility: 'private',
      },
      repositoryStatus: 'ready',
      repositoryFullName: 'example/atoma-e2e-stopwatch-2',
      repositoryUrl: 'https://github.com/example/atoma-e2e-stopwatch-2',
      repositoryError: null,
      runCount: assistantNoRuns ? 0 : 5,
      costUsd: assistantNoRuns ? 0 : 1.26,
      showcase: 'listed',
      showcaseShown: true,
      lastRunAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }],
    [`/api/projects/${projectId}/runs`]: assistantNoRuns ? [] : runs,
    ...Object.fromEntries(runs.filter(run => run.traceId).map(run => [`/api/runs/${run.traceId}`, {
      ...fixtureTrace(), id: run.traceId, task: { description: run.goal },
    }])),
    '/api/registries': [registry],
    '/api/registry/atoma': { registry, types: [sharedMolecule] },
    '/api/skills': [{ l1Name: 'shared-molecule', l1Label: 'Water', count: 2 }],
    '/api/skills/shared-molecule': [{ id: 'verify-browser-behaviour', description: 'Verify browser behaviour with an observed interaction.', whenToUse: 'When a browser interaction needs verification.', kind: 'llm', successes: 0, failures: 0, updatedAt: '2026-09-15T00:00:00.000Z' }, { id: 'replay-recorded-checks', description: 'Replay the recorded checks.', kind: 'script', language: 'javascript', successes: 4, failures: 0, updatedAt: '2026-09-15T00:00:00.000Z' }],
    '/api/skills/shared-molecule/verify-browser-behaviour': { id: 'verify-browser-behaviour', description: 'Verify browser behaviour with an observed interaction.', whenToUse: 'When a browser interaction needs verification.', kind: 'llm', successes: 0, failures: 0, updatedAt: '2026-09-15T00:00:00.000Z', body: 'Establish the initial state. Activate the relevant control. Inspect the resulting state and report the observed evidence.' },
    '/api/skills/shared-molecule/replay-recorded-checks': { id: 'replay-recorded-checks', description: 'Replay the recorded checks.', kind: 'script', language: 'javascript', successes: 4, failures: 0, updatedAt: '2026-09-15T00:00:00.000Z', body: 'console.log("Recorded checks passed");' },
    // The Runs view auto-selects the newest index entry and loads its trace,
    // so these two stubs make `--view Runs` render the full run surface:
    // summary card, metric tiles, branch filter chips and the timeline.
    '/api/runs': [
      {
        id: 'run-fixture',
        label:
          'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend.',
        startedAt: '2026-08-23T10:00:00.000Z',
        endedAt: '2026-08-23T10:21:34.000Z',
        durationMs: 1_293_740,
        costUsd: 1.69,
        calls: 26,
        // The GOAL beside the compact label: the picker prefers it, so the
        // review fixture exercises that preference rather than the fallback.
        goal:
          'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend with a form, a list and a running total.',
        // The fresh tokens the run spent, as the index carries them, so the
        // picker's second line shows what a real one shows.
        tokens: 90_561,
        projectId,
        projectName: resultArtwork ? 'Pelagic Atlas — Coastal Habitat Illustration Suite' : 'Stopwatch E2E two',
        projectSlug: 'stopwatch-e2e-two',
        ...(resultArtwork ? { title: 'Finalize Pelagic Atlas vector showcase', goal: artworkGoal } : {}),
      },
    ],
    '/api/runs/run-fixture': fixtureTrace(),
    // Runs also reads preview availability. A real 401 here reloads the page
    // back to the arrival gate before the screenshot can capture the run.
    [`/api/projects/${projectId}/runs/run-fixture/preview`]: {
      availability: 'unavailable', kind: null, reason: 'disabled',
      state: 'stopped', generation: 0, source: 'delivered', snapshotAt: null,
      readyAt: null, expiresAt: null, errorCode: null,
      requestedHosts: [], allowedHosts: [], blockedHosts: [],
    },
    '/api/github/installations': [],
    // WITHOUT this stub the page reload-loops: the checkout `.env` usually arms
    // the auth gate, the browser has no session cookie, and the client treats
    // the resulting 401 on /api/goal-guidance as an expired session.
    '/api/goal-guidance': {
      launchEnabled: false,
      guidance: {
        npmScript: 'run:build',
        help: 'Describe the artifact to build and its acceptance criteria in one or two sentences.',
        examples: [
          'Build a single-page stopwatch in index.html: start, stop and reset buttons, no external dependencies.',
          'Add a lap button to the stopwatch: each press records the current elapsed time in a list below the controls.',
        ],
      },
    },
  };
}

/** One delivered two-phase run whose phases each fork a parallel branch —
 * enough structure for the Runs view to draw the summary card, the four
 * metric tiles, the branch filter chips and a forked timeline. */
function fixtureTrace() {
  const t0 = Date.parse('2026-08-23T10:00:00.000Z');
  let seq = 0;
  const at = (offsetS) => t0 + offsetS * 1000;
  const ev = (offsetS, fields) => ({ id: `ev-${seq++}`, ts: at(offsetS), ...fields });
  const beforeCode = [
    'function renderTotal(expenses) {',
    '  const total = 0;',
    '  totalLabel.textContent = String(total);',
    '}',
    '',
    'renderTotal(expenses);',
  ].join('\n');
  const afterCode = [
    'function renderTotal(expenses) {',
    '  const total = expenses.reduce(',
    '    (sum, expense) => sum + expense.amount,',
    '    0,',
    '  );',
    '  totalLabel.textContent = total.toFixed(2);',
    '}',
    '',
    'renderTotal(expenses);',
  ].join('\n');
  const events = [
    ev(0, { kind: 'llm', role: 'plan', actor: { tier: 3, name: 'Meristem' }, durationMs: 9000 }),
    ev(10, {
      kind: 'branch', op: 'start', branchId: 'p1', index: 0, total: 2,
      aggregationMode: 'sequential', actor: { tier: 3, name: 'Meristem' },
      label: 'Write index.html and app.js: expense form, list and totals',
    }),
    ev(12, { kind: 'llm', role: 'plan', branchId: 'p1', actor: { tier: 2, name: 'Tracheid' }, durationMs: 8000 }),
    ev(20, {
      kind: 'branch', op: 'start', branchId: 'c1', parentBranchId: 'p1',
      actor: { tier: 2, name: 'Tracheid' },
      label: 'Write index.html and app.js against the running API',
    }),
    ev(25, {
      kind: 'llm', role: 'execute', branchId: 'c1', actor: { tier: 1, name: 'Methane' },
      model: 'claude-haiku-4-5-20251001', durationMs: 210_000, costUsd: 0.41,
      usage: { input_tokens: 3200, output_tokens: 24_000 },
    }),
    ev(240, { kind: 'tool', name: 'write_file', branchId: 'c1', actor: { tier: 1, name: 'Methane' }, args: { path: 'index.html', content: '<main>Expenses</main>' }, result: { ok: true } }),
    ev(250, { kind: 'tool', name: 'write_file', branchId: 'c1', actor: { tier: 1, name: 'Methane' }, args: { path: 'app.js', content: beforeCode }, result: { ok: true } }),
    ev(255, { kind: 'tool', name: 'edit_file', branchId: 'c1', actor: { tier: 1, name: 'Methane' }, args: { path: 'app.js', old_string: beforeCode, new_string: afterCode }, result: { ok: true, replacements: 1 } }),
    // A verdict on each validator, and DELIBERATELY one of each: the decision
    // column is right-aligned, and a fixture that never showed one is why a
    // ragged right edge down a column of verdicts reached production.
    ev(260, { kind: 'llm', role: 'validate-result', branchId: 'p1', actor: { tier: 2, name: 'Tracheid' }, durationMs: 12_000, costUsd: 0.08, response: '{"approved":true}' }),
    ev(300, { kind: 'branch', op: 'end', branchId: 'c1' }),
    ev(300, { kind: 'branch', op: 'end', branchId: 'p1' }),
    ev(300, {
      kind: 'branch', op: 'start', branchId: 'p2', index: 1, total: 2,
      aggregationMode: 'sequential', actor: { tier: 3, name: 'Meristem' },
      label: 'Read the existing server.js and wire the frontend to its routes',
    }),
    ev(310, {
      kind: 'branch', op: 'start', branchId: 'c2', parentBranchId: 'p2',
      actor: { tier: 2, name: 'Sclereid' },
      label: 'Read the existing server.js and adjust fetch paths',
    }),
    ev(315, { kind: 'tool', name: 'read_file', branchId: 'c2', actor: { tier: 1, name: 'Ethane' }, args: { path: 'server.js' } }),
    ev(330, {
      kind: 'llm', role: 'execute', branchId: 'c2', actor: { tier: 1, name: 'Ethane' },
      model: 'claude-haiku-4-5-20251001', durationMs: 540_000, costUsd: 0.87,
      usage: { input_tokens: 6200, output_tokens: 52_000 },
    }),
    ev(900, { kind: 'llm', role: 'validate-result', branchId: 'p2', actor: { tier: 2, name: 'Sclereid' }, durationMs: 14_000, costUsd: 0.11, response: '{"approved":false}' }),
    ev(1200, { kind: 'branch', op: 'end', branchId: 'c2' }),
    ev(1200, { kind: 'branch', op: 'end', branchId: 'p2' }),
    ev(1290, { kind: 'llm', role: 'aggregate', actor: { tier: 3, name: 'Meristem' }, durationMs: 4000, costUsd: 0.05 }),
  ];
  return {
    id: 'run-fixture',
    label:
      'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend. [build-app]',
    task: {
      description:
        'server.js already exists and serves GET /api/expenses and POST /api/expenses — do not rewrite it. Add the frontend.',
    },
    startedAt: '2026-08-23T10:00:00.000Z',
    endedAt: '2026-08-23T10:21:34.000Z',
    durationMs: 1_293_740,
    events,
    result: { output: { answer: 'The original system has 15 reachable states.\n\nA shortest counterexample takes four transitions. The corrected system has 12 reachable states and preserves the invariant.', conclusion: 'Safety alone does not imply eventual progress without fairness.' }, summary: 'Analysis completed from the supplied transition rules.', producedBy: { tier: 3, name: 'Meristem' } },
    ...(resultArtwork ? {
      label: 'Finalize Pelagic Atlas vector showcase', task: { description: artworkGoal },
      result: { output: { files: artworkFiles,
        probes: [{ cmd: 'python3 verify_artwork.py', exitCode: 0, stdout: 'PASS XML=4 viewBoxes=correct external=none' }] },
        summary: 'The Pelagic Atlas suite contains a coastal habitat plate, three habitat icons and production notes. The SVG files are self-contained and ready to open individually. Labels, legends and connector geometry were checked.' },
    } : {}),
    totals: { calls: 26, inputTokens: 10_181, outputTokens: 80_380, costUsd: 1.69 },
  };
}

/** Prove mobile acknowledgement before provider login or authenticated admission. */
async function captureHandheldGate(page) {
  if (!await page.evaluate(() => matchMedia('(any-pointer: coarse) and (any-hover: none)').matches)) {
    throw new Error('--handheld: touch media query did not match');
  }
  await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'welcome.continue' || entry.id.startsWith('login.provider.')), { timeout: READY_TIMEOUT_MS });
  const stem = outPath.replace(/\.png$/i, '');
  await mkdir(dirname(outPath), { recursive: true });
  await page.screenshot({ path: stem + '-gate.png' });
  const welcome = await page.evaluate(() => {
    const handle = globalThis.__ATOMA_GPU__;
    const row = handle.hitTargets().find(entry => entry.id === 'welcome.continue');
    if (!row || handle.hitTargets().some(entry => entry.id.startsWith('login.provider.'))) {
      throw new Error('Mobile acknowledgement must precede provider login');
    }
    return handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2);
  });
  await page.touchscreen.tap(welcome.x, welcome.y);
  await page.waitForSelector('.gpu-handheld-veil[data-phase="white"]', { timeout: READY_TIMEOUT_MS });
  if (await page.$('.gpu-scene-host')) throw new Error('Mobile notice must unmount the GPU scene');
  if (await page.$('.gpu-handheld-veil__continue')) throw new Error('Mobile Continue appeared before its delay');
  await page.waitForSelector('.gpu-handheld-veil__continue', { timeout: READY_TIMEOUT_MS });
  await page.screenshot({ path: stem + '-notice.png' });
  await page.tap('.gpu-handheld-veil__continue');
  await page.waitForSelector('.gpu-handheld-veil', { hidden: true, timeout: READY_TIMEOUT_MS });
  if (await page.evaluate(() => sessionStorage.getItem('atoma.viz.handheldAccepted')) !== '1') {
    throw new Error('Mobile acknowledgement was not persisted for OAuth');
  }
  // Rebuild the whole app to prove the acknowledgement survives navigation.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'welcome.continue' || entry.id.startsWith('login.provider.')), { timeout: READY_TIMEOUT_MS });
  const target = await page.evaluate(() => {
    const handle = globalThis.__ATOMA_GPU__;
    const row = handle.hitTargets().find(entry => entry.id === 'welcome.continue' || entry.id.startsWith('login.provider.'));
    return { id: row.id, ...handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2) };
  });
  if (target.id.startsWith('login.provider.')) {
    const provider = target.id.slice('login.provider.'.length);
    const href = await page.$eval('.gpu-a11y-bridge a', node => node.getAttribute('href'));
    if (!href || !href.includes(encodeURIComponent(provider))) throw new Error('Missing mobile login link');
    // Stop at the OAuth boundary: this proof must not sign into a real account.
    await page.setRequestInterception(true);
    let reachedLogin = false;
    page.on('request', request => {
      if (request.isInterceptResolutionHandled()) return;
      if (request.isNavigationRequest() && new URL(request.url()).pathname.startsWith('/auth/')) {
        reachedLogin = true;
        void request.respond({ status: 200, contentType: 'text/html', body: '<p>OAuth entry reached</p>' });
      } else { void request.continue().catch(() => {}); }
    });
    await Promise.all([page.waitForNavigation({ timeout: READY_TIMEOUT_MS }), page.touchscreen.tap(target.x, target.y)]);
    if (!reachedLogin) throw new Error('Mobile tap did not reach OAuth');
  } else {
    await page.touchscreen.tap(target.x, target.y);
    await page.waitForSelector('.gpu-app[data-entered="true"]', { timeout: READY_TIMEOUT_MS });
    if (await page.$('.gpu-handheld-veil')) throw new Error('Mobile entry was interrupted');
    await page.waitForSelector('.gpu-project-mcp', { timeout: READY_TIMEOUT_MS });
    await page.screenshot({ path: stem + '-projects.png' });
  }
  console.log('Mobile touch entry passed: ' + target.id);
}

/** Spawn the source dev stack on free ports; resolve when the UI answers. */
async function spawnDevStack() {
  const [devPort, apiPort] = await freePorts(2);
  const script = fileURLToPath(new URL('./viz-dev.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ATOMA_VIZ_DEV_PORT: String(devPort),
      ATOMA_VIZ_API_PORT: String(apiPort),
      // The screenshot session must not arm a sentinel tick or push prompts.
      ATOMA_VIZ_SENTINEL: '0',
    },
  });
  // DRAIN both pipes: an unread pipe fills at ~64KB and then blocks the dev
  // server's writes, which stalls Vite mid-serve with no error anywhere.
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const url = `http://127.0.0.1:${devPort}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error('dev stack never answered on its UI port');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return { url, stop: () => child.kill('SIGTERM') };
}

const attached = arg('--url');
const stack = attached ? { url: attached, stop: () => {} } : await spawnDevStack();

try {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    if (handheld) {
      // A phone: touch is the ONLY pointer, so `(any-pointer: coarse) and
      // (any-hover: none)` must come true from Chrome's own emulation — the
      // gate's predicate is proven, never forced through `?atomaHandheld`.
      await page.setViewport({
        width: has('--width') ? width : 390,
        height: has('--height') ? height : 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });
    } else {
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
    }
    page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
    if (has('--debug')) {
      page.on('console', (message) => console.error(`[console:${message.type()}] ${message.text().slice(0, 200)}`));
      page.on('requestfailed', (request) =>
        console.error(`[requestfailed] ${request.url().slice(0, 140)} ${request.failure()?.errorText ?? ''}`));
      page.on('response', (response) => {
        if (response.status() >= 400) console.error(`[http ${response.status()}] ${response.url().slice(0, 140)}`);
      });

    }

    // A navigation after the first load destroys every evaluation in flight;
    // name it, so "Execution context was destroyed" has a cause.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) console.error(`[navigated] ${frame.url().slice(0, 160)}`);
    });

    if (authed) {
      const stubs = gatedStubs();
      if (assistantLinksProbe) {
        const projectId = stubs['/api/projects'][0].projectId;
        const run = stubs[`/api/projects/${projectId}/runs`][0];
        run.traceId = 'run-fixture';
        const reference = { projectId, runId: run.projectRunId };
        assistantFixture.conversation.proposal = null;
        assistantFixture.conversation.lastRun = reference;
        assistantFixture.run = { status: run.status, costUsd: run.costUsd, traceId: run.traceId, error: null };
        assistantFixture.conversation.messages = [
          { role: 'receipt', text: 'assistant.projectCreated', projectId, at: new Date().toISOString() },
          { role: 'receipt', text: 'assistant.runStarted', run: reference, at: new Date().toISOString() },
        ];
      }
      if (has('--run-picker-probe')) {
        const current = stubs['/api/runs'][0];
        stubs['/api/runs'].push(
          { ...current, id: 'run-earlier', title: 'Earlier project run', startedAt: '2026-08-22T10:00:00.000Z' },
          { ...current, id: 'run-foreign', title: 'Foreign project run', projectId: 'another-project', projectName: 'Another project' }
        );
        stubs['/api/runs/run-earlier'] = { ...stubs['/api/runs/run-fixture'], id: 'run-earlier' };
      }
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        // NEVER let this handler throw: with interception on, a request whose
        // handler died is never continued and the page hangs on it forever.
        try {
          const path = new URL(request.url()).pathname;
          // The assistant card is on every authed Projects shot (2026-10-09).
          if (path === '/api/assistant') {
            void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(assistantFixture) });
            return;
          }
          if (resultArtwork && path.endsWith('/workspace') && new URL(request.url()).searchParams.get('format') === 'bytes') {
            const file = new URL(request.url()).searchParams.get('path');
            if (artworkFiles.includes(file)) {
              void request.respond({ status: 200, contentType: 'application/octet-stream',
                body: file.endsWith('.svg')
                  ? '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#217d9e"/></svg>'
                  : '# Production notes\n\nScreenshot fixture for the result reader.' });
              return;
            }
          }
          if (githubAccessProbe && path.endsWith('/github-access')) {
            const runs = stubs[path.slice(0, path.lastIndexOf('/runs/') + 5)];
            runs[0].githubAccess.resumedRunId = 'eeeeeeee-1111-4222-8333-ffffffffffff';
            void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(runs[0]) });
            return;
          }
          // A selected project asks for its latest delivered run's preview;
          // every run of the fixture project answers with the one preview stub.
          const stub = stubs[path] ?? (/^\/api\/projects\/[^/]+\/runs\/[^/]+\/preview$/.test(path)
            ? stubs[`/api/projects/${path.split('/')[3]}/runs/run-fixture/preview`]
            : undefined);
          if (stub !== undefined) {
            void request.respond({
              status: 200,
              contentType: 'application/json',
              headers: { 'cache-control': 'no-store' },
              body: JSON.stringify(stub),
            });
            return;
          }
        } catch {
          // Fall through to continue().
        }
        void request.continue().catch(() => {});
      });
    }

    // Fresh visitor: clear the persisted arrival flag so behaviour does not
    // depend on what an earlier session on this origin did.
    await page.evaluateOnNewDocument((hidePush) => {
      try {
        localStorage.removeItem('atoma.viz.entered');
        if (hidePush) {
          localStorage.setItem('atoma.viz.push.dismissed', 'screenshot');
          sessionStorage.setItem('atoma.viz.push.dismissed', 'screenshot');
        }
      } catch {
        // Storage is optional; the gate simply shows.
      }
    }, view === 'Settings');
    await page.goto(`${stack.url}/?atomaDiag=1${tuning ? '&atomaTune=1' : ''}`, { waitUntil: 'load' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]', { timeout: READY_TIMEOUT_MS })
      .catch(async (error) => {
        const body = await page
          .evaluate(() => document.body?.innerHTML.slice(0, 600) ?? '<no body>')
          .catch(() => '<page unreachable>');
        throw new Error(`${error.message}\npage body at timeout:\n${body}`);
      });

    if (handheld) {
      // Exercise the real mobile entry control.
      await captureHandheldGate(page);
      await browser.close();
      stack.stop();
      process.exit(0);
    }

    // Pass the arrival gate through the a11y bridge, then wait for the nav.
    await page.waitForFunction(
      () =>
        document.querySelector('.gpu-a11y-bridge [data-release-version]') !== null ||
        document.querySelector('[role="tab"]') !== null,
      { timeout: READY_TIMEOUT_MS }
    );
    const arrival = await page.evaluate(() => {
      if (document.querySelector('[role="tab"]')) return 'entered';
      const bridge = document
        .querySelector('.gpu-a11y-bridge [data-release-version]')
        ?.closest('.gpu-a11y-bridge');
      const control = bridge?.querySelector('button');
      if (!control) {
        // Provider anchors instead of Continue: the instance is GATED and this
        // session is anonymous. That page is itself a valid subject.
        if (bridge?.querySelector('a')) return 'login';
        throw new Error('arrival gate control missing');
      }
      control.click();
      return 'continued';
    });

    if (arrival === 'login') {
      // What a logged-out visitor sees. Nothing to navigate behind it; add
      // --auth to stub a member session and reach the app.
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 800)));
      await mkdir(dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath });
      console.log(`viz screenshot: ${outPath} (login gate — anonymous visitor; use --auth to enter)`);
      await browser.close();
      stack.stop();
      process.exit(0);
    }
    await page.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });

    if (assistantModelProbe) {
      await page.waitForSelector('.gpu-assistant-connection');
      await page.waitForFunction(() => !document.querySelector('.gpu-scene-host')?.inert && document.querySelector('.gpu-scene-camera')?.dataset.sceneCameraMotion === 'settled');
      await page.waitForFunction(() => !document.querySelector('.gpu-entry-veil')?.hasAttribute('data-phase'));
      if (!(await page.$('#assistant-model'))) await page.click('.gpu-assistant-connection button');
      try { await page.waitForSelector('#assistant-model', { visible: true, timeout: 5000 }); }
      catch (error) {
        await page.screenshot({ path: '/tmp/atoma-model-change-failure.png' });
        throw error;
      }
      await page.select('#assistant-model', 'own:anthropic:opus');
      await page.waitForFunction(() => document.querySelector('.gpu-assistant-model-value')?.textContent.includes('Opus'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.gpu-a11y-bridge [data-release-version]');
      await page.evaluate(() => document.querySelector('.gpu-a11y-bridge [data-release-version]').closest('.gpu-a11y-bridge').querySelector('button').click());
      await page.waitForSelector('[role="tab"]', { timeout: READY_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelector('.gpu-assistant-model-value')?.textContent.includes('Opus'));
      if (await page.$('#assistant-model')) throw new Error('The retained model should render as text after reload');
      console.log('Assistant model: an unsent choice survives a full page reload');
    }

    // Open the requested view and let the 560ms view transition finish.
    // Settings is reached from the account menu, not the rail.
    if (view === 'Settings') {
      if (!authed) {
        throw new Error('--view Settings requires --auth (the account menu is gated)');
      }
      await page.waitForFunction(
        () => Boolean(document.querySelector('.gpu-a11y-bridge button[aria-expanded]')),
        { timeout: READY_TIMEOUT_MS }
      );
      await page.evaluate(() => {
        const button = document.querySelector('.gpu-a11y-bridge button[aria-expanded]');
        if (button instanceof HTMLButtonElement) button.click();
      });
      await page.waitForFunction(
        (label) =>
          Array.from(document.querySelectorAll('.gpu-a11y-bridge button')).some(
            (el) => el.textContent?.trim() === label
          ),
        { timeout: READY_TIMEOUT_MS },
        'Settings'
      );
      await page.evaluate((label) => {
        const button = Array.from(document.querySelectorAll('.gpu-a11y-bridge button')).find(
          (el) => el.textContent?.trim() === label
        );
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('Settings menu item missing');
        }
        button.click();
      }, 'Settings');
    } else {
      await page.evaluate((name) => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find(
          (candidate) => candidate.textContent === name
        );
        if (!tab) {
          const names = [...document.querySelectorAll('[role="tab"]')]
            .map((candidate) => candidate.textContent)
            .join(', ');
          throw new Error(`nav tab missing: ${name} (have: ${names})`);
        }
        tab.click();
      }, view);
    }
    await page.waitForFunction(
      (expected) => document.querySelector('[data-viz-live]')?.textContent?.includes(expected),
      { timeout: READY_TIMEOUT_MS },
      view
    );
    if (view === 'Settings') {
      await page.waitForSelector('.gpu-org-models-form', { timeout: READY_TIMEOUT_MS });
      await page.$eval(`#settings-tab-${settingsTab}`, button => button.click());
      await page.waitForSelector(`#settings-tab-${settingsTab}[aria-selected="true"]`);
      if (platformAdmin) await page.waitForSelector('[id^="platform-limit-"]');
      const geometry = await page.evaluate(() => {
        const body = document.querySelector('.gpu-org-models-form');
        const tabs = body.querySelector('[role="tablist"]');
        const panels = [...body.querySelectorAll('[role="tabpanel"]')].filter(panel => panel.checkVisibility());
        const panel = panels[0];
        const bounds = body.getBoundingClientRect();
        return {
          bodies: document.querySelectorAll('.gpu-org-models-form').length,
          panels: panels.length,
          belowTabs: panel?.getBoundingClientRect().top >= tabs.getBoundingClientRect().bottom,
          fieldsContained: [...panel.querySelectorAll('input')].every(input => {
            const rect = input.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right;
          }),
        };
      });
      if (geometry.bodies !== 1 || geometry.panels !== 1 || !geometry.belowTabs || !geometry.fieldsContained) {
        throw new Error(`Settings layout overlaps: ${JSON.stringify(geometry)}`);
      }
      console.log(`viz settings layout ok: ${settingsTab}, ${width}x${height}`);
    }
    await page.waitForFunction(
      () => document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-motion') === 'settled',
      { timeout: READY_TIMEOUT_MS }
    );

    if (cameraMode === 'overview') {
      if (view === 'Settings') {
        throw new Error('--camera overview re-activates a nav tab; Settings has none');
      }
      // A second activation of the CURRENT destination is the camera return;
      // use the same menu contract as the product instead of mutating state.
      await page.evaluate((name) => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find(
          (candidate) => candidate.textContent === name
        );
        if (!(tab instanceof HTMLButtonElement)) throw new Error(`nav tab missing: ${name}`);
        tab.click();
      }, view);
      await page.waitForFunction(
        () => {
          const plane = document.querySelector('.gpu-scene-camera');
          return plane?.getAttribute('data-scene-camera-mode') === 'overview' &&
            plane.getAttribute('data-scene-camera-motion') === 'settled';
        },
        { timeout: READY_TIMEOUT_MS }
      );
    }
    await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 700)));

    if (scrollEnd) {
      if (view !== 'Settings') {
        throw new Error('--scroll-end is for Settings (the org-models body form)');
      }
      await page.evaluate(() => {
        const form = document.querySelector('.gpu-org-models-form');
        if (form) form.scrollTop = form.scrollHeight;
      });
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 200)));
    }

    if (selectFirst) {
      const prefix = view === 'Skills' ? 'skill.select.' : view === 'Registry' ? 'registry.atom.' : 'project.select.';
      await page.waitForFunction((key) => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id.startsWith(key)), { timeout: READY_TIMEOUT_MS }, prefix);
      const spot = await page.evaluate((key) => {
        const handle = globalThis.__ATOMA_GPU__;
        const row = handle?.hitTargets().find((entry) => entry.id.startsWith(key));
        if (!row || !handle.projectRendererPoint) return null;
        // On the row's name, never its centre: a project row carries its
        // repository link on the right, and a click there leaves the page.
        return handle.projectRendererPoint(
          row.x + Math.min(row.width / 2, 160),
          row.y + row.height / 2
        );
      }, prefix);
      if (!spot) throw new Error('--select-first: no selectable row on screen');
      await page.mouse.click(spot.x, spot.y);
      if (view === 'Projects') {
        await page.waitForFunction(() => {
          const plane = document.querySelector('.gpu-scene-camera');
          return plane?.getAttribute('data-scene-camera-mode') === 'focus' &&
            plane.getAttribute('data-scene-camera-motion') === 'settled';
        }, { timeout: READY_TIMEOUT_MS });
      }
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 800)));
    }

    if (view === 'Projects' && selectFirst && (githubAccessProbe || has('--github-access') || showResult || has('--touch-probe'))) {
      await page.$eval('#project-tab-runs', tab => tab.click());
      await page.waitForFunction(() => document.querySelector('.gpu-project-mcp')?.hidden);
    }
    if (githubAccessProbe) {
      const id = 'project.githubContinue.cccccccc-1111-4222-8333-dddddddddd10';
      for (let attempt = 0; attempt < 4; attempt++) {
        const spot = await page.evaluate(targetId => {
          const handle = globalThis.__ATOMA_GPU__;
          const row = handle.hitTargets().find(entry => entry.id === targetId);
          const p = handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2);
          return { ...p, h: globalThis.innerHeight };
        }, id);
        if (spot.y < spot.h - 50) { await page.mouse.click(spot.x, spot.y); break; }
        await page.mouse.move(spot.x, spot.h - 100);
        await page.mouse.wheel({ deltaY: 180 });
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
      }
      await page.waitForFunction(targetId => !globalThis.__ATOMA_GPU__.hitTargets().some(entry => entry.id === targetId), { timeout: READY_TIMEOUT_MS }, id);
      console.log('GitHub recovery canvas continuation passed');
    }
    if (showActivity || activityFile) {
      if (view !== 'Runs') throw new Error('--activity requires --view Runs');
      const clickActivity = async (id) => {
        await page.waitForFunction(targetId => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === targetId), { timeout: READY_TIMEOUT_MS }, id);
        const point = await page.evaluate(async targetId => {
          // Layout publishes targets before Pixi paints their world transforms.
          for (let frame = 0; frame < 2; frame++) await new Promise(resolveWait => requestAnimationFrame(resolveWait));
          const handle = globalThis.__ATOMA_GPU__;
          const target = handle.hitTargets().find(entry => entry.id === targetId);
          return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
        }, id);
        await page.mouse.click(point.x, point.y);
      };
      await clickActivity('activity.open');
      await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'activity.close'), { timeout: READY_TIMEOUT_MS });
      if (activityFile) {
        // The file list is below the phases on a phone. Scroll the same pane the viewer uses.
        for (let attempt = 0; attempt < 12; attempt++) {
          const visible = await page.evaluate(id => {
            const handle = globalThis.__ATOMA_GPU__;
            const target = handle.hitTargets().find(entry => entry.id === id);
            return target && target.y > 100 && target.y + target.height < innerHeight;
          }, `activity.file.${encodeURIComponent(activityFile)}`);
          if (visible) break;
          await page.mouse.move(width * 0.75, height * 0.7);
          await page.mouse.wheel({ deltaY: 250 });
          await page.evaluate(() => new Promise(resolveWait => setTimeout(resolveWait, 100)));
        }
        await clickActivity(`activity.file.${encodeURIComponent(activityFile)}`);
        await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'activity.files'), { timeout: READY_TIMEOUT_MS });
      }
      await page.mouse.move(5, height - 5);
      await page.evaluate(() => new Promise(resolveWait => setTimeout(resolveWait, 300)));
    }

    if (showResult) {
      await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id.startsWith('result.open.')), { timeout: READY_TIMEOUT_MS });
      const spot = await page.evaluate(() => {
        const handle = globalThis.__ATOMA_GPU__;
        const target = handle.hitTargets().find(entry => entry.id.startsWith('result.open.'));
        return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
      });
      await page.mouse.click(spot.x, spot.y);
      await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'result.details'), { timeout: READY_TIMEOUT_MS });
      // Drive both directions through the actual canvas, starting from a fresh page.
      if (await page.evaluate(() => globalThis.__ATOMA_GPU__.hitTargets().some(entry => entry.id === 'result.download'))) {
        throw new Error('Result technical data must start collapsed');
      }
      const toggleDetails = async () => {
        // Hit targets are published before Pixi updates the transforms used
        // for pointer dispatch. Wait for its next screen render before clicking.
        await page.evaluate(() => new Promise(resolveWait => {
          const { app } = globalThis.__ATOMA_GPU__;
          const observer = { postrender(options) {
            if (options.container !== app.stage || options.target !== app.renderer.view.renderTarget) return;
            app.renderer.runners.postrender.remove(observer);
            resolveWait();
          } };
          app.renderer.runners.postrender.add(observer);
        }));
        const point = await page.evaluate(() => {
          const handle = globalThis.__ATOMA_GPU__;
          const target = handle.hitTargets().find(entry => entry.id === 'result.details');
          return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
        });
        await page.mouse.click(point.x, point.y);
      };
      await toggleDetails();
      await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'result.download'), { timeout: READY_TIMEOUT_MS });
      await toggleDetails();
      await page.waitForFunction(() => !globalThis.__ATOMA_GPU__?.hitTargets().some(entry => entry.id === 'result.download'), { timeout: READY_TIMEOUT_MS }).catch(async error => {
        await page.screenshot({ path: '/tmp/atoma-result-toggle-failure.png' });
        throw error;
      });
      if (resultArtwork) {
        await page.evaluate(() => new Promise(resolveWait => requestAnimationFrame(() => requestAnimationFrame(resolveWait))));
        const filePoint = await page.evaluate(() => {
          const handle = globalThis.__ATOMA_GPU__;
          const target = handle.hitTargets().find(entry => entry.id === 'result.file.coastal_plate.svg');
          return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
        });
        await page.mouse.click(filePoint.x, filePoint.y);
        await page.waitForFunction(() => {
          const img = document.querySelector('iframe[title="coastal_plate.svg"]')?.contentDocument?.querySelector('img');
          return img?.complete && img.naturalWidth > 0;
        }, { timeout: READY_TIMEOUT_MS });
        await page.waitForSelector('.gpu-preview-actions a[download="coastal_plate.svg"]');
        await page.click('.gpu-preview-actions button');
        await page.waitForFunction(() => !document.querySelector('.gpu-preview-backdrop'));
        console.log('Result canvas controls passed: expand, collapse, open SVG, download available, close preview');
      }
      await page.mouse.move(5, height - 5);
      await page.evaluate(() => new Promise(resolveWait => setTimeout(resolveWait, 500)));
    }

    if (showAssistant) {
      if (!authed || view !== 'Projects') throw new Error('--assistant requires --auth and Projects');
      // The conversation lives inside the project guide card (2026-10-09).
      if (!(await page.$('.gpu-project-mcp--assistant .gpu-assistant'))) throw new Error('The integrated assistant is missing from the guide');
      try { await page.waitForSelector(assistantReconnect ? '.gpu-assistant-setup' : assistantEmpty ? '.gpu-project-mcp--assistant-compact .gpu-assistant-empty' : assistantHistory ? '.gpu-assistant-message--assistant' : assistantLinksProbe ? '.gpu-assistant-message--receipt' : '.gpu-assistant-proposal', { timeout: 10_000 }); }
      catch (error) { await page.screenshot({ path: '/tmp/atoma-assistant-failure.png' }); throw error; }
      await page.evaluate(() => {
        const log = document.querySelector('.gpu-assistant-log');
        if (log) log.scrollTop = log.scrollHeight;
      });
      // The composer stays inside the guide card that hosts it, on screen.
      const composerVisible = await page.evaluate(() => {
        const button = document.querySelector('.gpu-assistant button[type="submit"]');
        const box = button?.getBoundingClientRect();
        const guide = document.querySelector('.gpu-project-mcp--assistant')?.getBoundingClientRect();
        return box && guide &&
          box.top >= guide.top && box.bottom <= guide.bottom + 1 && box.left >= guide.left && box.right <= guide.right + 1 &&
          box.bottom <= globalThis.innerHeight;
      });
      if (!composerVisible) {
        const diagnostic = await page.evaluate(() => {
          const rect = (selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) } : null; };
          return { submit: rect('.gpu-assistant button[type="submit"]'), guide: rect('.gpu-project-mcp--assistant'), viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight } };
        });
        await page.screenshot({ path: '/tmp/atoma-assistant-failure.png' });
        throw new Error(`The assistant composer is outside its host card: ${JSON.stringify(diagnostic)}`);
      }
      if (assistantHistory) {
        const layout = await page.evaluate(() => {
          const header = document.querySelector('.gpu-assistant-header h2')?.getBoundingClientRect();
          const model = document.querySelector('.gpu-assistant-connection').getBoundingClientRect();
          const user = globalThis.getComputedStyle(document.querySelector('.gpu-assistant-message--user'));
          const assistant = globalThis.getComputedStyle(document.querySelector('.gpu-assistant-message--assistant'));
          const guide = document.querySelector('.gpu-project-mcp').getBoundingClientRect();
          return { headerTop: header?.top, headerBottom: header?.bottom, modelTop: model.top, modelBottom: model.bottom,
            userBorder: user.borderLeftWidth, assistantBorder: assistant.borderLeftWidth,
            userColor: user.borderLeftColor, assistantColor: assistant.borderLeftColor, bottomGap: innerHeight - guide.bottom };
        });
        if (width >= 1100 && layout.headerTop !== undefined && (layout.headerBottom <= layout.modelTop || layout.modelBottom <= layout.headerTop)) {
          throw new Error(`The model did not share the heading row: ${JSON.stringify(layout)}`);
        }
        if (layout.userBorder !== '2px' || layout.assistantBorder !== '2px' || layout.userColor === layout.assistantColor) {
          throw new Error(`Speakers need consistent, distinct borders: ${JSON.stringify(layout)}`);
        }
        if (assistantNoRuns && selectFirst && cameraMode === 'overview' && height >= 800 && layout.bottomGap > 140) {
          throw new Error(`Unused space remains below the conversation: ${JSON.stringify(layout)}`);
        }
        console.log('Assistant layout: shared heading, distinct speaker borders, available height used');
        const markdown = await page.evaluate(() => {
          const prose = document.querySelector('.gpu-assistant-message--assistant:last-child .gpu-assistant-markdown');
          const log = document.querySelector('.gpu-assistant-log');
          return { heading: prose?.querySelector('h2')?.textContent,
            strong: prose?.querySelector('strong')?.textContent, items: prose?.querySelectorAll('li').length,
            quote: Boolean(prose?.querySelector('blockquote')), code: Boolean(prose?.querySelector('pre code')),
            table: Boolean(prose?.querySelector('table')), link: prose?.querySelector('a')?.getAttribute('href'),
            overflow: log.scrollWidth - log.clientWidth,
            boundedBlocks: Array.from(prose?.querySelectorAll('pre, table') ?? []).every(block =>
              block.getBoundingClientRect().right <= prose.getBoundingClientRect().right + 1) };
        });
        if (markdown.heading !== 'Proposed goal' || markdown.strong !== 'stock alerts' || markdown.items !== 2 ||
          !markdown.quote || !markdown.code || !markdown.table || markdown.link !== 'https://example.com/stock-tracker' ||
          markdown.overflow > 1 || !markdown.boundedBlocks) {
          throw new Error(`Assistant Markdown did not render or overflowed its conversation: ${JSON.stringify(markdown)}`);
        }
        console.log('Assistant Markdown: headings, emphasis, lists, quote, code, table and link; no horizontal overflow');
      }
      if (assistantEmpty) {
        const spacing = await page.evaluate(() => {
          const hintNode = document.querySelector('.gpu-assistant-empty');
          const hint = hintNode.getBoundingClientRect();
          const composer = document.querySelector(hintNode.tagName === 'LABEL' ? '#assistant-message' : '.gpu-assistant form').getBoundingClientRect();
          const guideNode = document.querySelector('.gpu-project-mcp--assistant');
          const guide = guideNode.getBoundingClientRect();
          const summary = document.querySelector('.gpu-project-mcp-own-agent > summary').getBoundingClientRect();
          return { gap: composer.top - hint.bottom, guideBottom: guide.bottom, summaryBottom: summary.bottom,
            bottomGap: (guide.bottom - summary.bottom) / (guide.height / guideNode.offsetHeight) };
        });
        if (spacing.gap > 16 || spacing.gap < 0 || spacing.summaryBottom > spacing.guideBottom || spacing.bottomGap > 20) {
          throw new Error(`Empty conversation has wasted space or clipped controls: ${JSON.stringify(spacing)}`);
        }
        console.log('Empty conversation: compact card, hint adjacent to composer, external-agent entry visible');
      }
      if (assistantOwnAgent) {
        if (await page.$('#assistant-model')) await page.select('#assistant-model', 'own:anthropic:haiku');
        await page.type('#assistant-message', 'Preserve this draft while connecting my agent');
        const summary = '.gpu-project-mcp-own-agent > summary';
        await page.click(summary);
        await page.waitForFunction(() => document.querySelector('.gpu-assistant-conversation')?.hidden &&
          document.querySelector('.gpu-project-mcp--assistant-compact'));
        const guideLayout = await page.evaluate(() => {
          const details = document.querySelector('.gpu-project-mcp-own-agent');
          const box = details.getBoundingClientRect();
          const guide = document.querySelector('.gpu-project-mcp--assistant');
          const card = guide.getBoundingClientRect();
          const minimumHeight = guide.clientHeight - document.querySelector('.gpu-assistant-header').offsetHeight - 44;
          return { height: details.clientHeight, minimumHeight, top: box.top, bottom: box.bottom, cardTop: card.top, cardBottom: card.bottom };
        });
        if (guideLayout.height < guideLayout.minimumHeight || guideLayout.top < guideLayout.cardTop || guideLayout.bottom > guideLayout.cardBottom + 1) {
          throw new Error(`External guide is squeezed or clipped: ${JSON.stringify(guideLayout)}`);
        }
        await browser.defaultBrowserContext().overridePermissions(new URL(stack.url).origin, ['clipboard-read', 'clipboard-sanitized-write']);
        const copyButton = '.gpu-project-mcp-actions button';
        const copyReachable = await page.$eval(copyButton, node => {
          node.scrollIntoView({ block: 'nearest' });
          const box = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        });
        if (!copyReachable) throw new Error('The external guide copy action is clipped or covered');
        await page.click(copyButton);
        try {
          await page.waitForSelector('.gpu-project-mcp-own-agent [role="status"]', { timeout: 5000 });
          const status = await page.$eval('.gpu-project-mcp-own-agent [role="status"]', node => node.textContent);
          if (!status.includes('Copied')) throw new Error(`Copy request failed: ${status}`);
        } catch (error) {
          await page.screenshot({ path: '/tmp/atoma-assistant-copy-failure.png' });
          throw error;
        }
        await page.$eval('.gpu-project-mcp-own-agent', node => { node.scrollTop = 0; });
        // Exercise the return through the native disclosure, including draft preservation.
        await page.click(summary);
        await page.waitForFunction(() => !document.querySelector('.gpu-assistant-conversation')?.hidden);
        if (await page.$eval('#assistant-message', node => node.value) !== 'Preserve this draft while connecting my agent') {
          throw new Error('Switching back from the external guide lost the draft');
        }
        // Capture the open guide, with its last action scrolled into reach.
        await page.click(summary);
        await page.waitForFunction(() => document.querySelector('.gpu-assistant-conversation')?.hidden);
        await page.$eval('.gpu-project-mcp-actions button', node => node.scrollIntoView({ block: 'nearest' }));
        console.log('External guide: full card, copy action works, return preserves the draft');
      }
    }

    if (assistantLinksProbe) {
      const clickReceipt = async label => {
        const button = await page.evaluateHandle(text => [...document.querySelectorAll('.gpu-assistant-message-actions button')]
          .find(node => node.textContent.trim() === text), label);
        await button.asElement().click();
        await button.dispose();
      };
      const buttons = await page.$$eval('.gpu-assistant-message-actions button', nodes => nodes.map(node => ({
        label: node.textContent.trim(), height: node.offsetHeight, icon: !!node.querySelector('svg[aria-hidden="true"]'),
      })));
      if (buttons.length !== 2 || buttons.some(button => button.height < 24 || button.height > 28 || !button.icon)) {
        throw new Error(`Receipt buttons are not compact and labelled: ${JSON.stringify(buttons)}`);
      }
      await page.type('#assistant-message', 'Keep this draft while opening the project');
      await clickReceipt('Open project');
      await page.waitForFunction(() => document.querySelector('#project-tab-runs')?.getAttribute('aria-selected') === 'true' &&
        document.querySelector('.gpu-project-mcp')?.hidden && globalThis.__ATOMA_GPU__.hitTargets().some(target => target.id.startsWith('project.run.')))
        .catch(async error => {
          await page.screenshot({ path: outPath.replace(/\.png$/, '-failure.png') });
          throw new Error(JSON.stringify(await page.evaluate(() => ({
            tabs: [...document.querySelectorAll('[role="tab"]')].map(node => [node.id, node.getAttribute('aria-selected')]),
            guideHidden: document.querySelector('.gpu-project-mcp')?.hidden,
            targets: globalThis.__ATOMA_GPU__.hitTargets().map(target => target.id),
          }))), { cause: error });
        });
      const point = await page.evaluate(async () => {
        await new Promise(resolveWait => requestAnimationFrame(() => requestAnimationFrame(resolveWait)));
        const handle = globalThis.__ATOMA_GPU__;
        const tab = handle.hitTargets().find(target => target.id === 'project.section.conversation');
        return handle.projectRendererPoint(tab.x + tab.width / 2, tab.y + tab.height / 2);
      });
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => !document.querySelector('.gpu-project-mcp')?.hidden)
        .catch(async error => { await page.screenshot({ path: outPath.replace(/\.png$/, '-return-failure.png') }); throw error; });
      if (await page.$eval('#assistant-message', node => node.value) !== 'Keep this draft while opening the project') {
        throw new Error('Opening the current project discarded the conversation draft');
      }
      await page.screenshot({ path: outPath.replace(/\.png$/, '-chat.png') });
      await clickReceipt('Open run');
      await page.waitForFunction(() => document.querySelector('[data-viz-live]')?.textContent?.startsWith('Runs —'));
      console.log(`Assistant links: current project opens its Runs tab, draft retained, Open run opens the trace; buttons ${JSON.stringify(buttons)}`);
    }

    if (projectTabsProbe) {
      if (!selectFirst || !showAssistant || assistantOwnAgent) throw new Error('--project-tabs-probe needs a selected project conversation');
      const clickSection = async section => {
        const point = await page.evaluate(async id => {
          await new Promise(resolveWait => requestAnimationFrame(() => requestAnimationFrame(resolveWait)));
          const handle = globalThis.__ATOMA_GPU__;
          const target = handle.hitTargets().find(entry => entry.id === id);
          if (!target) throw new Error(`Project tab is missing: ${id}`);
          return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
        }, `project.section.${section}`);
        await page.mouse.click(point.x, point.y);
      };
      if (await page.$('#assistant-model')) await page.select('#assistant-model', 'own:anthropic:haiku');
      await page.type('#assistant-message', 'Keep this draft between tabs');
      if (await page.evaluate(() => globalThis.__ATOMA_GPU__.hitTargets().some(target => target.id.startsWith('project.run.')))) {
        throw new Error('Run cards still appear below the conversation');
      }
      await clickSection('runs');
      await page.waitForFunction(() => document.querySelector('.gpu-project-mcp')?.hidden);
      if (!assistantNoRuns) await page.waitForFunction(() => globalThis.__ATOMA_GPU__.hitTargets().some(target => target.id.startsWith('project.run.')));
      await page.screenshot({ path: outPath.replace(/\.png$/, '-runs.png') });
      await clickSection('conversation');
      await page.waitForFunction(() => !document.querySelector('.gpu-project-mcp')?.hidden);
      if (await page.$eval('#assistant-message', node => node.value) !== 'Keep this draft between tabs') throw new Error('Changing project tabs lost the draft');
      await page.$eval('#assistant-message', node => { node.focus(); node.select(); });
      await page.keyboard.press('Backspace');
      console.log('Project tabs: real canvas switches, separate run list, conversation draft retained');
    }

    if (accountMenu) {
      if (!authed) throw new Error('--account-menu needs --auth: the orb exists with an account');
      const orb = await page.evaluate(() => {
        const handle = globalThis.__ATOMA_GPU__;
        const target = handle?.hitTargets().find((entry) => entry.id === 'account.menu.toggle');
        if (!target || !handle.projectRendererPoint) return null;
        return handle.projectRendererPoint(
          target.x + target.width / 2,
          target.y + target.height / 2
        );
      });
      if (!orb) throw new Error('--account-menu: no profile orb on screen');
      await page.mouse.click(orb.x, orb.y);
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 500)));
    }

    if (appearanceTheme || showThemeMenu) {
      if (!authed) throw new Error('--appearance and --theme-menu need --auth');
      if (appearanceTheme && !['nocturne', 'aurora', 'amethyst', 'copper', 'snow'].includes(appearanceTheme)) {
        throw new Error(`Unknown appearance theme: ${appearanceTheme}`);
      }
      await page.evaluate((theme) => {
        const dispatch = globalThis.__ATOMA_VIZ_TEST__?.dispatch;
        if (!dispatch) throw new Error('appearance controls are unavailable');
        if (theme) dispatch(`appearance.select.${theme}`);
      }, appearanceTheme);
      if (appearanceTheme) {
        if (appearanceRevealMs === null) {
          await page.waitForFunction((theme) => {
            const app = document.querySelector('.gpu-app');
            return app?.getAttribute('data-theme') === theme &&
              app.getAttribute('data-theme-transition') === 'idle';
          }, { timeout: READY_TIMEOUT_MS }, appearanceTheme);
        } else {
          await page.waitForFunction((theme) => {
            const app = document.querySelector('.gpu-app');
            return app?.getAttribute('data-theme') === theme &&
              app.getAttribute('data-theme-transition') === 'reveal';
          }, { timeout: READY_TIMEOUT_MS }, appearanceTheme);
          await page.evaluate((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)), appearanceRevealMs);
        }
      }
      if (showThemeMenu) {
        const controlPoint = (id) => page.evaluate((targetId) => {
          const handle = globalThis.__ATOMA_GPU__;
          const target = handle?.hitTargets().find((entry) => entry.id === targetId);
          if (!target || !handle.projectRendererPoint) return null;
          return handle.projectRendererPoint(
            target.x + target.width / 2,
            target.y + target.height / 2
          );
        }, id);
        let palette = await controlPoint('appearance.dropdown.toggle');
        if (!palette) {
          const account = await controlPoint('account.menu.toggle');
          if (account) await page.mouse.click(account.x, account.y);
          palette = await controlPoint('appearance.dropdown.toggle');
        }
        if (!palette) throw new Error('--theme-menu: no visible theme control');
        await page.mouse.click(palette.x, palette.y);
        await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 400)));
        await page.waitForFunction(() =>
          globalThis.__ATOMA_GPU__?.hitTargets().some((entry) => entry.id === 'appearance.select.amethyst'),
        { timeout: READY_TIMEOUT_MS });
      }
      if (appearanceRevealMs === null) {
        await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 150)));
      }
    }

    if (notifications) {
      if (!authed) throw new Error('--notifications needs --auth: the bell exists with an account');
      const bell = await page.evaluate(() => {
        const handle = globalThis.__ATOMA_GPU__;
        const target = handle?.hitTargets().find((entry) => entry.id === 'notifications.menu.toggle');
        if (!target || !handle.projectRendererPoint) return null;
        return handle.projectRendererPoint(
          target.x + target.width / 2,
          target.y + target.height / 2
        );
      });
      if (!bell) throw new Error('--notifications: no bell on screen');
      await page.mouse.click(bell.x, bell.y);
      // One beat for the stubbed fetch and the overlay rebuild.
      await page.evaluate(() => new Promise((resolveWait) => setTimeout(resolveWait, 800)));
    }

    await mkdir(dirname(outPath), { recursive: true });
    if (has('--run-picker-probe')) {
      if (!authed || view !== 'Runs') throw new Error('--run-picker-probe requires --auth --view Runs');
      await page.click('.gpu-run-input');
      const waitForRuns = ids => page.waitForFunction(expected => {
        const actual = globalThis.__ATOMA_GPU__.hitTargets()
          .filter(target => target.id.startsWith('run.select.')).map(target => target.id.slice(11)).sort();
        return JSON.stringify(actual) === JSON.stringify([...expected].sort());
      }, { timeout: READY_TIMEOUT_MS }, ids);
      await waitForRuns(['run-fixture', 'run-earlier']);
      const placeholder = await page.$eval('.gpu-run-input', input => input.placeholder);
      if (placeholder !== 'Search 2 runs…') throw new Error(`Unscoped run count: ${placeholder}`);
      await page.type('.gpu-run-input', 'Foreign');
      await waitForRuns([]);
      await page.keyboard.press('Escape');
      await page.click('.gpu-run-input');
      await page.type('.gpu-run-input', 'Earlier');
      await waitForRuns(['run-earlier']);
      const point = await page.evaluate(async () => {
        for (let frame = 0; frame < 2; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
        const handle = globalThis.__ATOMA_GPU__;
        const target = handle.hitTargets().find(entry => entry.id === 'run.select.run-earlier');
        return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
      });
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => document.querySelector('.gpu-run-input')?.value === 'Earlier project run',
        { timeout: READY_TIMEOUT_MS });
      await page.click('.gpu-run-input');
      await waitForRuns(['run-fixture', 'run-earlier']);
      console.log('viz run picker ok: project scope, search, count and canvas selection');
    }
    if (has('--timeline-probe')) {
      if (view !== 'Runs') throw new Error('--timeline-probe requires --view Runs');
      await assertTimelineMinimap(page, { leaveHovered: true });
    }
    if (has('--touch-probe')) {
      if (!authed || !selectFirst || view !== 'Projects') {
        throw new Error('--touch-probe requires --auth --select-first and the Projects view');
      }
      await assertMobileProjects(page, gatedStubs()['/api/projects'][0].projectId);
    }
    await page.screenshot({ path: outPath });
    const capturedViewport = page.viewport();
    const capturedCameraMode = await page.evaluate(() => document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-mode') ?? 'none');
    console.log(`viz screenshot: ${outPath} (${view}, ${authed ? 'gated' : 'ungated'}, camera ${capturedCameraMode}${selectFirst ? ', first row selected' : ''}${notifications ? ', notification tray open' : ''}${accountMenu ? ', account menu open' : ''}, ${capturedViewport.width}x${capturedViewport.height})`);
  } finally {
    await browser.close();
  }
} finally {
  stack.stop();
}
