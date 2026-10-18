import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_FRAME_BYTES, WORKSPACE_PROTOCOL_VERSION, workspaceResponseSchema, type WorkspaceCommand } from '../contracts/workspaceProtocol.js';
import { remoteWorkspaceRuntime } from './workspaceRpc.js';
import type { WorkspaceRuntime } from '../contracts/workspaceRuntime.js';

/** Hosted process transport for exercising the same private RPC as customer compute. */
export function startWorkspaceProcess(options: { root: string; readRunsIndex?: string; timeoutMs?: number }): {
  runtime: WorkspaceRuntime; close(): Promise<void>;
} {
  const entry = fileURLToPath(new URL('./workspaceService.js', import.meta.url));
  const source = import.meta.url.endsWith('.ts');
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), source ? entry.replace(/\.js$/, '.ts') : entry], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { PATH: process.env['PATH'], ATOMA_WORKSPACE_ROOT: options.root,
      ...(options.readRunsIndex ? { ATOMA_WORKSPACE_READ_RUNS: options.readRunsIndex } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  let failure: Error | undefined;
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const call of pending.values()) call.reject(failure);
    pending.clear(); child.kill();
  };
  const closed = new Promise<void>(resolve => child.once('close', () => { fail(new Error('Workspace service closed')); resolve(); }));
  child.on('error', error => fail(error));
  child.stdin.on('error', error => fail(error));
  child.stdout.on('error', error => fail(error));
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      if (buffer.length + chunk.length > WORKSPACE_FRAME_BYTES) throw new Error('Workspace response exceeds limit');
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const response = workspaceResponseSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as unknown);
        buffer = buffer.subarray(newline + 1);
        const call = pending.get(response.id);
        if (!call) throw new Error('Unexpected workspace response');
        pending.delete(response.id);
        if (response.ok) call.resolve(response.reply);
        else call.reject(new Error(`Workspace ${response.error}`));
      }
    } catch { fail(new Error('Invalid workspace response')); }
  });
  const send = async (command: WorkspaceCommand): Promise<unknown> => {
    if (failure) throw failure;
    if (pending.size >= 16) throw new Error('Workspace request capacity exceeded');
    const id = ++nextId;
    const frame = JSON.stringify({ version: WORKSPACE_PROTOCOL_VERSION, id, command }) + '\n';
    if (Buffer.byteLength(frame) > WORKSPACE_FRAME_BYTES || child.stdin.writableLength > WORKSPACE_FRAME_BYTES) {
      throw new Error('Workspace request exceeds limit');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Workspace request timed out; outcome unknown')), options.timeoutMs ?? 120_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(frame);
    });
  };
  return { runtime: remoteWorkspaceRuntime(send), close: async () => { fail(new Error('Workspace service stopped')); await closed; } };
}
