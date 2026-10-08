/** Dedicated isolate entry point. Its bundle contains no control-plane code. */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { closeSync, constants, cpSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { TERMINAL_HISTORY_BYTES, TERMINAL_INPUT_BYTES, TERMINAL_UPLOAD_BYTES, terminalResizeSchema } from '../../contracts/previewTerminal.js';

const OUTPUT_CAP = TERMINAL_HISTORY_BYTES;

/** Bounded byte history. Slow readers get an explicit lost-output indication. */
export class TerminalOutput {
  private readonly bytes = Buffer.alloc(OUTPUT_CAP);
  private cursor = 0;
  append(data: Buffer): void {
    for (let offset = 0; offset < data.length;) {
      const position = this.cursor % OUTPUT_CAP;
      const count = Math.min(data.length - offset, OUTPUT_CAP - position);
      data.copy(this.bytes, position, offset, offset + count);
      this.cursor += count;
      offset += count;
    }
  }
  read(after: number): { data: string; cursor: number; truncated: boolean } {
    const start = Math.max(after, this.cursor - OUTPUT_CAP, 0);
    const end = Math.min(this.cursor, start + 65536);
    const output = Buffer.alloc(Math.max(0, end - start));
    for (let offset = 0; offset < output.length;) {
      const position = (start + offset) % OUTPUT_CAP;
      const count = Math.min(output.length - offset, OUTPUT_CAP - position);
      this.bytes.copy(output, offset, position, position + count);
      offset += count;
    }
    return { data: output.toString('base64'), cursor: end, truncated: start > after };
  }
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limit) throw new Error('body limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function startTerminalServer(options: {
  sourceRoot: string; dataRoot: string; assetsRoot: string; bridge: string;
  host: string; port: number;
}) {
  // /workspace is mounted read-only. All writes are charged to /data's tmpfs.
  const destination = join(options.dataRoot, 'workspace');
  mkdirSync(destination, { recursive: true });
  const workspace = realpathSync(destination);
  cpSync(options.sourceRoot, workspace, { recursive: true, dereference: false, errorOnExist: true, force: false });
  const assets = new Map<string, { mime: string; bytes: Buffer }>([
    ['/', { mime: 'text/html; charset=utf-8', bytes: readFileSync(join(options.assetsRoot, 'index.html')) }],
    ['/client.js', { mime: 'text/javascript; charset=utf-8', bytes: readFileSync(join(options.assetsRoot, 'client.js')) }],
    ['/client.css', { mime: 'text/css; charset=utf-8', bytes: readFileSync(join(options.assetsRoot, 'client.css')) }],
    ['/labels.json', { mime: 'application/json', bytes: readFileSync(join(options.assetsRoot, 'labels.json')) }],
  ]);
  const output = new TerminalOutput();
  let exitCode: number | null = null;
  let pendingPtyInput = 0;
  const child = spawn('python3', ['-I', options.bridge], {
    cwd: workspace,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Never copy diagnostics into platform logs or disclose their host paths.
  child.stderr.resume();
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimeout = setTimeout(() => rejectReady(new Error('terminal readiness timeout')), 5000);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line) as { data?: string; exitCode?: number; ready?: boolean; drained?: number };
      if (event.ready === true) resolveReady();
      if (typeof event.drained === 'number') pendingPtyInput = Math.max(0, pendingPtyInput - event.drained);
      if (typeof event.data === 'string') output.append(Buffer.from(event.data, 'base64'));
      if (typeof event.exitCode === 'number') exitCode = event.exitCode;
    } catch { exitCode = -1; child.stdin.end(); }
  });
  child.on('error', () => { exitCode = -1; rejectReady(new Error('terminal unavailable')); });
  child.on('close', (code) => { exitCode ??= code ?? -1; rejectReady(new Error('terminal exited')); });
  child.stdin.on('error', () => { exitCode ??= -1; });
  try { await ready; } catch (error) { child.stdin.end(); throw error; }
  finally { clearTimeout(readyTimeout); }

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000 }, (req, res) => {
    const respond = (code: number, value: unknown) => {
      if (res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://terminal');
      const asset = assets.get(url.pathname);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'no-store' });
        res.end(asset.bytes);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/output') {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0) return respond(400, { error: 'invalid-cursor' });
        return respond(200, { ...output.read(after), exitCode });
      }
      if (req.method !== 'POST' || req.headers['x-atoma-terminal'] !== '1') return respond(404, {});
      if (url.pathname === '/input' || url.pathname === '/resize') {
        if (exitCode !== null) return respond(409, { error: 'terminal-exited' });
        if (child.stdin.writableLength > 65536) return respond(429, { error: 'input-capacity' });
        const bytes = await body(req, TERMINAL_INPUT_BYTES);
        if (url.pathname === '/input') {
          if (pendingPtyInput + bytes.length > 65536) return respond(429, { error: 'input-capacity' });
          pendingPtyInput += bytes.length;
          child.stdin.write(JSON.stringify({ type: 'input', data: bytes.toString('base64') }) + '\n');
        } else {
          const value = terminalResizeSchema.parse(JSON.parse(bytes.toString('utf8')));
          child.stdin.write(JSON.stringify({ type: 'resize', cols: value.cols, rows: value.rows }) + '\n');
        }
        return respond(200, {});
      }
      if (url.pathname === '/upload') {
        const name = url.searchParams.get('name') ?? '';
        if (!name || name.length > 128 || /[\\/]/.test(name) || [...name].some((ch) => ch.charCodeAt(0) < 32) || name === '.' || name === '..') return respond(400, {});
        const bytes = await body(req, TERMINAL_UPLOAD_BYTES);
        // No path supplied by the browser, and no following a shell-created link.
        if (realpathSync(workspace) !== workspace) return respond(409, {});
        const fd = openSync(join(workspace, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
        return respond(200, { name });
      }
      respond(404, {});
    })().catch(() => respond(400, { error: 'request-failed' }));
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, done);
    });
  } catch (error) { child.stdin.end(); throw error; }
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    close: async () => {
      child.stdin.end();
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      await new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
    },
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const directory = dirname(fileURLToPath(import.meta.url));
  void startTerminalServer({ sourceRoot: '/workspace', dataRoot: '/data', assetsRoot: directory,
    bridge: join(directory, 'pty.py'), host: '0.0.0.0', port: 8080 }).then((running) => {
    process.stdout.write('LISTENING_ON_PORT=8080\n');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void running.close().finally(() => process.exit(0)); });
  }).catch(() => { process.stderr.write('terminal startup failed\n'); process.exitCode = 1; });
}
