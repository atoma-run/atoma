import { request, createServer, type Server } from 'node:http';
import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { Duplex } from 'node:stream';
import { githubAccessRequiredSchema } from '../contracts/projects.js';
import { executorRequestSchema, type ExecutorRequest, type ExecutorFailure } from '../contracts/executor.js';
export class ExecutorUnavailable extends Error {
  constructor(message = 'Run executor unavailable; retry the same request to recover its saved run') {
    super(message); this.name = 'ExecutorUnavailable';
  }
}

/** The socket lives outside every workload mount; no bearer or tenant-supplied path crosses it. */
export function executorSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const socket = env['ATOMA_EXECUTOR_SOCKET'];
  if (socket !== undefined && (!isAbsolute(socket) || Buffer.byteLength(socket) > 100)) throw new Error('ATOMA_EXECUTOR_SOCKET must be an absolute Unix socket path under 101 bytes');
  return socket;
}

export function executorSelected(active: string, own: string): boolean {
  try { return realpathSync(active) === realpathSync(own); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function assertExecutorDirectory(socketPath: string): void {
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('Invalid executor socket path');
  const parent = lstatSync(dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('Executor socket requires a private directory owned by the service user');
  }
}

export function callExecutor<T>(socketPath: string, input: ExecutorRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    // Resolve the active symlink for EVERY command. An Agent keep-alive pool
    // keyed by its pathname would keep sending new runs to the old process.
    const req = request({ socketPath, agent: false, path: '/', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, res => {
      const parts: Buffer[] = []; let bytes = 0;
      res.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > 32 * 1024 ** 2) { res.destroy(new ExecutorUnavailable()); return; }
        parts.push(part);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const reply = JSON.parse(Buffer.concat(parts).toString('utf8')) as { value?: T; error?: ExecutorFailure };
          if (reply.error) { reject(Object.assign(new Error(reply.error.message), { name: reply.error.name,
            ...(reply.error.access ? { access: githubAccessRequiredSchema.parse(reply.error.access) } : {}),
            ...(typeof reply.error.reason === 'string' ? { reason: reply.error.reason.slice(0, 64) } : {}) })); return; }
          if (res.statusCode !== 200) throw new ExecutorUnavailable();
          resolve(reply.value as T);
        } catch (error) { reject(error instanceof Error ? error : new ExecutorUnavailable()); }
      });
    });
    req.setTimeout(120_000, () => req.destroy(new ExecutorUnavailable()));
    req.on('error', () => reject(new ExecutorUnavailable()));
    req.end(body);
  });
}

export async function serveExecutor(socketPath: string, dispatch: (input: ExecutorRequest) => Promise<unknown>,
  connect?: (streamId: string) => Promise<Duplex>): Promise<Server> {
  // The root-owned activator creates a private directory. Refuse broad or
  // symlinked parents instead of silently exposing a host-authority endpoint.
  assertExecutorDirectory(socketPath);
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/') { res.writeHead(404).end(); return; }
      let body = ''; let size = 0;
      for await (const part of req) {
        size += Buffer.byteLength(part as Buffer);
        if (size > 64 * 1024) { res.writeHead(413).end(); return; }
        body += String(part);
      }
      const input = executorRequestSchema.parse(JSON.parse(body));
      const value = await dispatch(input);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
    })().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
        name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Executor request failed',
        ...(error instanceof Error && 'access' in error && githubAccessRequiredSchema.safeParse(error.access).success ? { access: error.access } : {}),
        ...(error instanceof Error && 'reason' in error && typeof error.reason === 'string' ? { reason: error.reason.slice(0, 64) } : {}),
      } }));
    });
  });
  server.requestTimeout = 125_000;
  server.headersTimeout = 10_000;
  server.on('connect', (req, socket, head) => {
    const id = req.url?.slice(1);
    if (!connect || !id || !/^[0-9a-f-]{36}$/.test(id) || head.length) { socket.destroy(); return; }
    void connect(id).then(stream => {
      if (socket.destroyed) { stream.destroy(); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('error', () => stream.destroy()); stream.on('error', () => socket.destroy());
      socket.on('close', () => stream.destroy()); stream.on('close', () => socket.destroy());
      socket.pipe(stream).pipe(socket);
    }, () => socket.destroy());
  });
  // Never unlink an existing listener: two starts of one generation must fail.
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  chmodSync(socketPath, 0o600);
  server.once('close', () => { try { unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } });
  return server;
}

export function openExecutorStream(socketPath: string, streamId: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, agent: false, method: 'CONNECT', path: `/${streamId}` });
    req.setTimeout(10_000, () => req.destroy(new ExecutorUnavailable()));
    req.on('error', reject);
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new ExecutorUnavailable()); return; }
      socket.setTimeout(0); if (head.length) socket.unshift(head); resolve(socket);
    });
    req.end();
  });
}
