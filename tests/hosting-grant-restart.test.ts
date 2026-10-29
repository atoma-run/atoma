import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type Serializable } from 'node:child_process';
import { once } from 'node:events';
import { PreviewClaimRegistry, mintPreviewClaim, previewClaimHash, PREVIEW_GRANT_TTL_MS } from '../src/preview/claims.js';
import { HostingStore } from '../src/projects/hostingStore.js';
import type { HostedDeployment } from '../src/contracts/projectHosting.js';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function folder() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-grants-'))); roots.push(root); return root; }
function call(port: number, host: string, cookie = '', path = '/', body?: string) {
  return new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
      headers: { host, cookie, ...(body ? { origin: `https://${host}`, 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '', body: text }));
    }); req.on('error', reject); req.end(body);
  });
}

it('keeps the exact grant expiry across database reopen, and cannot renew an expired or revoked token', () => {
  const file = join(folder(), 'primary.db'); let now = 1000;
  const binding = { orgId: randomUUID(), projectRunId: randomUUID(), principalId: randomUUID(), sessionId: null, generation: 1, host: 'retained.app.atoma.run' };
  let db = new Database(file);
  const first = new PreviewClaimRegistry(() => now, undefined, new HostingStore(db).grants);
  const claim = mintPreviewClaim(binding, now); first.register(claim);
  const redeemed = first.redeem(claim.secret, binding.host);
  if (!redeemed.ok) throw new Error('Missing test grant');
  const token = redeemed.token, initialExpiry = redeemed.grant.expiresAt;
  const record = db.prepare('SELECT hash,record FROM project_hosting_grants').get() as { hash: string; record: string };
  expect(record.hash).toBe(previewClaimHash(token)); expect(record.record).not.toContain(token);
  db.close(); db = new Database(file);
  try {
    const second = new PreviewClaimRegistry(() => now, undefined, new HostingStore(db).grants);
    expect(second.authorise(token, binding)?.expiresAt).toBe(initialExpiry);
    expect(second.authorise(token, { ...binding, orgId: randomUUID() })).toBeNull();
    expect(second.authorise(token, { ...binding, generation: 2 })).toBeNull();
    now += PREVIEW_GRANT_TTL_MS + 1;
    expect(second.renew(token, binding)).toBeNull(); expect(second.size.grants).toBe(0);
    const nextClaim = mintPreviewClaim(binding, now); second.register(nextClaim);
    const next = second.redeem(nextClaim.secret, binding.host);
    if (!next.ok) throw new Error('Missing second grant');
    expect(second.revokePrincipal(binding.principalId)).toBe(1);
    expect(second.renew(next.token, binding)).toBeNull(); expect(second.size.grants).toBe(0);
    // Ephemeral previews still forget their grants when their registry restarts.
    const preview = new PreviewClaimRegistry(() => now); preview.register(nextClaim);
    const temporary = preview.redeem(nextClaim.secret, binding.host);
    if (!temporary.ok) throw new Error('Missing preview grant');
    expect(new PreviewClaimRegistry(() => now).authorise(temporary.token, binding)).toBeNull();
  } finally { db.close(); }
});

it('serves the same browser cookie after a real gateway process restart, with membership and logout still enforced', async () => {
  const upstream = createServer((_req, res) => res.end('retained application'));
  servers.push(upstream); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const file = join(folder(), 'primary.db'), principalId = randomUUID();
  const row: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(),
    manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', entry: 'server.js',
    createdAt: new Date().toISOString(), error: null, hostPort: upstreamPort, image: 'image' };
  const host = 'retained.app.atoma.run';
  const db = new Database(file);
  db.exec('CREATE TABLE projects(project_id TEXT,org_id TEXT,PRIMARY KEY(project_id,org_id))');
  db.prepare('INSERT INTO projects VALUES (?,?)').run(row.projectId, row.orgId);
  new HostingStore(db).reserve(row, null, 2); db.close();
  const code = `
    import { HostingStore } from ${JSON.stringify(new URL('../src/projects/hostingStore.ts', import.meta.url).href)};
    import { createHostingGateway } from ${JSON.stringify(new URL('../src/projects/hostingGateway.ts', import.meta.url).href)};
    const row=JSON.parse(process.env.ROW), host=process.env.HOST, principalId=process.env.PRINCIPAL;
    const store=HostingStore.open(process.env.PRIMARY); let allowed=true;
    const service={deps:{store},host:()=>host,movedHost:()=>null,swapping:()=>null,
      status:(viewer,projectId)=>{if(viewer.orgId!==row.orgId||projectId!==row.projectId)throw Error('Wrong project')}};
    const gateway=createHostingGateway(service,'https://atoma.run',()=>allowed);
    gateway.server.listen(0,'127.0.0.1',()=>process.send({port:gateway.server.address().port,
      url:gateway.open({orgId:row.orgId,principalId},row.projectId)}));
    process.on('message',message=>{if(message.action==='membership')allowed=message.allowed;
      if(message.action==='logout')gateway.claims.revokePrincipal(principalId);
      process.send({done:message.action});});
  `;
  const start = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { PATH: process.env['PATH'], PRIMARY: file, ROW: JSON.stringify(row), HOST: host, PRINCIPAL: principalId },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = ''; child.stderr!.on('data', chunk => { errors = (errors + String(chunk)).slice(-4000); });
    const closed = once(child, 'close');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ready: { port: number; url: string };
    try {
      ready = await Promise.race([once(child, 'message').then(([message]) => message as { port: number; url: string }),
        closed.then(() => { throw new Error(`Gateway exited: ${errors}`); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Gateway startup timed out')), 10_000); })]);
    } catch (error) { child.kill('SIGTERM'); await closed; throw error; }
    finally { clearTimeout(timer); }
    return { ...ready, send: async (message: Serializable) => { const done = once(child, 'message'); child.send(message); await done; },
      stop: async () => { child.kill('SIGTERM'); await closed; } };
  };
  const first = await start(); let cookie = '', unused = '';
  try {
    unused = new URL(first.url).hash.slice(1);
    const redeemed = await call(first.port, host, '', '/.atoma/claim', JSON.stringify({ token: unused }));
    expect(redeemed.status).toBe(204); cookie = redeemed.cookie;
    expect((await call(first.port, host, cookie)).body).toBe('retained application');
  } finally { await first.stop(); }
  const second = await start();
  try {
    expect((await call(second.port, host, cookie)).status).toBe(200);
    expect((await call(second.port, host, cookie)).body).toBe('retained application');
    expect((await call(second.port, host, '', '/.atoma/claim', JSON.stringify({ token: unused }))).status).toBe(404);
    await second.send({ action: 'membership', allowed: false });
    expect((await call(second.port, host, cookie)).status).toBe(404);
    await second.send({ action: 'membership', allowed: true });
    expect((await call(second.port, host, cookie)).status).toBe(200);
    await second.send({ action: 'logout' });
    expect((await call(second.port, host, cookie)).status).toBe(404);
  } finally { await second.stop(); }
  const third = await start();
  try { expect((await call(third.port, host, cookie)).status).toBe(404); }
  finally { await third.stop(); }
}, 15_000);
