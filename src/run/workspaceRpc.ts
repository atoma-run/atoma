import { randomUUID } from 'node:crypto';
import type { WorkspaceRuntime, RuntimePhaseGuard, WorkspaceRestoration } from '../contracts/workspaceRuntime.js';
import { workspaceCommandSchema, workspaceReplySchema, type WorkspaceCommand, type WorkspaceReply } from '../contracts/workspaceProtocol.js';
import type { ReadOnlyRestoration } from '../contracts/readOnlyPhase.js';
import type { CheckpointExport, CheckpointExportFrame } from '../contracts/checkpointTransfer.js';

/** Lives beside the filesystem, outside the model-controlled worker process. */
export function workspaceCommandHandler(runtime: WorkspaceRuntime): ((input: unknown) => Promise<WorkspaceReply>) & { close(): Promise<void> } {
  const guards = new Map<string, Promise<RuntimePhaseGuard>>();
  const imports = new Map<string, { receiver: WorkspaceRestoration; expiresAt: number }>();
  const exports = new Map<string, { snapshot: CheckpointExport; frames: AsyncGenerator<CheckpointExportFrame>; expiresAt: number }>();
  const execute = async (input: unknown): Promise<WorkspaceReply> => {
    const command = workspaceCommandSchema.parse(input);
    for (const [handle, importing] of imports) {
      if (Date.now() >= importing.expiresAt) { await importing.receiver.abort(); imports.delete(handle); }
    }
    if (imports.size && command.method !== 'import-frame' && command.method !== 'import-abort') {
      throw new Error('Workspace import is still active');
    }
    for (const [handle, exporting] of exports) {
      if (Date.now() >= exporting.expiresAt) { await exporting.snapshot.close(); exports.delete(handle); }
    }
    switch (command.method) {
      case 'bind-sources': {
        if (imports.size || exports.size || guards.size || !runtime.bindSources) throw new Error('Source binding unavailable');
        await runtime.bindSources(command.sources); return { method: command.method, value: null };
      }
      case 'import-open': {
        if (guards.size || exports.size) throw new Error('Workspace control operation is still active');
        if (command.source && command.archive) throw new Error('Source replacement is forbidden');
        const receiver = command.source ? await runtime.importSource(command.source, command.header)
          : await runtime.importWorkspace(command.header, command.archive);
        const handle = randomUUID();
        imports.set(handle, { receiver, expiresAt: Date.now() + 30 * 60_000 });
        return { method: command.method, value: handle };
      }
      case 'import-frame': {
        const importing = imports.get(command.handle);
        if (!importing) throw new Error('Unknown workspace import');
        try {
          const frame = command.frame;
          if (frame.kind === 'entry') await importing.receiver.begin(frame.entry);
          else if (frame.kind === 'chunk') await importing.receiver.append(frame.offset, Buffer.from(frame.data, 'base64'));
          else { await importing.receiver.finish(); imports.delete(command.handle); }
        } catch (error) {
          await importing.receiver.abort(); imports.delete(command.handle); throw error;
        }
        return { method: command.method, value: null };
      }
      case 'import-abort': {
        await imports.get(command.handle)?.receiver.abort(); imports.delete(command.handle);
        return { method: command.method, value: null };
      }
      case 'validate-sources': await runtime.validateSources(); return { method: command.method, value: null };
      case 'prepare': case 'restart': {
        if (guards.size || exports.size) throw new Error('Workspace control operation is still active');
        if (command.method === 'prepare') await runtime.prepare(command.clean);
        else await runtime.restart();
        return { method: command.method, value: null };
      }
      case 'starting-snapshot': return { method: command.method, value: await runtime.startingSnapshot() };
      case 'ensure-read-runs': return { method: command.method, value: await runtime.ensureReadRuns() };
      case 'canonical-path': return { method: command.method, value: await runtime.canonicalPath() };
      case 'checkpoint-digest': return { method: command.method, value: await runtime.checkpointDigest() };
      case 'classify-preview': return { method: command.method, value: await runtime.classifyPreview() };
      case 'artifact-open': {
        if (exports.size || guards.size) throw new Error('Workspace control operation is still active');
        const snapshot = await runtime.artifactExport(command.options);
        const handle = randomUUID();
        exports.set(handle, { snapshot, frames: snapshot.frames(), expiresAt: Date.now() + 30 * 60_000 });
        return { method: command.method, value: { handle, header: snapshot.header, manifest: snapshot.manifest } };
      }
      case 'checkpoint-confirmed': await runtime.confirmCheckpoint?.(command.confirmation); return { method: command.method, value: null };
      case 'checkpoint-open': {
        if (exports.size) throw new Error('A checkpoint export is already active');
        const snapshot = await runtime.checkpointExport();
        const handle = randomUUID();
        exports.set(handle, { snapshot, frames: snapshot.frames(), expiresAt: Date.now() + 30 * 60_000 });
        return { method: command.method, value: { handle, header: snapshot.header } };
      }
      case 'checkpoint-next': {
        const exporting = exports.get(command.handle);
        if (!exporting) throw new Error('Unknown checkpoint export');
        const next = await exporting.frames.next();
        if (next.done) { exports.delete(command.handle); return { method: command.method, value: { kind: 'end' } }; }
        return { method: command.method, value: next.value.kind === 'entry' ? next.value
          : { kind: 'chunk', offset: next.value.offset, data: Buffer.from(next.value.bytes).toString('base64') } };
      }
      case 'checkpoint-close': {
        await exports.get(command.handle)?.snapshot.close(); exports.delete(command.handle);
        return { method: command.method, value: null };
      }
      case 'inherited-state': return { method: command.method, value: await runtime.inheritedState() };
      case 'replace-manifest': return { method: command.method, value: await runtime.replaceManifest(command.text, command.expected) };
      case 'routing': return { method: command.method, value: await runtime.routingRepository() };
      case 'delivered': return { method: command.method, value: await runtime.deliveredSnapshot(command.start) };
      case 'capture-read-runs': await runtime.captureReadRuns(); return { method: command.method, value: null };
      case 'check-read-runs': return { method: command.method, value: await runtime.checkReadRuns() };
      case 'compare-read-runs': return { method: command.method, value: await runtime.compareReadRuns(command.criteria) };
      case 'begin-read-only': {
        // Read-only phases are sequential. An overlap could undo another phase's work.
        if (guards.size) throw new Error('A read-only workspace phase is already active');
        const handle = randomUUID();
        const guard = runtime.readOnlyPhases.begin(command.phase, command.attempt);
        guards.set(handle, guard);
        try { await guard; }
        catch (error) { guards.delete(handle); throw error; }
        return { method: command.method, value: handle };
      }
      case 'end-read-only': {
        const guard = guards.get(command.handle);
        if (!guard) throw new Error('Unknown workspace phase');
        const value = await (await guard).end(command.record);
        guards.delete(command.handle);
        return { method: command.method, value };
      }
    }
  };
  return Object.assign(execute, { close: async () => {
    const results = await Promise.allSettled([
      ...[...imports.values()].map(item => Promise.resolve().then(() => item.receiver.abort())),
      ...[...exports.values()].map(item => Promise.resolve().then(() => item.snapshot.close())),
    ]);
    imports.clear(); exports.clear();
    if (results.some(result => result.status === 'rejected')) throw new Error('Workspace control cleanup failed');
  } });
}

/** No photographs, file identities or file contents cross the read-only phase API. */
type ReplyValues = { [R in WorkspaceReply as R['method']]: R['value'] };
export function remoteWorkspaceRuntime(send: (command: WorkspaceCommand) => Promise<unknown>): WorkspaceRuntime {
  async function call<C extends WorkspaceCommand>(command: C): Promise<ReplyValues[C['method']]> {
    const reply = workspaceReplySchema.parse(await send(command));
    if (reply.method !== command.method) throw new Error('Workspace response method mismatch');
    return reply.value as ReplyValues[C['method']];
  }
  const exporting = ({ handle, header }: ReplyValues['checkpoint-open']): CheckpointExport => {
      let closed = false;
      let started = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await call({ method: 'checkpoint-close', handle });
      };
      return { header, close, async *frames() {
        if (started || closed) throw new Error('Checkpoint export is closed');
        started = true;
        try {
          while (!closed) {
            const next = await call({ method: 'checkpoint-next', handle });
            if (next.kind === 'end') { closed = true; return; }
            yield next.kind === 'entry' ? next : { kind: 'chunk' as const, offset: next.offset, bytes: Buffer.from(next.data, 'base64') };
          }
        } finally { await close(); }
      } };
  };
  const restorations: ReadOnlyRestoration[] = [];
  const importing = (handle: string): WorkspaceRestoration => {
      let finished = false;
      return {
        begin: async entry => {
          if (finished) throw new Error('Workspace import is closed');
          await call({ method: 'import-frame', handle, frame: { kind: 'entry', entry } });
        },
        append: async (offset, bytes) => {
          if (finished) throw new Error('Workspace import is closed');
          await call({ method: 'import-frame', handle, frame: { kind: 'chunk', offset, data: Buffer.from(bytes).toString('base64') } });
        },
        finish: async () => {
          if (finished) throw new Error('Workspace import is closed');
          finished = true; // A lost commit acknowledgement must never be retried.
          await call({ method: 'import-frame', handle, frame: { kind: 'end' } });
        },
        abort: async () => { finished = true; await call({ method: 'import-abort', handle }); },
      };
  };
  return {
    bindSources: async sources => { await call({ method: 'bind-sources', sources }); },
    importSource: async (source, header) => importing(await call({ method: 'import-open', header, archive: false, source })),
    importWorkspace: async (header, archive) => importing(await call({ method: 'import-open', header, archive })),
    classifyPreview: () => call({ method: 'classify-preview' }),
    artifactExport: async options => {
      const opened = await call({ method: 'artifact-open', options });
      return { ...exporting(opened), manifest: opened.manifest };
    },
    validateSources: async () => { await call({ method: 'validate-sources' }); },
    prepare: async clean => { await call({ method: 'prepare', clean }); },
    restart: async () => { await call({ method: 'restart' }); },
    startingSnapshot: () => call({ method: 'starting-snapshot' }),
    ensureReadRuns: () => call({ method: 'ensure-read-runs' }),
    canonicalPath: () => call({ method: 'canonical-path' }),
    checkpointDigest: () => call({ method: 'checkpoint-digest' }),
    confirmCheckpoint: async confirmation => { await call({ method: 'checkpoint-confirmed', confirmation }); },
    checkpointExport: async () => exporting(await call({ method: 'checkpoint-open' })),
    inheritedState: () => call({ method: 'inherited-state' }),
    replaceManifest: (text, expected) => call({ method: 'replace-manifest', text, expected }),
    routingRepository: () => call({ method: 'routing' }),
    deliveredSnapshot: start => call({ method: 'delivered', start }),
    captureReadRuns: async () => { await call({ method: 'capture-read-runs' }); },
    checkReadRuns: () => call({ method: 'check-read-runs' }),
    compareReadRuns: criteria => call({ method: 'compare-read-runs', criteria }),
    readOnlyPhases: {
      restorations: () => restorations,
      begin: async (phase, attempt) => {
        const handle = await call({ method: 'begin-read-only', phase, attempt });
        let ended: Promise<ReadOnlyRestoration> | undefined;
        return { end: record => {
          // Cache the promise, including failure: never replay an uncertain restore.
          ended ??= call({ method: 'end-read-only', handle, record: record ?? {} }).then(value => {
            restorations.push(value); return value;
          });
          return ended;
        } };
      },
    },
  };
}
