import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../src/auth/store.js';
import type { ArtifactManifest } from '../src/contracts/projects.js';
import type { RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { ProjectStore } from '../src/projects/store.js';
import {
  buildShowcase,
  classifyShowcase,
  createShowcaseSource,
  servesShowcaseHome,
  titleFromGoal,
  SHOWCASE_TTL_MS,
} from '../src/viz/showcase.js';
import { renderShowcaseEntry, renderShowcaseIndex, SHOWCASE_SECURITY_HEADERS } from '../src/viz/showcasePage.js';

/**
 * THE PUBLIC SHOWCASE: who may be shown, what a visitor may read, and that the
 * real server serves it without a session and only when the host asked.
 */

vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  closeStoreHandles();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve)));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STATS: RunStats = {
  outcome: 'delivered', costUsd: 0.3, llmCalls: 10, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, otherCalls: 10,
  deterministicPhases: 0, deepenings: 0, rootRemediations: 0, landingReasons: [], escalations: 0, learnedSkills: 0,
  learnedEventSkills: 0, promotions: 0, refusals: 0, compileErrors: 0, demotions: 0, dispatchFallbacks: 0,
  uncoveredObligations: 0,
};

function manifestOf(files: readonly string[], delivery?: 'text'): ArtifactManifest {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  return {
    version: 1,
    source: 'workspace',
    ...(delivery ? { delivery } : {}),
    files: sorted.map((path) => ({
      path, size: 100, sha256: createHash('sha256').update(path).digest('hex'), mode: '100644' as const,
    })),
    totalBytes: sorted.length * 100,
  };
}

interface World {
  readonly root: string;
  readonly dbPath: string;
  readonly store: ProjectStore;
  readonly admin: { orgId: string; principalId: string; projectId: string };
  readonly member: { orgId: string; principalId: string; projectId: string };
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'atoma-showcase-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const store = ProjectStore.open(dbPath);
  const people = (['admin', 'member'] as const).map((name) => {
    const login = auth.completeLogin(
      { provider: 'github', subject: name, displayName: name, email: null, emailVerified: false },
      null
    );
    if (!login) throw new Error('bootstrap failed');
    const project = store.createProject({
      orgId: login.viewer.orgId,
      principalId: login.viewer.principalId,
      project: {
        name: `Secret ${name} project`,
        slug: `secret-${name}`,
        initialPrompt: 'x',
        repositoryTarget: { installationId: '123', owner: `secret-owner-${name}`, name: `secret-repo-${name}`, visibility: 'private' },
      },
    });
    return { orgId: login.viewer.orgId, principalId: login.viewer.principalId, projectId: project.projectId };
  });
  auth.grantPlatformAdmin(people[0]!.principalId);
  return { root, dbPath, store, admin: people[0]!, member: people[1]! };
}

/** One run of `who`, ended as `outcome`, with a trace file when `answer` is given. */
function seedRun(
  w: World,
  who: World['admin'],
  input: {
    goal: string;
    title?: string;
    files?: readonly string[];
    delivery?: 'text';
    outcome?: 'delivered' | 'failed' | 'partial';
    remediations?: number;
    answer?: string;
    at?: string;
  }
): string {
  const projectRunId = randomUUID();
  const base = join(w.root, 'runs', projectRunId);
  const created = w.store.createProjectRun({
    orgId: who.orgId,
    principalId: who.principalId,
    projectId: who.projectId,
    projectRunId,
    request: { idempotencyKey: `k-${projectRunId}`, goal: input.goal },
    hostPaths: {
      workspacePath: join(base, 'workspace'),
      runsPath: join(base, 'traces'),
      logPath: join(base, 'run.log'),
    },
  });
  if (!created) throw new Error('create refused');
  w.store.transitionProjectRun({ orgId: who.orgId, projectRunId, from: 'queued', to: 'running' });
  const outcome = input.outcome ?? 'delivered';
  const stats = { ...STATS, outcome, rootRemediations: input.remediations ?? 0 };
  if (outcome === 'failed') {
    w.store.transitionProjectRun({ orgId: who.orgId, projectRunId, from: 'running', to: 'failed', error: 'boom', stats });
  } else {
    if (input.answer !== undefined) {
      mkdirSync(join(base, 'traces'), { recursive: true });
      writeFileSync(
        join(base, 'traces', `${projectRunId}.json`),
        JSON.stringify({ id: projectRunId, endedAt: new Date().toISOString(), result: { output: input.answer } })
      );
    }
    w.store.completeProjectRun({
      orgId: who.orgId, projectRunId, traceId: projectRunId, stats,
      manifest: manifestOf(input.files ?? [], input.delivery),
      ...(outcome === 'partial' ? { to: 'partial' as const, error: 'partial' } : {}),
    });
  }
  if (input.title) {
    w.store.recordRunTitle({
      orgId: who.orgId, projectRunId, title: input.title,
      receipt: { model: 'api:zai:x', inputTokens: 1, outputTokens: 1, costUsd: 0, generatedAt: new Date().toISOString() },
    });
  }
  return projectRunId;
}

describe('who may be shown', () => {
  it('is exactly the delivered runs of a platform admin', () => {
    const w = world();
    const shown = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    seedRun(w, w.admin, { goal: 'Admin failed', outcome: 'failed' });
    seedRun(w, w.admin, { goal: 'Admin partial', outcome: 'partial', files: ['a.md'] });
    seedRun(w, w.member, { goal: 'Member delivered, not an admin', files: ['README.md'] });
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([shown]);
  });

  it('follows the admin flag at read time, and answers nothing without an auth table', () => {
    const w = world();
    seedRun(w, w.member, { goal: 'Member run', files: ['README.md'] });
    expect(w.store.listShowcaseRuns()).toEqual([]);
    closeStoreHandles();
    const bare = ProjectStore.open(join(w.root, 'other.db'));
    expect(bare.listShowcaseRuns()).toEqual([]);
  });
});

describe('classification and grouping', () => {
  const kind = (files: readonly string[], delivery?: 'text') =>
    classifyShowcase({ artifactManifest: manifestOf(files, delivery) });

  it('reads the kind from the deliverable alone', () => {
    expect(kind([], 'text')).toBe('answers');
    expect(kind(['index.html', 'README.md'])).toBe('software');
    expect(kind(['server.js', 'README.md'])).toBe('software');
    expect(kind(['sos.wav', 'verify_sos.py'])).toBe('media');
    expect(kind(['plate.svg', 'verify_geometry.py'])).toBe('media');
    expect(kind(['report.md', 'summary.csv'])).toBe('reports');
    expect(classifyShowcase({ artifactManifest: null })).toBe('answers');
  });

  it('cuts an unnamed goal to one short line', () => {
    expect(titleFromGoal('  A  short\n goal ')).toBe('A short goal');
    const long = titleFromGoal('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('groups a project\'s runs into one entry anchored on its first run', () => {
    const w = world();
    const first = seedRun(w, w.admin, { goal: 'Build a guestbook', title: 'A guestbook', files: ['index.html'] });
    const second = seedRun(w, w.admin, { goal: 'Add delete', title: 'Delete messages', files: ['index.html'], remediations: 1 });
    const entries = buildShowcase(w.store.listShowcaseRuns());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(first);
    expect(entries[0]!.episodes.map((episode) => episode.id)).toEqual([first, second]);
    expect(entries[0]!.episodes.map((episode) => episode.title)).toEqual(['A guestbook', 'Delete messages']);
    expect(entries[0]!.episodes[1]!.sentBack).toBe(1);
    expect(entries[0]!.kind).toBe('software');
    expect(entries[0]!.totalCostUsd).toBeCloseTo(0.6);
  });

  it('rebuilds at most once per TTL', () => {
    const calls: number[] = [];
    let clock = 1_000;
    const source = createShowcaseSource({ listShowcaseRuns: () => (calls.push(clock), []) }, () => clock);
    source.entries();
    source.entries();
    expect(calls).toHaveLength(1);
    clock += SHOWCASE_TTL_MS + 1;
    source.entries();
    expect(calls).toHaveLength(2);
  });
});

describe('what a visitor can read', () => {
  it('carries no identity, path, repository or project name, on either page', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Explain the urn puzzle', title: 'The urn puzzle', delivery: 'text', answer: 'Posterior is 3/4.' });
    const source = createShowcaseSource(w.store);
    const entry = source.entry(id)!;
    const pages = [
      renderShowcaseIndex(source.entries(), new URL('https://atoma.example.com')),
      renderShowcaseEntry(entry, new Map([[id, source.answer(id, id)]]), new URL('https://atoma.example.com')),
    ].join('\n');
    for (const secret of [
      w.admin.orgId, w.admin.principalId, w.admin.projectId, w.root, 'Secret admin project',
      'secret-owner-admin', 'secret-repo-admin', 'secret-admin', w.member.orgId,
    ]) {
      expect(pages).not.toContain(secret);
    }
    expect(pages).toContain('The urn puzzle');
    expect(pages).toContain('Posterior is 3/4.');
  });

  it('shows a text delivery\'s answer, bounded, and no answer for a file delivery', () => {
    const w = world();
    const text = seedRun(w, w.admin, { goal: 'Answer', delivery: 'text', answer: 'x'.repeat(20_000) });
    const files = seedRun(w, w.admin, { goal: 'Files', files: ['a.md'], answer: 'internal summary' });
    w.store.listShowcaseRuns();
    const source = createShowcaseSource(w.store);
    expect(source.answer(text, text)!.length).toBeLessThanOrEqual(8_001);
    expect(source.answer(files, files)).toBeNull();
    expect(source.answer(text, 'not-an-episode')).toBeNull();
  });

  it('escapes every tenant- and model-authored value', () => {
    const w = world();
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const id = seedRun(w, w.admin, { goal: payload, title: payload, delivery: 'text', answer: payload });
    const source = createShowcaseSource(w.store);
    const html = [
      renderShowcaseIndex(source.entries(), null),
      renderShowcaseEntry(source.entry(id)!, new Map([[id, source.answer(id, id)]]), null),
    ].join('\n');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The only script on the page is the pinned filter bar.
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it('pins its inline script by hash, loads only this site\'s modules, and allows no network', () => {
    const csp = SHOWCASE_SECURITY_HEADERS['content-security-policy'];
    // `'self'` is the crystal module; nothing inline runs without its hash.
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*;\s*img|script-src[^;]*unsafe-inline/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/connect-src|unsafe-eval/);
    const html = renderShowcaseIndex([], null);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it('puts the real crystal on every page when the build has it, and keeps the static one as fallback', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Goal', title: 'A title', files: ['a.md'] });
    const source = createShowcaseSource(w.store);
    const assets = { markScript: '/showcase-assets/atoma-mark.js?v=0123456789abcdef' };
    const pages = [
      renderShowcaseIndex(source.entries(), new URL('https://atoma.example.com'), assets),
      renderShowcaseEntry(source.entry(id)!, new Map(), new URL('https://atoma.example.com'), assets),
    ];
    for (const html of pages) {
      expect(html).toContain('<script type="module" src="/showcase-assets/atoma-mark.js?v=0123456789abcdef"></script>');
      expect(html.match(/data-atoma-mark="/g)!.length).toBeGreaterThanOrEqual(3);
      // The static crystal is inside every host, for a browser without WebGL.
      expect(html).toContain('aria-label="The Atoma crystal"');
    }
    // Exactly one section per page receives the lit crystal's light and caustics.
    for (const html of pages) expect(html.match(/data-atoma-receiver/g)).toHaveLength(1);
    expect(pages[0]).toContain('<section class="hero" data-atoma-receiver>');
    expect(pages[1]).toContain('<main class="story" data-atoma-receiver>');
    expect(SHOWCASE_SECURITY_HEADERS['content-security-policy']).toMatch(/script-src 'self' 'sha256-/);
    // Without a built bundle (a source checkout, these tests) there is no module to load.
    expect(renderShowcaseIndex([], null)).not.toContain('type="module"');
  });

  it('shows no placeholder while the real crystal loads, and never leaves an empty host', () => {
    const assets = { markScript: '/showcase-assets/atoma-mark.js?v=0123456789abcdef' };
    const loading = renderShowcaseIndex([], null, assets);
    // The static crystal is hidden while the module loads...
    expect(loading).toContain('<body class="marks-pending">');
    expect(loading).toContain('.marks-pending .mark:not(.mark-live):not(.mark-failed)>*{visibility:hidden;');
    // ...and comes back if it fails, never loads (a delayed reveal), or JavaScript is off.
    expect(loading).toContain('animation:mark-reveal 0s 4s forwards');
    expect(loading).toContain('<noscript><style>.marks-pending .mark>*{visibility:visible!important}</style></noscript>');
    // Without a module to wait for, the static crystal is simply shown.
    const plain = renderShowcaseIndex([], null);
    expect(plain).toContain('<body>');
    expect(plain).not.toContain('<noscript>');
  });

  it('writes clean head metadata on every page, and nothing stray before the header', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Goal', title: 'A title', files: ['a.md'] });
    const source = createShowcaseSource(w.store);
    const story = renderShowcaseEntry(source.entry(id)!, new Map(), new URL('https://atoma.example.com'));
    const home = renderShowcaseIndex(source.entries(), new URL('https://atoma.example.com'));
    for (const html of [story, home]) {
      // The production regression: a mangled join separator printed `"""+B+"""n` at the top.
      expect(html).not.toMatch(/"{3}|\+B\+/);
      const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
      expect(head.split('\n').every((line) => line === '' || /^\s*</.test(line) || /^[^<]*[{}:;]/.test(line))).toBe(true);
      expect(html.slice(html.indexOf('<body>') + '<body>'.length).trimStart().startsWith('<header')).toBe(true);
    }
    expect(story).toContain('<meta property="og:title" content="A title — Atoma">');
    expect(story).toContain(`<meta property="og:url" content="https://atoma.example.com/showcase/${id}">`);
  });

  it('keeps the header within a phone screen', () => {
    // Measured 2026-10-03: the full header was 481px wide on a 390px phone and
    // dragged the whole page sideways. On a phone it keeps the brand and the
    // two ways in, and its links never wrap.
    const html = renderShowcaseIndex([], null);
    const phone = /@media \(max-width:640px\)\{([^@]*)\}/.exec(html)?.[1] ?? '';
    expect(phone).toContain('.brand .pill,nav.top a.secondary{display:none}');
    expect(html).toContain('<a class="secondary" href="/#feed">Finished work</a>');
    expect(html).toMatch(/nav\.top a\{[^}]*white-space:nowrap/);
  });

  it('says so when there is nothing to show, and uses plain words', () => {
    const html = renderShowcaseIndex([], null);
    expect(html).toContain('Nothing to show yet');
    expect(html).not.toMatch(/\b(agent|molecule|tissue|tier|L[123])\b/i);
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

async function boot(w: World, extra: Record<string, string>): Promise<string> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ATOMA_AUTH_') || key.startsWith('ATOMA_GITHUB_')) delete env[key];
  }
  for (const key of ['ATOMA_VIZ_AUTH', 'ATOMA_VIZ_PUBLIC_ORIGIN', 'ATOMA_VIZ_DEV_URL', 'ATOMA_DB_PATH',
    'ATOMA_RUNS_DIR', 'ATOMA_VIZ_SENTINEL', 'ATOMA_PUBLIC_SHOWCASE']) delete env[key];
  const profiles = mkdtempSync(join(tmpdir(), 'atoma-showcase-profiles-'));
  roots.push(profiles);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', String(port),
      '--dir', join(w.root, 'runs'), '--db', w.dbPath, '--skills-dir', join(w.root, 'skills')],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        ATOMA_ACCOUNT_PROFILES_ROOT: profiles,
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: origin,
        ATOMA_VIZ_SENTINEL: '0',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'test-client',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'test-secret',
        ATOMA_AUTH_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:9/authorize',
        ATOMA_AUTH_GITHUB_TOKEN_URL: 'http://127.0.0.1:9/token',
        ATOMA_AUTH_GITHUB_USERINFO_URL: 'http://127.0.0.1:9/userinfo',
        ATOMA_PROJECTS_ROOT: join(w.root, 'projects'),
        ...extra,
      },
    }
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
  children.push(child);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr.join('')}`);
    try {
      await fetch(`${origin}/robots.txt`);
      return origin;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server not ready\n${stderr.join('')}`);
}

describe('the home page', () => {
  const home = { enabled: true, pathname: '/', search: '', hasSession: false };

  it('is the showcase only for a bare / from a visitor with no session', () => {
    expect(servesShowcaseHome(home)).toBe(true);
    expect(servesShowcaseHome({ ...home, hasSession: true })).toBe(false);
    expect(servesShowcaseHome({ ...home, enabled: false })).toBe(false);
    expect(servesShowcaseHome({ ...home, pathname: '/index.html' })).toBe(false);
    expect(servesShowcaseHome({ ...home, pathname: '/app' })).toBe(false);
  });

  it('leaves every query string to the app shell, which reads them', () => {
    for (const search of ['?authNotice=providerRefused', '?invite=abc', '?atomaHandheld=1', '?x=']) {
      expect(servesShowcaseHome({ ...home, search })).toBe(false);
    }
  });

  it('sends a visitor in through /app, and carries the product identity', () => {
    const html = renderShowcaseIndex([], new URL('https://atoma.example.com'));
    expect(html).toContain('<title>Atoma — Watch a request turn into finished work</title>');
    expect(html).toContain('rel="canonical" href="https://atoma.example.com/"');
    expect(html).toContain('property="og:image" content="https://atoma.example.com/og-card.png"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('href="/app"');
    expect(html).not.toContain('href="/auth/login"');
    expect(html).not.toContain('href="/showcase"');
  });
});

describe('the real server', () => {
  it('serves the showcase as the home page to anyone, without a session', async () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Admin goal', title: 'An admin title', files: ['README.md'] });
    seedRun(w, w.member, { goal: 'MEMBER SECRET GOAL', title: 'Member secret title', files: ['README.md'] });
    closeStoreHandles();
    const origin = await boot(w, { ATOMA_PUBLIC_SHOWCASE: '1' });

    const home = await fetch(`${origin}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(home.headers.get('set-cookie')).toBeNull();
    expect(home.headers.get('cache-control')).toBe('no-store');
    const html = await home.text();
    expect(html).toContain('An admin title');
    expect(html).toContain(`rel="canonical" href="${origin}/"`);
    expect(html).not.toContain('MEMBER SECRET GOAL');
    expect(html).not.toContain('Member secret title');
    expect(html).toContain(`href="/showcase/${id}"`);
    // A stale or forged cookie is just no session.
    const forged = await fetch(`${origin}/`, { headers: { cookie: 'atoma_session=forged' } });
    expect(await forged.text()).toContain('An admin title');

    // The app shell stays reachable, and a query string always means the shell.
    for (const path of ['/app', '/index.html', '/?authNotice=providerRefused', '/?invite=abc']) {
      expect(await (await fetch(`${origin}${path}`)).text()).not.toContain('Finished and checked');
    }

    const redirect = await fetch(`${origin}/showcase`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/');
    const story = await fetch(`${origin}/showcase/${id}`);
    expect(story.status).toBe(200);
    expect(await story.text()).toContain('An admin title');
    expect((await fetch(`${origin}/showcase/${randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${origin}/showcase`, { method: 'POST' })).status).toBe(405);

    const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
    expect(sitemap).toContain(`/showcase/${id}</loc>`);
    // The control plane is untouched: runs still need a session.
    expect((await fetch(`${origin}/api/runs`)).status).toBe(401);
  });

  it('keeps the app as the home page, and answers 404 for stories, unless the host opted in', async () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Admin goal', title: 'An admin title', files: ['README.md'] });
    closeStoreHandles();
    const origin = await boot(w, {});
    expect(await (await fetch(`${origin}/`)).text()).not.toContain('Finished and checked');
    expect((await fetch(`${origin}/showcase`)).status).toBe(404);
    expect((await fetch(`${origin}/showcase/${id}`)).status).toBe(404);
    expect(await (await fetch(`${origin}/sitemap.xml`)).text()).not.toContain('/showcase');
  });
});
