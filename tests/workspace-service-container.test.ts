import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { workspaceResponseSchema, type WorkspaceCommand } from '../src/contracts/workspaceProtocol.js';

const execute = promisify(execFile);
const image = process.env['ATOMA_TEST_WORKSPACE_IMAGE'];

it.skipIf(!image)('restores changes made by a separate container on a Linux volume, with no host paths or engine socket', async () => {
  const name = `atoma-workspace-test-${randomUUID()}`;
  const volume = `${name}-data`;
  const snapshots = `${name}-snapshots`;
  await execute('docker', ['volume', 'create', volume]);
  const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '64',
    '--mount', `type=volume,src=${volume},dst=/workspace`,
    '--mount', `type=volume,src=${snapshots},dst=/snapshots`, image!], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const call = async (command: WorkspaceCommand) => {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ version: 1, id: requestId, command }) + '\n');
    const line = await lines.next();
    if (line.done) throw new Error('Workspace service exited');
    const response = workspaceResponseSchema.parse(JSON.parse(line.value) as unknown);
    expect(response.id).toBe(requestId);
    if (!response.ok) throw new Error(response.error);
    return response.reply;
  };
  const mutate = async (code: string) => (await execute('docker', ['run', '--rm', '--network', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${volume},dst=/workspace`,
    '--entrypoint', 'node', image!, '-e', code], { timeout: 15_000 })).stdout;
  try {
    await call({ method: 'routing' });
    await mutate("require('node:fs').writeFileSync('/workspace/README.md', 'original')");
    const began = await call({ method: 'begin-read-only', phase: 'Inspect', attempt: 1 });
    if (began.method !== 'begin-read-only') throw new Error('Wrong response');
    await mutate("require('node:fs').writeFileSync('/workspace/README.md', 'changed')");
    const ended = await call({ method: 'end-read-only', handle: began.value, record: { writes: ['README.md'] } });
    expect(ended.method).toBe('end-read-only');
    expect(await mutate("process.stdout.write(require('node:fs').readFileSync('/workspace/README.md'))")).toBe('original');
    expect(await mutate("process.stdout.write(String(require('node:fs').existsSync('/var/run/docker.sock')))")).toBe('false');
    const opened = await call({ method: 'checkpoint-open' });
    if (opened.method !== 'checkpoint-open') throw new Error('Wrong response');
    await mutate("require('node:fs').writeFileSync('/workspace/README.md', 'after capture')");
    const entry = await call({ method: 'checkpoint-next', handle: opened.value.handle });
    expect(entry).toMatchObject({ method: 'checkpoint-next', value: { kind: 'entry', entry: { path: 'README.md' } } });
    const bytes = await call({ method: 'checkpoint-next', handle: opened.value.handle });
    expect(bytes).toMatchObject({ method: 'checkpoint-next', value: { kind: 'chunk', data: Buffer.from('original').toString('base64') } });
    expect(await mutate("process.stdout.write(String(require('node:fs').readdirSync('/snapshots').length))")).toBe('0');
    await call({ method: 'checkpoint-close', handle: opened.value.handle });
  } finally {
    await execute('docker', ['rm', '-f', name]).catch(() => undefined);
    await closed;
    await execute('docker', ['volume', 'rm', volume]);
    await execute('docker', ['volume', 'rm', snapshots]);
  }
}, 60_000);
