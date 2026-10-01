import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { withToolLine } from '../src/atoms/capability.js';
import { prefilterCacheKey } from '../src/atoms/prefilterCache.js';
import { parsePrefilterPrompt, type RecordedDecision } from '../src/atoms/jevCalibration.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import type { JevChoiceRequest, JevDecider, Tool } from '../src/core/types.js';

/**
 * ROUTING SEES WHAT A MOLECULE CAN CALL. Run ff102525 (2026-10-01): the cell's
 * prefilter, shown names and descriptions only, gave "update the page and
 * delete server.js" to the web molecule at high confidence. None of its tools
 * deletes a file, and six plans were refused for it.
 */

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const WEB_TOOLS = ['write_file', 'edit_file', 'start_static_server', 'validate_html'];
const SCRIBE_TOOLS = ['read_file', 'write_file', 'run_shell'];

function cellWithMolecules() {
  const reg = new AtomRegistry(openDb(':memory:'));
  const seed = (description: string, tools: string[]) => ({ description, systemPrompt: 's', params: {}, createdBy: 'test', tools: tools.map(tool) });
  const web = reg.create(1, seed('single-file web artefact builder', WEB_TOOLS));
  const scribe = reg.create(1, seed('file scribe', SCRIBE_TOOLS));
  const cell = L2Atom.fromType(reg.create(2, seed('web cell', [...new Set([...WEB_TOOLS, ...SCRIBE_TOOLS])])), reg);
  return { web, scribe, cell };
}

/** A Jev that never decides and keeps what it was asked. */
function listeningJev() {
  const chosen: JevChoiceRequest[] = [];
  const jev: JevDecider = {
    choose: (request) => {
      chosen.push(request);
      return Promise.resolve(null);
    },
    approve: () => Promise.resolve(null),
    twin: () => Promise.resolve(null),
  };
  return { jev, chosen };
}

describe("a molecule's tools in the cell's routing catalogs (run ff102525)", () => {
  it('reach the prefilter, Jev and the planner, and the calibration reads back what Jev saw', async () => {
    const { web, scribe, cell } = cellWithMolecules();
    const { jev, chosen } = listeningJev();
    const ctx = { ...makeCtx(), jev };
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'the page edit and the deletion need two molecules' }));
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', reasoning: 'split by tools' },
      { reasoning: 'r', subtasks: [{ description: 'edit the page', preferredChild: web.name }, { description: 'delete server.js', preferredChild: scribe.name }],
        aggregation: { mode: 'sequential' }, expectedOutput: 'page edited, file deleted' },
    ));
    await cell.plan({ description: 'Update index.html and delete server.js' }, ctx);

    const [prefilter, planner] = ctx.llm.calls;
    expect(prefilter!.role).toBe('prefilter');
    expect(prefilter!.userContent).toContain(`  - ${web.name}: single-file web artefact builder\n    tools: ${[...WEB_TOOLS].sort().join(', ')}`);
    expect(prefilter!.userContent).toContain(`  - ${scribe.name}: file scribe\n    tools: ${[...SCRIBE_TOOLS].sort().join(', ')}`);
    // Jev was asked about the very entries the model read.
    const asked = chosen[0]!.candidates.map(({ name, description }) => ({ name, description }));
    expect(asked).toEqual([
      { name: web.name, description: `single-file web artefact builder\n    tools: ${[...WEB_TOOLS].sort().join(', ')}` },
      { name: scribe.name, description: `file scribe\n    tools: ${[...SCRIBE_TOOLS].sort().join(', ')}` },
    ]);
    const recorded: RecordedDecision = {
      runId: 'r', orgId: 'o', startedAt: '2026-10-01T00:00:00.000Z', eventId: 'e', role: 'prefilter',
      actor: { name: cell.name, tier: 2 }, recipe: false, userContent: prefilter!.userContent, response: '{}',
    };
    expect(parsePrefilterPrompt(recorded)!.candidates).toEqual(asked);
    // The planner's catalog carries the same line under each molecule.
    expect(planner!.userContent).toContain(`  - ${web.name}: single-file web artefact builder\n    tools: ${[...WEB_TOOLS].sort().join(', ')}`);
    expect(planner!.userContent.replace(/\s+/g, ' ')).toContain('split a subtask that needs tools no single L1 holds before you "create" an L1 for it.');
  });

  it('render the same for the same tools in any order, nothing for none, and key the cache', () => {
    expect(withToolLine('web', [tool('validate_html'), tool('write_file')])).toBe(withToolLine('web', [tool('write_file'), tool('validate_html')]));
    expect(withToolLine('web', [])).toBe('web');
    const key = (tools: string[]) => prefilterCacheKey({
      systemPrompt: PREFILTER_SYSTEM_PROMPT, model: 'm', taskDescription: 't', excluded: [],
      catalogLines: [`  - Water: ${withToolLine('web', tools.map(tool))}`],
    });
    expect(key(['write_file', 'validate_html'])).not.toBe(key(['write_file', 'validate_html', 'run_shell']));
  });

  it('send a browser task to the planner when the pick held a tool the web molecule lacks', async () => {
    const { web, scribe, cell } = cellWithMolecules();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: scribe.name, confidence: 'high', decomposable: false, reasoning: 'can delete' }));
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', reasoning: 'split by tools' },
      { reasoning: 'r', subtasks: [{ description: 'edit and verify the page', preferredChild: web.name }, { description: 'delete server.js', preferredChild: scribe.name }],
        aggregation: { mode: 'sequential' }, expectedOutput: 'page edited, file deleted' },
    ));
    const plan = await cell.plan({ description: 'Update index.html, verify it in a real browser, and delete server.js' }, ctx);
    // No fast path onto the web molecule: the planner was asked, and split it.
    expect(ctx.llm.calls.map((call) => call.role)).toEqual(['prefilter', 'plan']);
    expect(plan.subtasks.map((subtask) => subtask.preferredChild)).toEqual([web.name, scribe.name]);
  });

  it('are what the prefilter is told to match against', () => {
    const rule = PREFILTER_SYSTEM_PROMPT.replace(/\s+/g, ' ');
    expect(rule).toContain('An entry may end with a "tools:" line: the ONLY tools that candidate can call.');
    expect(rule).toContain('They are necessary, not sufficient: a pick must have tools for EVERY action the task needs AND share its workflow shape, as above.');
    expect(rule).toContain('prefer the one with the fewest tools the task does not use. When none qualifies, escalate so the supervisor can split the task.');
    expect(rule).toContain('start_node_server boots a Node script, never a static page; only run_shell deletes or moves files');
  });
});
