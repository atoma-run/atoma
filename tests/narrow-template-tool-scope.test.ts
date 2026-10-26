import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import {
  bucketIdForTools, CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES, CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES, GROUND_TRUTH_EVIDENCE_LINES,
  groundTruthEvidenceLines,
} from '../src/atoms/capability.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { undeclaredToolMentions } from '../src/atoms/verdict.js';
import { manifestSectionLines, manifestWriterLines, SHELL_RECEIPT_LINES } from '../src/contracts/probeManifest.js';
import { BUILTIN_TOOL_NAMES } from '../src/contracts/toolTaxonomy.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { Tool } from '../src/core/types.js';
import { makeCtx, jsonText, silentLogger } from './helpers.js';

/**
 * A template must not teach a molecule a tool it does not hold. System
 * prompts are never scanned by `undeclaredToolMentions`, so the only guard is
 * this render: production molecule Sucrose (run f91cdb19, 2026-10-25), holding
 * run_shell and validate_html but no record_probe, was taught "USE record_probe"
 * by the generic contract and planned its tests through it twice. The guard
 * this replaces pinned three hand-picked signatures; Sucrose's was not one.
 */
const RECORDERS = ['record_probe', 'fetch_url', 'validate_html'] as const;
const NOT_HELD_SENTENCE = 'record_probe is intentionally NOT';
/** Production molecule Melatonin's tools (2026-10-26): no write_file, so the unknown-bucket template. */
const MELATONIN = ['read_file', 'list_files', 'run_shell', 'record_probe', 'fetch_url', 'start_node_server'];
/** Production molecule ATP's tools: trusted, template-born, no start_node_server. */
const ATP = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe', 'fetch_url'];

let root: string;
let declarations: Tool[];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-tool-scope-'));
  declarations = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every subset of the builtins. */
function allSubsets(): string[][] {
  const subsets: string[][] = [];
  for (let mask = 0; mask < 1 << BUILTIN_TOOL_NAMES.length; mask++) {
    subsets.push(BUILTIN_TOOL_NAMES.filter((_, bit) => (mask & (1 << bit)) !== 0));
  }
  return subsets;
}

/** Every subset of the builtins that holds write_file, the one tool every template-born molecule holds. */
function subsetsWithWriteFile(): string[][] {
  const others = BUILTIN_TOOL_NAMES.filter((name) => name !== 'write_file');
  const subsets: string[][] = [];
  for (let mask = 0; mask < 1 << others.length; mask++) {
    subsets.push(['write_file', ...others.filter((_, bit) => (mask & (1 << bit)) !== 0)]);
  }
  return subsets;
}

function requestText(call: { systemPrompt?: string; userContent?: unknown; tools?: readonly Tool[] }): string {
  return [
    call.systemPrompt ?? '',
    typeof call.userContent === 'string' ? call.userContent : JSON.stringify(call.userContent ?? ''),
    ...(call.tools ?? []).map((tool) => `${tool.name}: ${tool.description} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
}

describe('the L1 request names only the recorders a molecule holds', () => {
  it('over every tool subset holding write_file, plan and execute requests never affirm an unheld recorder', async () => {
    const subsets = subsetsWithWriteFile();
    expect(subsets).toHaveLength(2 ** (BUILTIN_TOOL_NAMES.length - 1));
    const failures: string[] = [];
    for (const names of subsets) {
      const tools = declarations.filter((tool) => names.includes(tool.name));
      const atom = new L1Atom({ name: 'Sucrose', ordinal: 1, systemPrompt: buildNarrowL1Prompt('', tools), tools, params: {} });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'update the module and verify it', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
      const task = { description: 'Update the existing module so it handles an empty input, then verify the change.' };
      const plan = await atom.plan(task, ctx);
      await atom.execute(task, plan, ctx);
      expect(ctx.llm.calls.map((call) => call.role)).toEqual(['plan', 'execute']);
      for (const call of ctx.llm.calls) {
        // The whole request is scanned for recorders only: runtime guidance
        // outside the manifest section names other tools to non-holders
        // (start_node_server to a run_shell holder), a separate matter.
        const flagged = undeclaredToolMentions(requestText(call), names, { vocabulary: RECORDERS });
        if (flagged.length > 0) failures.push(`${call.role} [${names.join(',')}]: ${flagged.join(',')}`);
        if (names.includes('record_probe') && requestText(call).includes(NOT_HELD_SENTENCE)) {
          failures.push(`${call.role} [${names.join(',')}]: told it lacks the record_probe it holds`);
        }
      }
      const contract = undeclaredToolMentions(groundTruthEvidenceLines(names).join('\n'), names, { vocabulary: RECORDERS });
      if (contract.length > 0) failures.push(`contract [${names.join(',')}]: ${contract.join(',')}`);
      // The composed manifest section names no unheld builtin at all, the
      // server tools included (ATP was taught start_node_server, 2026-10-26).
      const section = undeclaredToolMentions(manifestSectionLines(names).join('\n'), names, { vocabulary: BUILTIN_TOOL_NAMES });
      if (section.length > 0) failures.push(`section [${names.join(',')}]: ${section.join(',')}`);
    }
    expect(failures).toEqual([]);
  });

  it('never tells a holder of record_probe that it lacks it, over every subset of the builtins', () => {
    const told = allSubsets()
      .filter((names) => names.includes('record_probe'))
      .filter((names) => manifestSectionLines(names).join('\n').includes(NOT_HELD_SENTENCE)
        || buildNarrowL1Prompt('', declarations.filter((tool) => names.includes(tool.name))).includes(NOT_HELD_SENTENCE));
    expect(told).toEqual([]);
  });

  it('composes the manifest section from the recorders held', () => {
    expect(manifestSectionLines(['write_file', 'run_shell', 'record_probe'])).toEqual(manifestWriterLines('shell'));
    expect(manifestSectionLines(['write_file', 'run_shell'])).toEqual(SHELL_RECEIPT_LINES);
    expect(manifestSectionLines(['write_file', 'read_file'])).toEqual([]);
    const sucrose = manifestSectionLines(['write_file', 'run_shell', 'validate_html']).join('\n');
    expect(sucrose).toContain(SHELL_RECEIPT_LINES.join('\n'));
    expect(sucrose).toContain(manifestWriterLines('web').join('\n'));
    expect(sucrose).not.toContain('record_probe');
    expect(sucrose).not.toMatch(/by hand \(/);
    // The recorder-less sentence offers no hand-write path and names no tool.
    for (const name of BUILTIN_TOOL_NAMES) expect(SHELL_RECEIPT_LINES.join(' ')).not.toContain(name);
    // The HTTP block quotes a host receipt for its harness; it no longer asks
    // for a shell entry that write_file refuses.
    const http = manifestWriterLines('http').join(' ');
    expect(http).toContain('run it with run_shell and quote the host receipt');
    expect(http).not.toMatch(/APPEND a shell entry/);
    // The canonical text, for the canonical HTTP molecule that does not hold it.
    expect(http).toContain('record_probe is intentionally NOT in the HTTP toolset');
  });

  it('keeps the canonical HTTP molecule\'s prompt byte for byte, and renders it for its bucket without record_probe', () => {
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    // Digests at c6d55ed8, before the HTTP block depended on the tools held.
    expect(sha(manifestWriterLines('http').join('\n'))).toBe('d4dd43e8a6293ea373b11c01c3fd48aa4a57db2900e74b145dd6ce1fd638dd97');
    expect(sha(CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES.join('\n'))).toBe('b2e501fdcd08eb3dd3136d0207d905e94d45db2801472b65f47039be04e32c28');
    const scope = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'fetch_url', 'start_node_server'];
    const tools = declarations.filter((tool) => scope.includes(tool.name));
    expect(bucketIdForTools(tools)).toBe('http-server-build+probe');
    expect(buildNarrowL1Prompt('', tools).endsWith(CANONICAL_HTTP_L1_SYSTEM_PROMPT_LINES.join('\n'))).toBe(true);
  });

  it('tells an HTTP-bucket holder of record_probe to record its harness, never to run it with run_shell', () => {
    const scope = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe', 'fetch_url', 'start_node_server'];
    const tools = declarations.filter((tool) => scope.includes(tool.name));
    expect(bucketIdForTools(tools)).toBe('http-server-build+probe');
    const prompt = buildNarrowL1Prompt('', tools);
    expect(prompt).toContain('run it with record_probe {"cmd": "node <harness>"}');
    expect(prompt).not.toContain('run it with run_shell');
    expect(prompt).not.toContain(NOT_HELD_SENTENCE);
  });

  it('ATP, holding record_probe and fetch_url without start_node_server, is taught neither server boot nor a missing record_probe', () => {
    const tools = declarations.filter((tool) => ATP.includes(tool.name));
    const prompt = buildNarrowL1Prompt('', tools);
    expect(prompt).toContain('USE record_probe');
    expect(prompt).not.toContain('start_node_server');
    expect(prompt).not.toContain('NOT in the HTTP toolset');
    expect(prompt).not.toContain('run it with run_shell');
    expect(prompt).toContain('The L1 runtime forces every loopback fetch to record');
  });

  it('keeps the file-scribe contract byte for byte', () => {
    // Its stored prompt, and the trust Ammonia, Urea and Estrogen earned on it,
    // must not move: the holder of record_probe renders exactly the old lines.
    expect(groundTruthEvidenceLines(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe']))
      .toEqual([...GROUND_TRUTH_EVIDENCE_LINES]);
    const scribe = buildNarrowL1Prompt('', declarations.filter((tool) =>
      ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe'].includes(tool.name)));
    expect(scribe.endsWith(GROUND_TRUTH_EVIDENCE_LINES.join('\n'))).toBe(true);
    // Digests of the renders at d184d281, before the composition existed. The
    // whole render moved once since, on purpose: its "Call tools sequentially"
    // line now allows independent calls in one response (run a4dcf853); a
    // template revision is refreshed with the streak kept (src/registry).
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    expect(sha(GROUND_TRUTH_EVIDENCE_LINES.join('\n'))).toBe('7c16d0ce600d3a30b03c4879d597f5a1e8daacb8fabd399fb32cc1f17a561252');
    expect(sha(CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES.join('\n'))).toBe('a8a3bf2833c3491afc3270969946144c612db7b6accd7a28d9b0648f8a28dd95');
    expect(sha(scribe)).toBe('2331dce766720439ede9901bc8ea60061d5aacc9e583fe4e43439f8a505a271e');
  });

  it('Sucrose, created through the real createSubtaskL1 from Idioblast, gets one web-aware contract and no record_probe', () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const fullStack = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'fetch_url', 'start_node_server', 'validate_html'];
      const cellType = reg.create(2, {
        description: 'Node full-stack cell', systemPrompt: 'You NEVER invoke elements yourself.',
        tools: declarations.filter((tool) => fullStack.includes(tool.name)), params: {}, createdBy: 'test',
      });
      const cell = L2Atom.fromType(cellType, reg);
      const sucroseTools = ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'validate_html', 'start_node_server'];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = (cell as any).createSubtaskL1(
        { description: 'run the browser suite' },
        { action: 'create', seed: { tools: sucroseTools, params: {} } },
        { description: 'parent' }
      ) as ReturnType<AtomRegistry['create']>;
      expect(created.tools.map((tool) => tool.name).sort()).toEqual([...sucroseTools].sort());
      expect(bucketIdForTools(created.tools)).toBe('web-artefact-write+validate');
      expect(created.systemPrompt.split('RESULT-REPORTING CONTRACT (mandatory)').length - 1).toBe(1);
      expect(created.systemPrompt).not.toContain('USE record_probe');
      expect(created.systemPrompt).toContain(manifestWriterLines('web').join('\n'));
      expect(created.systemPrompt).toContain(SHELL_RECEIPT_LINES.join('\n'));
      expect(undeclaredToolMentions(created.systemPrompt, sucroseTools, { minNonNegated: 1 })).toEqual([]);
    } finally { db.close(); }
  });
});

describe('Melatonin\'s HTTP harness, recorded as its prompt says, passes the gate that reads its manifest', () => {
  let workspace: string;
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'atoma-melatonin-'));
    writeFileSync(join(workspace, 'test-api.js'), 'process.exit(0);\n');
  });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  it('is taught record_probe for its harness, and record_probe\'s row satisfies required-command-manifest', async () => {
    const prompt = buildNarrowL1Prompt('', declarations.filter((tool) => MELATONIN.includes(tool.name)));
    // Before 2026-10-26 its http block said "run it with run_shell", which
    // writes no row: the gate, reading a holder's manifest, then refused.
    expect(prompt).not.toContain('run it with run_shell');
    expect(prompt).not.toContain(NOT_HELD_SENTENCE);
    expect(prompt).toContain('run it with record_probe {"cmd": "node <harness>"}');

    const box = new ToolSandbox(workspace);
    const tools = new InMemoryToolRegistry();
    tools.registerAll(defaultBuiltinTools({ sandbox: box, logger: silentLogger() }).filter((tool) => MELATONIN.includes(tool.declaration.name)));
    const ctx = { ...makeCtx(), tools };
    const task = { description: 'Build the API so that node test-api.js passes.' };
    const result = { output: {}, summary: 'done', trace: [], producedBy: { tier: 1 as const, name: 'Melatonin', viaFallback: false } };
    const gate = () => runResultGates(buildResultGateEnv({ task, result, childName: 'Melatonin', childToolNames: MELATONIN, ctx }), new Set());
    try {
      await tools.execute('run_shell', { cmd: 'node test-api.js' });
      expect((await gate()).rejection).toMatchObject({ gateId: 'required-command-manifest' });
      await tools.execute('record_probe', { cmd: 'node test-api.js' });
      expect((await gate()).rejection).toBeNull();
    } finally {
      await box.cleanup();
    }
  });
});
