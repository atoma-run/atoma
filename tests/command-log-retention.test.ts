import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { capturedCommandLogsSchema } from '../src/contracts/evidenceReading.js';
import { captureCommandLogs, commandLogSnapshot, COMMAND_LOG_MAX_BYTES } from '../src/tools/commandLogs.js';
import { runShellTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { archiveToolEvidence, readArchivedToolEvidence } from '../src/core/evidenceArchive.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { completeEvidenceReview } from '../src/atoms/evidenceReading.js';
import { ContainerToolExecutor } from '../src/tools/containerExecutor.js';
import { makeCtx } from './helpers.js';

describe('redirected command logs', () => {
  it('retains the unfiltered failure and actual exit through the documented redirect pattern', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-command-log-'));
    const sandbox = new ToolSandbox(root);
    const logPath = join(root, 'verification.log');
    try {
      const raw = 'first\nASSERTION_FAILED_é\n' + 'raw proof\n'.repeat(6000) + 'last\n';
      writeFileSync(join(root, 'check.cjs'), `process.stdout.write(${JSON.stringify(raw)},()=>process.exit(7));`);
      const tool = runShellTool({ sandbox, commandLogDirectory: root });
      const result = await tool.execute({ cmd: `node check.cjs > ${JSON.stringify(logPath)} 2>&1; status=$?; cat ${JSON.stringify(logPath)}; exit "$status"` }) as { exitCode: number; stdout: string; capturedCommandLogs: unknown };
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe(raw);
      const archive = archiveToolEvidence({ cmd: 'verification' }, result);
      await sandbox.cleanup();
      rmSync(root, { recursive: true, force: true });
      const saved = JSON.parse(readArchivedToolEvidence(archive)) as { result: { capturedCommandLogs: unknown } };
      const logs = capturedCommandLogsSchema.parse(saved.result.capturedCommandLogs);
      expect(logs.omitted).toEqual([]);
      expect(JSON.parse(readArchivedToolEvidence(logs.files[0]!.evidence))).toMatchObject({ result: { content: raw } });
    } finally { await sandbox.cleanup(); rmSync(root, { recursive: true, force: true }); }
  });
  it('retains the full raw redirected log through worker-result archival, deletion and paged review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-command-log-'));
    const sandbox = new ToolSandbox(join(root, 'workspace'));
    const logPath = join(root, 'check.log');
    const log = 'start\n' + 'recorded output\n'.repeat(8000) + 'ASSERTION_FAILED_é\n';
    const recorder = new TraceRecorder(join(root, 'traces'));
    const run = recorder.beginRun({ description: 'Raw log retention' });
    const attestations = createAttestationLog(r => recorder.recordAttestation(r));
    try {
      writeFileSync(join(sandbox.root, 'check.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(log)});console.log('check_exit=1');`);
      const tool = runShellTool({ sandbox, commandLogDirectory: root });
      const tools = attestingExecutor({ has: () => true, execute: (_name, args) => tool.execute(args) }, attestations, 'left', undefined, 1)!;
      await tools.execute('run_shell', { command: 'node', args: ['check.cjs'] });
      recorder.endRun({});
      rmSync(logPath);
      const saved = JSON.parse(readFileSync(join(root, 'traces', run.id + '.json'), 'utf8')) as { attestations: Array<{ fullEvidence: ReturnType<typeof archiveToolEvidence> }> };
      const parent = JSON.parse(readArchivedToolEvidence(saved.attestations[0]!.fullEvidence)) as { result: { capturedCommandLogs: unknown } };
      const captured = capturedCommandLogsSchema.parse(parent.result.capturedCommandLogs);
      expect(captured.omitted).toEqual([]);
      expect(captured.files[0]).toMatchObject({ path: logPath, bytes: Buffer.byteLength(log), sha256: createHash('sha256').update(log).digest('hex') });
      expect(JSON.parse(readArchivedToolEvidence(captured.files[0]!.evidence))).toMatchObject({ result: { content: log } });
      const ctx = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations };
      const id = attestations.forAttempt(1)[0]!.eventId + ':log:0';
      ctx.llm.enqueue({ text: JSON.stringify({ readEvidence: [{ eventId: id, find: 'ASSERTION_FAILED_é', length: 100 }] }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
      ctx.llm.enqueue(req => {
        expect(req.userContent).toContain('ASSERTION_FAILED_é');
        expect(req.tools).toBeUndefined(); expect(req.executor).toBeUndefined();
        return { text: '{"approved":false}', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      });
      await completeEvidenceReview({ ctx, request: { model: 'mock', systemPrompt: 'Judge recorded evidence' },
        makeUserContent: block => block, preview: () => '', evidence: executorEvidence({}, ctx) });
      expect(ctx.llm.calls).toHaveLength(2);
    } finally { await sandbox.cleanup(); rmSync(root, { recursive: true, force: true }); }
  });

  it('does not collect unchanged logs or enable collection on an in-process host by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-command-log-'));
    const sandbox = new ToolSandbox(root);
    try {
      writeFileSync(join(root, 'old.log'), 'old evidence');
      expect(captureCommandLogs(root, commandLogSnapshot(root))).toMatchObject({ files: [], omitted: [] });
      const result = await runShellTool({ sandbox }).execute({ command: 'node', args: ['-e', 'console.log("complete")'] });
      expect(result).toMatchObject({ stdout: 'complete\n', exitCode: 0 });
      expect(result).not.toHaveProperty('capturedCommandLogs');
    } finally { await sandbox.cleanup(); rmSync(root, { recursive: true, force: true }); }
  });

  it('reports links, non-files, binary and oversized logs explicitly instead of silently losing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-command-log-'));
    try {
      writeFileSync(join(root, 'private.txt'), 'not a log');
      symlinkSync(join(root, 'private.txt'), join(root, 'symlink.log'));
      linkSync(join(root, 'private.txt'), join(root, 'hardlink.log'));
      writeFileSync(join(root, 'large.log'), Buffer.alloc(COMMAND_LOG_MAX_BYTES + 1));
      writeFileSync(join(root, 'binary.log'), Buffer.from([255, 0, 255]));
      const captured = captureCommandLogs(root, new Map());
      expect(captured.files).toEqual([]);
      expect(captured.omitted.map(f => f.path.split('/').at(-1))).toEqual(['binary.log', 'hardlink.log', 'large.log', 'symlink.log']);
      expect(captured.omitted.every(f => f.reason.length > 0)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('bounds the encoded wire payload and reports removed and excessive paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-command-log-'));
    try {
      writeFileSync(join(root, 'deleted.log'), 'previous');
      const before = commandLogSnapshot(root);
      rmSync(join(root, 'deleted.log'));
      // Under the raw byte bound, but over the encoded transfer budget.
      writeFileSync(join(root, '000-random.log'), randomBytes(5 * 1024 * 1024).toString('base64'));
      for (let i = 0; i < 300; i++) writeFileSync(join(root, `${String(i + 1).padStart(3, '0')}.log`), 'small');
      const captured = captureCommandLogs(root, before);
      expect(captured.files).toHaveLength(32);
      expect(captured.omitted.some(f => f.path.endsWith('/deleted.log') && f.reason.includes('removed'))).toBe(true);
      expect(captured.omitted.some(f => f.path.endsWith('/000-random.log') && f.reason.includes('Encoded'))).toBe(true);
      expect(captured.omitted.some(f => f.reason.includes('inventory bound'))).toBe(true);
      expect(JSON.stringify(captured).length).toBeLessThan(4 * 1024 * 1024 + 200000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const image = process.env['ATOMA_TEST_WORKER_IMAGE'];
describe.skipIf(!image)('compiled worker log retention across container removal', () => {
  it('keeps a redirected /tmp log in the persisted transport evidence after drain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-worker-log-'));
    const worker = new ContainerToolExecutor({ workspaceHostPath: root, image });
    try {
      await worker.start();
      const result = await worker.execute('run_shell', { cmd: "node -e 'process.stdout.write(\"start\\nASSERTION_RAW_é\\nend\\n\",()=>process.exit(7))' >/tmp/check.log 2>&1; status=$?; cat /tmp/check.log; exit \"$status\"" }) as { capturedCommandLogs: unknown; stdout: string; exitCode: number };
      const archived = archiveToolEvidence({ cmd: 'redirected log' }, result);
      expect(result.stdout).toBe('start\nASSERTION_RAW_é\nend\n');
      expect(result.exitCode).toBe(7);
      await worker.drain();
      const saved = JSON.parse(readArchivedToolEvidence(archived)) as { result: { capturedCommandLogs: unknown } };
      const logs = capturedCommandLogsSchema.parse(saved.result.capturedCommandLogs);
      expect(logs.omitted).toEqual([]);
      expect(logs.files.map(f => f.path)).toContain('/tmp/check.log');
      expect(JSON.parse(readArchivedToolEvidence(logs.files.find(f => f.path === '/tmp/check.log')!.evidence))).toMatchObject({ result: { content: 'start\nASSERTION_RAW_é\nend\n' } });
    } finally { await worker.drain(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
