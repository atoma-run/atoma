import { computeSetupView } from './computeSetup.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthGate } from '../auth/gate.js';
import { BoundedFixedWindowRateLimiter, loginClientAddress, isSecureRequest, type TrustedProxySnapshot } from '../auth/rate-limit.js';
import { authCookieName, parseCookieHeader, serializeCookie, sessionTokenFromCookieHeader } from '../auth/sessions.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { computeSetupCopy, computePairCopy as t, computePairIcon } from './computeCopy.js';
import type { ComputeDeviceStore } from '../projects/computeDevices.js';

import { COMPUTE_CLIENT_ARCHIVE, COMPUTE_CLIENT_ROOT, COMPUTE_CLIENT_SHA256, COMPUTE_CLIENT_DOWNLOAD, computePairCommand } from './computeDistribution.js';
import { isLocale, localeDirection } from '../contracts/locales.js';

const RETURN_COOKIE = 'atoma_compute_return';
const codeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
async function body(req: IncomingMessage): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const part of req) {
    const chunk = Buffer.from(part as Uint8Array); size += chunk.length;
    if (size > 8192) throw new Error('Compute request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function page(res: ServerResponse, title: string, content: string, status = 200, locale = 'en') {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
  res.end(`<!doctype html><html lang="${escape(locale)}" dir="${localeDirection(isLocale(locale) ? locale : 'en')}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Atoma</title><style>
:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;color:#e7eeeb;background:#101918}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:flex;padding:24px}main{width:100%;max-width:600px;margin:auto;padding:28px;border:1px solid #34463f;border-radius:20px;background:#15211d;overflow-wrap:anywhere}h1{font-size:30px;line-height:1.2}p,dt{color:#b8c8bf}pre{direction:ltr;text-align:left;unicode-bidi:plaintext;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#0c1410;border-radius:8px;font-size:13px}summary{cursor:pointer;padding:12px 0}dl{padding:16px;background:#1c2b24;border-radius:12px}dd{margin:0 0 12px;font-weight:600}button,a{display:inline-flex;align-items:center;gap:8px;font:inherit;min-height:44px;padding:10px 18px;border-radius:9px}button{cursor:pointer;border:1px solid #b2e5c4;background:#b2e5c4;color:#102519;font-weight:600}a{color:#c0d2c5}button:hover{background:#c8f2d6}a:hover{background:#263b31}button:active,a:active{opacity:.85}button:focus-visible,a:focus-visible{outline:3px solid #b2e5c4;outline-offset:4px}.setup-tabs{display:flex;gap:8px;border-bottom:1px solid #34463f;padding-bottom:12px;margin-bottom:24px}.setup-tabs a{flex:1;min-width:0;text-align:center;justify-content:center}.setup-tabs a[aria-current],.actions a[aria-current]{background:#263b31;box-shadow:inset 0 -3px #b2e5c4}.download{background:#b2e5c4;color:#102519;font-weight:600}.notice{border-inline-start:3px solid #b2e5c4;padding-inline-start:16px}li{margin-block:12px}figure{margin:16px 0}figure a{display:block;padding:0;max-width:100%;width:fit-content}figure img{display:block;width:100%;max-width:520px;height:auto;border-radius:12px}.install-steps{padding-inline-start:24px}.actions{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:480px){body{padding:12px}main{padding:20px}h1{font-size:26px}}
</style><main><p>Atoma Compute</p><h1>${escape(title)}</h1>${content}</main></html>`);
}

/** Explicit host opt-in. Native pairing endpoints never accept browser origins;
 * every browser mutation requires the current session and exact public origin. */
export class ComputeHttp {
  private readonly consents = new Map<string, { code: string; sessionHash: string; orgId: string; principalId: string; expiresAt: number }>();
  private readonly rate = new BoundedFixedWindowRateLimiter(30, 60_000, 1024);
  private readonly browserRate = new BoundedFixedWindowRateLimiter(120, 60_000, 1024);
  constructor(private readonly options: { devices: ComputeDeviceStore; gate: AuthGate; origin: URL;
    proxies: TrustedProxySnapshot; emit: PlatformEventSink;
    pendingRuns?: (orgId: string, projectId: string, principalId: string) => { runId: string }[];
    finalize?: (orgId: string, runId: string, principalId: string) => Promise<unknown> }) {
    if (options.origin.protocol !== 'https:') throw new Error('Compute requires HTTPS');
  }
  loginReturn(req: IncomingMessage): { location: string; cookie: string } | undefined {
    const cookies = parseCookieHeader(req.headers.cookie).filter(cookie => cookie.name === authCookieName(RETURN_COOKIE, true));
    if (cookies.length !== 1 || !codeSchema.safeParse(cookies[0]!.value).success) return undefined;
    const code = cookies[0]!.value;
    let location = '/';
    try { this.options.devices.pairingDescription(code); location = `/compute/pair?code=${code}`; } catch { /* expired */ }
    return { location, cookie: serializeCookie(RETURN_COOKIE, '', { secure: true, maxAgeSeconds: 0 }) };
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const pathname = url.pathname;
    if (pathname !== '/compute/setup' && pathname !== '/compute/pair' && !pathname.startsWith('/api/compute/')) return false;
    const { devices, gate, origin, proxies } = this.options;
    if (!isSecureRequest(req, proxies)) { json(res, 403, { error: 'HTTPS required' }); return true; }
    if (pathname === '/compute/setup' || pathname.startsWith('/api/compute/pairings')) {
      const limit = this.rate.attempt(loginClientAddress(req, proxies));
      if (!limit.accepted) { res.setHeader('retry-after', limit.retryAfterSeconds); json(res, 429, { error: 'Try again later' }); return true; }
    }
    try {
      if (pathname === '/api/compute/pairings' || pathname === '/api/compute/pairings/redeem') {
        if (req.method !== 'POST' || req.headers.origin || req.headers.cookie) { json(res, 403, { error: 'Native pairing request required' }); return true; }
        const input: unknown = JSON.parse(await body(req));
        if (pathname.endsWith('/redeem')) {
          const parsed = z.object({ code: codeSchema, secret: z.string().max(80) }).strict().parse(input);
          json(res, 200, devices.redeemPairing(parsed.code, parsed.secret));
        } else {
          const parsed = z.object({ name: z.string().max(120), secretHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
          const receipt = devices.beginPairing(parsed);
          json(res, 201, { ...receipt, verificationUrl: `${origin.origin}/compute/pair?code=${receipt.code}` });
        }
        return true;
      }
      if (pathname === '/compute/setup' && req.method === 'GET') {
        const requested = url.searchParams.get('lang') ?? req.headers['accept-language']?.split(',')[0]?.split('-')[0] ?? 'en';
        const locale = isLocale(requested) ? requested : 'en';
        const copy = (key: string) => escape(computeSetupCopy(key, locale));
        const commands = (windows: boolean, architecture: 'arm64' | 'amd64') => {
          const verify = windows
            ? `$expected = "${COMPUTE_CLIENT_SHA256}"\nif ((Get-FileHash "${COMPUTE_CLIENT_ARCHIVE}" -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw "Checksum mismatch" }`
            : `echo "${COMPUTE_CLIENT_SHA256}  ${COMPUTE_CLIENT_ARCHIVE}" | shasum -a 256 -c - || exit 1`;
          const pairing = computePairCommand(origin.origin, architecture);
          const script = windows
            ? `& {\n$ErrorActionPreference = "Stop"\n${verify}\ntar -xzf ${COMPUTE_CLIENT_ARCHIVE}\nif ($LASTEXITCODE -ne 0) { throw "Extraction failed" }\nSet-Location ${COMPUTE_CLIENT_ROOT}\nnpm.cmd ci --omit=dev\nif ($LASTEXITCODE -ne 0) { throw "Installation failed" }\n${pairing.replace(/^npm /, 'npm.cmd ')}\n}`
            : `${verify}\ntar -xzf ${COMPUTE_CLIENT_ARCHIVE} || exit 1\ncd ${COMPUTE_CLIENT_ROOT} || exit 1\nnpm ci --omit=dev && ${pairing}`;
          return `<pre><code>${escape(script)}</code></pre>`;
        };
        page(res, computeSetupCopy('title', locale),
          computeSetupView(locale, url, req.headers['user-agent'] ?? '', `<h2>${copy('prerequisites')}</h2><p>${copy('requirements')}</p><p><a href="https://nodejs.org/en/download">Node.js</a><a href="https://www.docker.com/products/docker-desktop/">Docker Desktop</a></p>` +
          `<h2>${copy('install')}</h2><p>${copy('installHelp')}</p><p><a href="${COMPUTE_CLIENT_DOWNLOAD}">${copy('download')}</a><a href="${COMPUTE_CLIENT_DOWNLOAD}.sha256">${copy('checksum')}</a></p><p>${copy('architecture')}</p>` +
          `<details><summary>macOS · Apple Silicon</summary>${commands(false, 'arm64')}</details>` +
          `<details><summary>macOS · Intel</summary>${commands(false, 'amd64')}</details><details><summary>Windows x64 · PowerShell</summary>${commands(true, 'amd64')}</details>` +
          `<h2>${copy('start')}</h2><p>${copy('startHelp')}</p><pre><code>node dist/cli/compute.js pull\nnode dist/cli/compute.js doctor\nnode dist/cli/compute.js start</code></pre>` +
          `<h2>${copy('project')}</h2><p>${copy('projectHelp')}</p><a href="/">${copy('back')}</a>`), 200, locale);
        return true;
      }
      const viewer = gate.resolve(req);
      if (!viewer) {
        if (pathname === '/compute/pair' && req.method === 'GET') {
          const code = codeSchema.parse(url.searchParams.get('code')); devices.pairingDescription(code);
          res.writeHead(302, { location: '/auth/login', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            'set-cookie': serializeCookie(RETURN_COOKIE, code, { secure: true, maxAgeSeconds: 600 }) }); res.end();
        } else json(res, 401, { error: 'Authentication required' });
        return true;
      }
      const browserLimit = this.browserRate.attempt(`${viewer.principalId}:${viewer.orgId}`);
      if (!browserLimit.accepted) { res.setHeader('retry-after', browserLimit.retryAfterSeconds); json(res, 429, { error: 'Try again later' }); return true; }
      if (viewer.role === 'org:viewer') { json(res, 403, { error: 'Compute membership required' }); return true; }
      const actor = { orgId: viewer.orgId, principalId: viewer.principalId };
      if (req.method !== 'GET' && req.headers.origin !== origin.origin) { json(res, 403, { error: 'Origin mismatch' }); return true; }
      if (pathname === '/compute/pair') {
        const code = codeSchema.parse(url.searchParams.get('code'));
        if (req.method === 'GET') {
          const description = devices.pairingDescription(code);
          const token = sessionTokenFromCookieHeader(req.headers.cookie, true);
          if (!token) throw new Error('Session unavailable');
          const now = Date.now();
          for (const [id, pending] of this.consents) if (pending.expiresAt <= now) this.consents.delete(id);
          if (this.consents.size >= 512) throw new Error('Consent capacity exceeded');
          const consent = randomBytes(24).toString('base64url');
          this.consents.set(consent, { code, ...actor, sessionHash: createHash('sha256').update(token).digest('hex'), expiresAt: now + 600_000 });
          page(res, t('title'), `<p>${escape(t('subtitle'))}</p><dl><dt>${escape(t('device'))}</dt><dd>${escape(description.name)}</dd><dt>${escape(t('account'))}</dt><dd>${escape(viewer.displayName)}</dd><dt>${escape(t('organisation'))}</dt><dd>${escape(viewer.orgName)}</dd></dl><p>${escape(t('notice'))}</p><p>${escape(t('scope'))}</p><form method="post"><input type="hidden" name="consent" value="${consent}"><input type="hidden" name="orgId" value="${escape(viewer.orgId)}"><input type="hidden" name="principalId" value="${escape(viewer.principalId)}"><div class="actions"><a href="/">${computePairIcon("close")}${escape(t('cancel'))}</a><button type="submit">${computePairIcon("link")}${escape(t('allow'))}</button></div></form>`);
        } else if (req.method === 'POST') {
          const params = new URLSearchParams(await body(req));
          if (params.getAll('orgId').length !== 1 || params.get('orgId') !== viewer.orgId || params.getAll('principalId').length !== 1 || params.get('principalId') !== viewer.principalId) throw new Error('Identity changed');
          const consent = params.get('consent') ?? '', pending = this.consents.get(consent);
          this.consents.delete(consent);
          const session = sessionTokenFromCookieHeader(req.headers.cookie, true);
          if (params.getAll('consent').length !== 1 || !pending || !session || pending.expiresAt <= Date.now() ||
              pending.code !== code || pending.orgId !== viewer.orgId || pending.principalId !== viewer.principalId ||
              pending.sessionHash !== createHash('sha256').update(session).digest('hex')) throw new Error('Consent changed');
          devices.confirmPairing(actor, code);
          this.audit(actor, 'pairing-confirmed'); page(res, t('done'), `<p>${escape(t('return'))}</p><a href="/">Atoma</a>`);
        } else json(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (pathname === '/api/compute/onboarding' && req.method === 'GET') {
        json(res, 200, { hostedAllowed: viewer.platformAdmin === true,
          devices: devices.list(actor).filter(device => !device.revoked).map(device => ({
            deviceId: device.deviceId, name: device.name, connected: device.connected,
          })) });
        return true;
      }
      if (pathname === '/api/compute/devices' && req.method === 'GET') { json(res, 200, { devices: devices.list(actor) }); return true; }
      const device = pathname.match(/^\/api\/compute\/devices\/([a-f0-9-]{36})\/(revoke|projects)$/);
      if (device && req.method === 'POST') {
        if (device[2] === 'revoke') { devices.revoke(actor, device[1]!); this.audit(actor, 'device-revoked', { deviceId: device[1]! }); }
        else {
          const input = z.object({ projectId: z.string().uuid(), allowed: z.boolean() }).strict().parse(JSON.parse(await body(req)));
          devices.grantProject(actor, device[1]!, input.projectId, input.allowed);
          this.audit(actor, 'project-grant-changed', { deviceId: device[1]!, projectId: input.projectId, allowed: input.allowed });
        }
        json(res, 200, { ok: true }); return true;
      }
      const finalization = pathname.match(/^\/api\/compute\/runs\/([a-f0-9-]{36})\/finalize$/);
      if (finalization && req.method === 'POST' && this.options.finalize) {
        z.object({}).strict().parse(JSON.parse(await body(req)));
        await this.options.finalize(actor.orgId, finalization[1]!, actor.principalId);
        json(res, 200, { ok: true }); return true;
      }
      const projectView = pathname.match(/^\/api\/compute\/projects\/([a-f0-9-]{36})$/);
      if (projectView && req.method === 'GET') {
        const view = devices.projectView(actor, projectView[1]!);
        json(res, 200, { ...view, pendingRuns: this.options.pendingRuns?.(actor.orgId, projectView[1]!, actor.principalId) ?? [] });
        return true;
      }
      const project = pathname.match(/^\/api\/compute\/projects\/([a-f0-9-]{36})\/target$/);
      if (project && req.method === 'PUT') {
        devices.setProjectTarget(actor, project[1]!, JSON.parse(await body(req)));
        this.audit(actor, 'project-target-changed', { projectId: project[1]! });
        json(res, 200, { ok: true }); return true;
      }
      json(res, 404, { error: 'Compute route unavailable' });
    } catch {
      if (pathname === '/compute/pair') page(res, t('title'), `<p role="alert">${escape(t('error'))}</p><a href="/">Atoma</a>`, 409);
      else json(res, 409, { error: 'Compute request unavailable or changed; refresh before retrying' });
    }
    return true;
  }
  private audit(actor: { orgId: string; principalId: string }, action: string, detail: Record<string, unknown> = {}) {
    this.options.emit({ kind: 'compute.access_changed', actorType: 'principal', actorId: actor.principalId,
      orgId: actor.orgId, summary: 'Compute access changed', detail: { action, ...detail } });
  }
}
