import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WORKSPACE_FRAME_BYTES, workspaceRequestSchema, workspaceResponseSchema } from '../contracts/workspaceProtocol.js';
import { localWorkspaceRuntime } from './workspaceRuntime.js';
import { workspaceCommandHandler } from './workspaceRpc.js';
import { readReadRunsIndex } from './readRuns.js';
import type { WorkspaceRuntime } from '../contracts/workspaceRuntime.js';

/** Dedicated control process. Never start this entrypoint in the tool worker. */
export async function serveWorkspace(runtime: WorkspaceRuntime, input: Readable, output: Writable): Promise<void> {
  const execute = workspaceCommandHandler(runtime);
  let buffer = Buffer.alloc(0);
  let lastId = 0;
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      if (buffer.length + chunk.length > WORKSPACE_FRAME_BYTES) throw new Error('Workspace frame exceeds limit');
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        const request = workspaceRequestSchema.parse(JSON.parse(line) as unknown);
        if (request.id <= lastId) throw new Error('Workspace request replay refused');
        lastId = request.id;
        let response;
        try { response = { id: request.id, ok: true as const, reply: await execute(request.command) }; }
        catch (error) { response = { id: request.id, ok: false as const, error: 'operation-failed' as const,
          message: (error instanceof Error ? error.message : 'Workspace operation failed').slice(0, 8192) }; }
        const encoded = JSON.stringify(workspaceResponseSchema.parse(response)) + '\n';
        if (Buffer.byteLength(encoded) > WORKSPACE_FRAME_BYTES) throw new Error('Workspace response exceeds limit');
        if (!output.write(encoded)) await once(output, 'drain');
      }
    }
    if (buffer.length) throw new Error('Workspace frame interrupted');
  } finally { await execute.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env['ATOMA_WORKSPACE_ROOT'];
  if (!root) throw new Error('Workspace root is required');
  const index = process.env['ATOMA_WORKSPACE_READ_RUNS'];
  const runtime = localWorkspaceRuntime({ root, ...(index ? { readRuns: readReadRunsIndex(index) } : {}),
    seedRoot: process.env['ATOMA_WORKSPACE_SEED'],
    log: line => process.stderr.write(`${line}\n`) });
  process.once('SIGTERM', () => process.stdin.destroy());
  serveWorkspace(runtime, process.stdin, process.stdout).catch(() => { process.exitCode = 1; process.stdin.destroy(); });
}
