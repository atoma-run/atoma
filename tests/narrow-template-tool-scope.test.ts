import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom, buildNarrowL1Prompt } from '../src/atoms/L2Atom.js';
import {
  bucketIdForTools, CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES, GROUND_TRUTH_EVIDENCE_LINES, groundTruthEvidenceLines,
} from '../src/atoms/capability.js';
import { undeclaredToolMentions } from '../src/atoms/verdict.js';
import { manifestSectionLines, manifestWriterLines, SHELL_RECEIPT_LINES } from '../src/contracts/probeManifest.js';
import { BUILTIN_TOOL_NAMES } from '../src/contracts/toolTaxonomy.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { Tool } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * A template must not teach a molecule a tool it does not hold. System
 * prompts are never scanned by `undeclaredToolMentions`, so the only guard is
 * this render: production molecule Sucrose (run f91cdb19, 2026-10-25), holding
 * run_shell and validate_html but no record_probe, was taught "USE record_probe"
 * by the generic contract and planned its tests through it twice. The guard
 * this replaces pinned three hand-picked signatures; Sucrose's was not one.
 */
const RECORDERS = ['record_probe', 'fetch_url', 'validate_html'] as const;

let root: string;
let declarations: Tool[];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atoma-tool-scope-'));
  declarations = defaultBuiltinTools({ sandbox: new ToolSandbox(root) }).map((tool) => tool.declaration);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
        const flagged = undeclaredToolMentions(requestText(call), names, { vocabulary: RECORDERS });
        if (flagged.length > 0) failures.push(`${call.role} [${names.join(',')}]: ${flagged.join(',')}`);
      }
      const contract = undeclaredToolMentions(groundTruthEvidenceLines(names).join('\n'), names, { vocabulary: RECORDERS });
      if (contract.length > 0) failures.push(`contract [${names.join(',')}]: ${contract.join(',')}`);
    }
    expect(failures).toEqual([]);
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
    expect(http).toContain('record_probe is intentionally NOT in the HTTP toolset');
  });

  it('keeps the file-scribe contract byte for byte', () => {
    // Its stored prompt, and the trust Ammonia, Urea and Estrogen earned on it,
    // must not move: the holder of record_probe renders exactly the old lines.
    expect(groundTruthEvidenceLines(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe']))
      .toEqual([...GROUND_TRUTH_EVIDENCE_LINES]);
    const scribe = buildNarrowL1Prompt('', declarations.filter((tool) =>
      ['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', 'record_probe'].includes(tool.name)));
    expect(scribe.endsWith(GROUND_TRUTH_EVIDENCE_LINES.join('\n'))).toBe(true);
    // Digests of the renders at d184d281, before the composition existed.
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    expect(sha(GROUND_TRUTH_EVIDENCE_LINES.join('\n'))).toBe('7c16d0ce600d3a30b03c4879d597f5a1e8daacb8fabd399fb32cc1f17a561252');
    expect(sha(CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES.join('\n'))).toBe('a8a3bf2833c3491afc3270969946144c612db7b6accd7a28d9b0648f8a28dd95');
    expect(sha(scribe)).toBe('040d4e105ec1b6a39eb8fa0bbc084aad2b98e1db398e8e9a61160b47633437e4');
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
