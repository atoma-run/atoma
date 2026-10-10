import { describe, it, expect, beforeEach } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { subtaskSpecSchema } from '../src/atoms/json.js';
import { delegatedCriteria, taskContextLines } from '../src/atoms/taskContext.js';
import { remediationTask, withAcceptanceChecklist } from '../src/run/depth.js';
import type { AcceptanceInfo } from '../src/contracts/depthRouting.js';
import type { Task } from '../src/core/types.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * A phase hears the criteria it must prove, word for word
 * (docs/incidents/first-refusals-2026-10-10.md). Runs 50be47bf and ebc60ee4
 * clicked before a keyboard journey their criterion said had "no mouse": the
 * molecule writing the check saw its phase description, never the criterion.
 */

const NO_MOUSE = 'Keyboard only, with no mouse: Tab reaches Remove and Enter empties the panel';
const RELOAD = 'A starred trip is still starred after a page reload';
const WIDTHS = 'No horizontal scroll at 375 px and at 1280 px';

const checklist = [
  { id: 'c1', behaviour: RELOAD, check: { kind: 'review' as const } },
  { id: 'c2', behaviour: NO_MOUSE, check: { kind: 'review' as const } },
  { id: 'c3', behaviour: WIDTHS, check: { kind: 'review' as const } },
];

const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };

describe('acceptance criteria reach the phase that proves them', () => {
  let reg: AtomRegistry;
  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
    for (let i = 0; i < TRUST_THRESHOLD_SUCCESSES; i++) reg.recordSuccess('Water');
  });

  it('a delegated cell assigns ids, and each molecule executes with its own criteria only', async () => {
    const root = withAcceptanceChecklist({ description: 'transit favourites' }, checklist, 'user');
    const original = { description: root.description, inputs: root.inputs };
    const phase: Task = {
      description: 'build and verify favourites',
      originalTask: original,
      inputs: { ...root.inputs, originalTask: original },
      criteria: root.criteria,
    };
    const cell = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueue((req) => {
      expect(req.userContent).toContain('"criteria": ["<id>", ...]');
      expect(req.userContent).toContain(`- c2: ${NO_MOUSE}`);
      return {
        text: jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'reuse' }, {
          reasoning: 'build, then the keyboard check',
          subtasks: [
            { description: 'phase-1: build', preferredChild: 'Water', outputs: ['index.html'], criteria: ['c1', 'c9', 7] },
            { description: 'phase-2: keyboard check', preferredChild: 'Water', criteria: ['c2'] },
          ],
          aggregation: { mode: 'sequential' },
          expectedOutput: 'page',
        }),
        stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 },
      };
    });
    for (const p of ['phase-1', 'phase-2']) {
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: p, expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ output: `output-${p}`, summary: `summary-${p}` }));
    }

    await cell.handleDirect(phase, ctx);

    const execute = ctx.llm.calls.filter((c) => c.role === 'execute').map((c) => c.userContent);
    expect(execute).toHaveLength(2);
    // Phase 1 named c1 (c9 is unknown, 7 is not an id).
    expect(execute[0]).toContain(`- c1: ${RELOAD}`);
    expect(execute[0]).not.toContain(NO_MOUSE);
    expect(execute[0]).not.toContain(WIDTHS);
    expect(execute[1]).toContain(`- c2: ${NO_MOUSE}`);
    // c3 was named by no subtask: the last phase hears it as context only.
    expect(execute[1]).toContain(`- c3: ${WIDTHS}`);
    expect(execute[1]).toContain('the root acceptor will also judge');
    expect(execute[1]).not.toContain(`- c1: ${RELOAD}`);
    expect(execute[1]).toContain('approved by the user');
  });

  it('the plan parse keeps string ids and drops the rest', () => {
    expect(subtaskSpecSchema.parse({ description: 'd', criteria: [' c2 ', 'c2', 3, ''] }).criteria).toEqual(['c2']);
    expect(subtaskSpecSchema.parse({ description: 'd', criteria: null }).criteria).toBeUndefined();
  });

  it('an id no subtask names reaches the last sequential phase as context, never as its requirement', () => {
    const parent: Task = { description: 'p', criteria: withAcceptanceChecklist({ description: 'p' }, checklist, 'user').criteria };
    const subtasks = [{ description: 'build', criteria: ['c2'] }, { description: 'write README' }];
    expect(delegatedCriteria(parent, subtasks, 0, true).criteria?.map((c) => c.id)).toEqual(['c2']);
    const last = delegatedCriteria(parent, subtasks, 1, true).criteria ?? [];
    expect(last.map((c) => [c.id, c.unassigned])).toEqual([['c1', true], ['c3', true]]);
    const lines = taskContextLines({ description: 'write README', originalTask: { description: 'p' }, criteria: last }).join('\n');
    expect(lines).toContain('they add no requirement to this phase');
    expect(lines).not.toContain('must prove');
    expect(delegatedCriteria({ description: 'p' }, subtasks, 1, true)).toEqual({});
  });

  it('parallel lanes have no last one: unassigned ids reach none of them, a lone subtask gets them', () => {
    const parent: Task = { description: 'p', criteria: withAcceptanceChecklist({ description: 'p' }, checklist, 'user').criteria };
    const lanes = [{ description: 'a', criteria: ['c1'] }, { description: 'b' }];
    expect(delegatedCriteria(parent, lanes, 0, false).criteria?.map((c) => c.id)).toEqual(['c1']);
    expect(delegatedCriteria(parent, lanes, 1, false)).toEqual({});
    expect(delegatedCriteria(parent, [{ description: 'whole task' }], 0, false).criteria?.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('only a delegated phase renders them; the root planner reads the whole list through inputs', () => {
    const root = withAcceptanceChecklist({ description: 'r' }, checklist, 'user');
    expect(taskContextLines(root).join('\n')).not.toContain('Acceptance criteria this phase must prove');
    const original = { description: 'r' };
    const delegated: Task = { description: 'p', originalTask: original, criteria: root.criteria };
    const lines = taskContextLines(delegated).join('\n');
    expect(lines).toContain('Acceptance criteria this phase must prove');
    expect(lines).toContain('Prove each part with an executed check');
    const reasoning = taskContextLines({ ...delegated, executionMode: 'reasoning' }).join('\n');
    expect(reasoning).toContain('answer every one explicitly');
    expect(reasoning).not.toContain('Prove each part with an executed check');
  });

  it('a drafted list informs the phase without becoming its requirement', () => {
    const drafted = withAcceptanceChecklist({ description: 'r' }, checklist).criteria;
    const lines = taskContextLines({ description: 'p', originalTask: { description: 'r' }, criteria: drafted }).join('\n');
    expect(lines).toContain('they add no requirement to this phase');
    expect(lines).not.toContain('must prove');
  });

  it('a remediation pass hears only the criteria the acceptor did not judge met', () => {
    const root = withAcceptanceChecklist({ description: 'r' }, checklist, 'user');
    const judged = (met: Record<string, boolean>): AcceptanceInfo => ({
      approved: false, reasoning: 'c2 used a click', gates: [], floorCoverage: [], probe: {},
      checklist: checklist.map((item) => ({ ...item, status: 'review', judgement: { met: met[item.id]!, reason: 'r' } })),
    } as unknown as AcceptanceInfo);
    expect(remediationTask(root, judged({ c1: true, c2: false, c3: true })).criteria?.map((c) => c.id)).toEqual(['c2']);
    expect(remediationTask(root, judged({ c1: true, c2: true, c3: true })).criteria).toBeUndefined();
    const unjudged = { approved: false, reasoning: 'gate', gates: [], floorCoverage: [], probe: {} } as unknown as AcceptanceInfo;
    expect(remediationTask(root, unjudged).criteria?.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('an http criterion keeps the request that covers it', () => {
  it('names method, path and status', () => {
    const root = withAcceptanceChecklist({ description: 'r' }, [
      { id: 'c1', behaviour: 'Unknown notes answer JSON 404', check: { kind: 'http', method: 'GET', path: '/api/notes/missing', status: 404 } },
    ], 'user');
    expect(root.criteria?.[0]?.behaviour).toBe('Unknown notes answer JSON 404 (fetch_url GET /api/notes/missing → 404)');
  });
});
