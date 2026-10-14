import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PreviewClaimRegistry, mintPreviewClaim } from '../preview/claims.js';
import { previewResponseHeaders, sanitizeRequestHeaders, sanitizeResponseHeaders, isSamePreviewRedirect } from '../preview/gateway.js';
import type { HostingService } from './hostingService.js';
import type { Viewer } from '../auth/store.js';

const COOKIE = '__Host-AtomaHosted';
/** Private applications: platform credentials never cross to generated code. */
export function createHostingGateway(service: HostingService, controlOrigin: string, member: (org: string, principal: string) => boolean) {
  const claims = new PreviewClaimRegistry();
  const sweep = setInterval(() => claims.sweep(), 60_000); sweep.unref();
  const policy: Record<string, string> = { ...previewResponseHeaders({ visualizerOrigin: controlOrigin, allowedHosts: [] }),
    'cross-origin-opener-policy': 'same-origin' };
  policy['content-security-policy'] += "; worker-src 'none'";
  function cookie(token: string) { return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`; }
  const respond = (res: ServerResponse, status: number, body = '') => { res.writeHead(status, policy); res.end(body); };
  async function handler(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host?.toLowerCase();
    const row = service.deps.store.list().filter(r => r.state === 'ready').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find(r => service.host(r) === host);
    if (!row || !host || req.headers['service-worker']) { respond(res, 404); return; }
    const origin = `https://${host}`;
    const binding = { orgId: row.orgId, projectRunId: row.deploymentId, generation: 1, host };
    const pathname = new URL(req.url ?? '/', origin).pathname;
    if (pathname === '/.atoma/open' && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64');
      res.writeHead(200, { ...policy, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
      res.end(`<!doctype html><meta charset="utf-8"><title>Open application</title><p id="status">Opening your application…</p><script nonce="${nonce}">const token=location.hash.slice(1);history.replaceState(null,'','/.atoma/open');fetch('/.atoma/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('status').textContent='This link expired. Open the application again from your Atoma project.'});</script>`);
      return;
    }
    if (pathname === '/.atoma/claim' && req.method === 'POST') {
      if (req.headers.origin !== origin) { respond(res, 404); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk as Buffer); if (size > 4096) { respond(res, 413); req.destroy(); return; } chunks.push(Buffer.from(chunk as Buffer)); }
      let token: unknown; try { token = (JSON.parse(Buffer.concat(chunks).toString()) as { token?: unknown }).token; } catch { respond(res, 400); return; }
      if (typeof token !== 'string' || token.length > 128) { respond(res, 404); return; }
      const redeemed = claims.redeem(token, host);
      if (!redeemed.ok || redeemed.grant.binding.projectRunId !== row.deploymentId || !member(row.orgId, redeemed.grant.binding.principalId)) { respond(res, 404); return; }
      res.setHeader('set-cookie', cookie(redeemed.token)); respond(res, 204); return;
    }
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const grant = token ? claims.authorise(token, binding) : null;
    if (!grant || !member(row.orgId, grant.binding.principalId)) { respond(res, 404, 'Open this private application from its Atoma project.'); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && req.headers.origin !== origin) { respond(res, 403); return; }
    if (pathname.startsWith('/.atoma/')) { respond(res, 404); return; }
    claims.renew(token!, binding); res.setHeader('set-cookie', cookie(token!));
    const headers = sanitizeRequestHeaders(req.headers);
    // Hop-by-hop headers, including extension headers nominated by Connection, never cross.
    for (const name of ['authorization', 'connection', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', ...(req.headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())]) delete headers[name];
    headers.host = host;
    const upstream = request({ host: '127.0.0.1', port: row.hostPort!, path: req.url, method: req.method, headers, timeout: 30_000 }, incoming => {
      if (incoming.headers.location && !isSamePreviewRedirect(incoming.headers.location, origin)) { incoming.destroy(); respond(res, 502); return; }
      const output = sanitizeResponseHeaders(incoming.headers);
      for (const name of ['connection', 'upgrade', 'transfer-encoding', ...(incoming.headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())]) delete output[name];
      res.writeHead(incoming.statusCode ?? 502, { ...output, ...policy }); incoming.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) respond(res, 502); else res.destroy(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  }
  const server = createServer({ maxHeaderSize: 16384 }, (req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) respond(res, 500); else res.destroy(); }); });
  server.requestTimeout = 60_000;
  server.on('close', () => clearInterval(sweep));
  return { server, claims, open(viewer: Viewer, projectId: string): string {
    service.status(viewer, projectId);
    const row = service.deps.store.list(viewer.orgId, projectId).find(r => r.state === 'ready');
    if (!row) throw new Error('Application not ready');
    const host = service.host(row);
    const claim = mintPreviewClaim({ ...viewer, sessionId: null, projectRunId: row.deploymentId, generation: 1, host }, Date.now());
    claims.register(claim);
    return `https://${host}/.atoma/open#${claim.secret}`;
  } };
}
