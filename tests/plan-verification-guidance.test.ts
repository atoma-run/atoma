import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom, taskRequiresRealBrowser } from '../src/atoms/L2Atom.js';
import { L3Atom, routeCrossBucketVerification } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { preservePlanLiteralContracts } from '../src/atoms/prompts.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import { planSchema } from '../src/atoms/json.js';
import { parallelDeclaredOutputCollision } from '../src/atoms/l3RootPlan.js';
import { enforceDelegationReview, routingIndexNote, ROUTING_INDEX_NOTE_MAX_CHARS } from '../src/atoms/delegationReview.js';
import type { Plan, SubtaskSpec, Tool } from '../src/core/types.js';

/**
 * Regression tests for the "VERIFICATION MATCHES THE ARTEFACT" rule in
 * both plan prompts. Observed failure (clock-cli live run, 2026-07-25):
 * L3's Opus plan gave a Node CLI build a "serve + validate_html"
 * phase 2 — Water burned 9 failed start_static_server boots and
 * fabricated a parasitic index.html just to have something to serve.
 * The plan prompts must steer verification to the probe matching the
 * artefact's nature (browser page → validate_html; HTTP API →
 * fetch_url; CLI/files → run_shell + read-back).
 */

const seed = {
  description: 'orchestrator',
  systemPrompt: 'sys',
  tools: [],
  params: {},
  createdBy: 'test',
};

describe('plan prompts — VERIFICATION MATCHES THE ARTEFACT', () => {
  it('the L3 Opus plan prompt carries the artefact-matched verification rule', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    const l3Type = r.create(3, seed);
    r.create(2, seed); // Tracheid
    const l3 = L3Atom.buildWithModel(l3Type, r, FALLBACK_OPUS);
    const ctx = makeCtx();
    // Prefilter escalates; the Opus plan call is call #1.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Tracheid', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: 't', preferredChild: 'Tracheid' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'stub',
        }
      )
    );
    await l3.plan({ description: 'build a tiny Node CLI utility' }, ctx);

    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toMatch(/== VERIFICATION MATCHES THE ARTEFACT ==/);
    // The three artefact families each name their probe.
    expect(planPrompt).toMatch(/start_static_server \+ validate_html/);
    expect(planPrompt).toMatch(/start_node_server \+ fetch_url/);
    expect(planPrompt).toMatch(/run_shell executing the/);
    // The observed failure mode is called out as a plan defect.
    expect(planPrompt).toMatch(/PLAN DEFECT/);
    expect(planPrompt).toMatch(/NO static server, NO/);
    expect(planPrompt).toMatch(/== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==/);
    expect(planPrompt).toMatch(/"harden index\.js"/);
    expect(planPrompt).toMatch(/read-only verifier.*replay old probes/s);
    expect(planPrompt).toMatch(/SEMANTIC entry/);
    expect(planPrompt).toMatch(/"csv2json\.js"/);
    expect(planPrompt).toMatch(/generic launcher.*"index\.js"/s);
    expect(planPrompt).toMatch(/HTTP DOCUMENTATION USES A PORT PLACEHOLDER/);
    expect(planPrompt).toMatch(/http:\/\/localhost:<port>/);
    expect(planPrompt).toMatch(/LISTENING_ON_PORT=<port>/);
    expect(planPrompt).toMatch(/PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION/);
    expect(planPrompt).toMatch(/FULL-STACK CAPABILITY RULE/);
    expect(planPrompt).toMatch(/never rename, replace or summarise away/);
  });

  it('the L2 Sonnet plan prompt carries the same rule (short form)', async () => {
    const r = new AtomRegistry(openDb(':memory:'));
    r.create(2, seed); // Tracheid
    r.create(1, { ...seed, description: 'file scribe' }); // Water
    const l2 = L2Atom.fromType(r.getByName('Tracheid')!, r);
    const ctx = makeCtx();
    // Prefilter escalates; the Sonnet plan call is call #1.
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: 't', preferredChild: 'Water' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'stub',
        }
      )
    );
    await l2.plan({ description: 'build a tiny Node CLI utility' }, ctx);

    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toMatch(/== VERIFICATION MATCHES THE ARTEFACT ==/);
    expect(planPrompt).toMatch(/NEVER send a non-browser/);
    expect(planPrompt).toMatch(/fabricate/);
    expect(planPrompt).toMatch(/== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==/);
    expect(planPrompt).toMatch(/exact intended output path/);
    expect(planPrompt).toMatch(/HTTP DOCUMENTATION USES A PORT PLACEHOLDER/);
    expect(planPrompt).toMatch(/PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION/);
    expect(planPrompt).toMatch(/REAL browser must route to an L1/);
  });
});

describe('preservePlanLiteralContracts', () => {
  it('mechanically carries exact HTTP schema clauses into every phase', () => {
    const goal =
      'Build POST /labels accepting {"name": string, "color": "#RRGGBB"} and GET /labels. ' +
      'Reject blank names, wrong types, and malformed colors with status 400.';
    const plan = makePlan({
      subtasks: [
        { description: 'Build the labels API.', preferredChild: 'Sclereid', inputs: {} },
        { description: 'Verify proper validation.', preferredChild: 'Sclereid', inputs: {} },
      ],
      aggregation: { mode: 'sequential' },
    });
    const enriched = preservePlanLiteralContracts(plan, goal);
    for (const subtask of enriched.subtasks) {
      expect(subtask.description).toContain('== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==');
      expect(subtask.description).toContain('{"name": string, "color": "#RRGGBB"}');
      expect(subtask.description).toContain('Reject blank names, wrong types');
    }
    expect(
      preservePlanLiteralContracts(enriched, enriched.subtasks[0]!.description).subtasks[0]!
        .description.match(/LITERAL CONTRACTS FROM TOP-LEVEL GOAL/g)
    ).toHaveLength(1);
  });

  it('leaves tasks without a structured literal contract untouched', () => {
    const plan = makePlan();
    expect(preservePlanLiteralContracts(plan, 'Write a friendly introduction.')).toBe(plan);
  });
});

describe('cross-bucket browser routing', () => {
  it('shows the validator the toolset inherited by a planned new molecule', async () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    const tools = ['write_file', 'start_node_server', 'fetch_url', 'validate_html'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
    const cellType = registry.create(2, { ...seed, tools });
    const tissueType = registry.create(3, { ...seed, tools });
    const cell = L2Atom.fromType(cellType, registry);
    const tissue = L3Atom.buildWithModel(tissueType, registry, FALLBACK_OPUS);
    const ctx = makeCtx();
    const task = { description: 'Verify the existing Node app in a real browser' };
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'create', seed: { description: 'server and browser verifier', systemPrompt: 'verify', tools: [], params: {} }, reasoning: 'needs both capabilities' },
      { reasoning: 'one live server', subtasks: [{ description: 'Boot the server, probe its API and drive the page against the same URL' }], aggregation: { mode: 'concat' }, expectedOutput: 'verified app' }
    ));
    const plan = await cell.plan(task, ctx);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'new child inherits required tools' }));
    await tissue.validatePlan(cell, plan, task, ctx);
    const request = ctx.llm.calls.at(-1)!;
    expect(request.userContent).toContain('Tools inherited by NEW children created by this delegator: write_file, start_node_server, fetch_url, validate_html');
    expect(request.systemPrompt).toContain('A newly created child has no registry name yet');
    expect(request.systemPrompt).toContain('Ordered tool calls WITHIN one leaf task are not parallel subtasks');
  });

  it.each([undefined, null])('preserves a planned new cell for combined server/browser proof (%s)', async (preferredChild) => {
    const registry = new AtomRegistry(openDb(':memory:'));
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });
    registry.create(2, { ...seed, tools: [tool('write_file'), tool('validate_html')] });
    const http = registry.create(2, { ...seed, tools: [tool('write_file'), tool('start_node_server'), tool('run_shell')] });
    const type = registry.create(3, { ...seed, tools: [tool('write_file'), tool('validate_html'), tool('start_node_server'), tool('run_shell')] });
    const l3 = L3Atom.buildWithModel(type, registry, FALLBACK_OPUS);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'combined capability' }));
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', target: http.name, reasoning: 'build with HTTP cell, create a combined verifier' },
      { reasoning: 'phased', subtasks: [
        { description: 'Build the Node server and page', preferredChild: http.name },
        { description: 'Boot the existing server and validate the UI in a real browser with selector-based interactions. Run node test-api.js and require it to pass.', preferredChild },
      ], aggregation: { mode: 'sequential' }, expectedOutput: 'verified app' }
    ));
    const plan = await l3.plan({ description: 'Build a server with a page' }, ctx);
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1]!.preferredChild).toBeUndefined();
    expect(plan.subtasks[1]!.description).toContain('Boot the existing server');
  });

  it('splits a mixed final checkpoint and routes browser/shell phases separately', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser', inputSchema: { type: 'object' } },
      ],
    });
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'run_shell', description: 'shell', inputSchema: { type: 'object' } },
        {
          name: 'start_node_server',
          description: 'server',
          inputSchema: { type: 'object' },
        },
      ],
    });
    const plan = makePlan({
      subtasks: [
        {
          description:
            'Validate the UI in a real browser with selector-based interactions and zero console errors.',
          preferredChild: 'Sclereid',
          inputs: {},
        },
        {
          description:
            'Reconfirm the UI probe in a real browser with selector-based interactions. Run node test-api.js and require it to pass.',
          preferredChild: 'Sclereid',
          inputs: {},
        },
      ],
      aggregation: { mode: 'sequential' },
    });
    const routed = routeCrossBucketVerification(plan, registry);
    expect(routed.subtasks).toHaveLength(3);
    expect(routed.subtasks[0]!.preferredChild).toBe('Tracheid');
    expect(routed.subtasks[1]!.description).toMatch(/BROWSER VERIFICATION ONLY/);
    expect(routed.subtasks[1]!.preferredChild).toBe('Tracheid');
    expect(routed.subtasks[2]!.description).toMatch(/FINAL SHELL\/HARNESS/);
    expect(routed.subtasks[2]!.description).toContain('node test-api.js');
    expect(routed.subtasks[2]!.preferredChild).toBe('Sclereid');
    expect(taskRequiresRealBrowser(routed.subtasks[2]!.description)).toBe(false);
    expect(routed.aggregation.mode).toBe('sequential');
  });

  it('keeps an already-capable web L2 and preserves explicit parallel aggregation', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser A', inputSchema: { type: 'object' } },
      ],
    });
    const secondWeb = registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser B', inputSchema: { type: 'object' } },
      ],
    });
    const plan = makePlan({
      subtasks: [
        {
          description: 'Validate the UI in a real browser with selector-based interactions.',
          preferredChild: secondWeb.name,
          inputs: {},
        },
      ],
      aggregation: { mode: 'concat' },
    });

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed).toBe(plan);
    expect(routed.subtasks[0]!.preferredChild).toBe(secondWeb.name);
    expect(routed.aggregation.mode).toBe('concat');
  });

  it('does not overwrite concat when a browser subtask needs rerouting', () => {
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser', inputSchema: { type: 'object' } },
      ],
    });
    const shell = registry.create(2, {
      ...seed,
      tools: [
        { name: 'run_shell', description: 'shell', inputSchema: { type: 'object' } },
        { name: 'start_node_server', description: 'server', inputSchema: { type: 'object' } },
      ],
    });
    const plan = makePlan({
      subtasks: [
        {
          description: 'Validate the UI in a real browser with selector-based interactions.',
          preferredChild: shell.name,
          inputs: {},
        },
      ],
      aggregation: { mode: 'concat' },
    });

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed.subtasks[0]!.preferredChild).not.toBe(shell.name);
    expect(routed.aggregation.mode).toBe('concat');
  });

  it('redirects a browser prefilter away from an HTTP-only L1', async () => {
    expect(taskRequiresRealBrowser('validate the UI in a real browser')).toBe(true);
    expect(taskRequiresRealBrowser('Reconfirm the recorded web probe remains valid.')).toBe(
      true
    );
    expect(
      taskRequiresRealBrowser(
        'Create server.js and probe its API.\n\n== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==\nRecord a selector-based web probe for window.__test.'
      )
    ).toBe(false);
    const registry = new AtomRegistry(openDb(':memory:'));
    registry.create(2, seed);
    registry.create(1, {
      ...seed,
      tools: [
        { name: 'validate_html', description: 'browser', inputSchema: { type: 'object' } },
      ],
    });
    registry.create(1, {
      ...seed,
      tools: [
        {
          name: 'start_node_server',
          description: 'server',
          inputSchema: { type: 'object' },
        },
      ],
    });
    // A toolless pick: everything it holds, the web molecule holds too.
    registry.create(1, { ...seed, description: 'scribe' });
    const task = {
      description:
        'Validate the UI in a real browser with selector-based interactions and zero console errors.',
    };
    const prefilterPick = (target: string) =>
      jsonText({ kind: 'reuse', target, confidence: 'high', reasoning: 'owns the UI' });

    // The pick holds nothing the web molecule lacks: the redirect stays a
    // fast path, one prefilter call and no planner.
    const fast = L2Atom.fromType(registry.getByName('Tracheid')!, registry);
    const fastCtx = makeCtx();
    fastCtx.llm.enqueueText(prefilterPick('Ammonia'));
    const fastPlan = await fast.plan(task, fastCtx);
    expect(fastPlan.subtasks[0]!.preferredChild).toBe('Water');
    expect(fastCtx.llm.calls).toHaveLength(1);

    // The pick holds start_node_server, which the web molecule lacks: since
    // ba878b06 (run ff102525) the redirect defers to the planner so the task
    // can split, with the web molecule as the hint, instead of handing the
    // whole task to a molecule that may not be able to do all of it.
    const split = L2Atom.fromType(registry.getByName('Tracheid')!, registry);
    const ctx = makeCtx();
    ctx.llm.enqueueText(prefilterPick('Methane'));
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'reuse', target: 'Water', reasoning: 'stub' },
        {
          reasoning: 'stub',
          subtasks: [{ description: task.description, preferredChild: 'Water' }],
          aggregation: { mode: 'concat' },
          expectedOutput: 'stub',
        }
      )
    );
    const plan = await split.plan(task, ctx);
    expect(plan.subtasks[0]!.preferredChild).toBe('Water');
    expect(ctx.llm.calls).toHaveLength(2);
    const planPrompt = ctx.llm.calls[1]!.userContent;
    expect(planPrompt).toMatch(/== PREFILTER HINT ==/);
    expect(planPrompt).toMatch(/identified "Water" as the reusable L1/);
    expect(planPrompt).toMatch(/Water lacks start_node_server, so the plan splits the task/);
  });
});

/**
 * DAG-AWARE CAPABILITY ROUTING (review 2026-10-16, point 7). b3af7c1e made
 * routing return any plan holding `dependsOn` or `acceptanceTests` untouched:
 * browser/shell routing was off for every plan the planning prompts now ask
 * for. Routing now classifies each node by typed contract, never splits an
 * implementation node, splits only output-less checkpoints, and remaps every
 * dependency onto the routed indices.
 */
describe('DAG-aware cross-bucket routing', () => {
  const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' } });

  function cells(options: { fullStack?: string[]; shellExtra?: string[] } = {}) {
    const registry = new AtomRegistry(openDb(':memory:'));
    const web = registry.create(2, { ...seed, tools: [tool('validate_html')] });
    const shellTools = ['run_shell', 'start_node_server', ...(options.shellExtra ?? [])];
    const shell = registry.create(2, { ...seed, tools: shellTools.map(tool) });
    const fullStack = options.fullStack
      ? registry.create(2, { ...seed, tools: options.fullStack.map(tool) })
      : undefined;
    return { registry, web: web.name, shell: shell.name, fullStack: fullStack?.name };
  }

  const SUITE = {
    requirement: 'module A exports render',
    cwd: '.',
    source: "import { test, expect } from 'vitest';\nimport { render } from './a.ts';\ntest('renders', () => {\n  expect(render()).toContain('<main');\n});",
  };
  const CHECKPOINT = 'Confirm the page in a real browser with selector-based interactions. Run node test-api.js and require it to pass.';

  function dagPlan(web: string, shell: string): Plan {
    return makePlan({
      subtasks: [
        { description: 'Scaffold the project.', preferredChild: shell, outputs: ['package.json'] },
        {
          description: 'Implement a.ts. Confirm the page in a real browser with selector-based interactions.',
          preferredChild: shell,
          outputs: ['a.ts'],
          acceptanceTests: SUITE,
        },
        { description: 'Implement b.ts.', preferredChild: shell, outputs: ['b.ts'], dependsOn: [0] },
        { description: CHECKPOINT, preferredChild: web, dependsOn: [1, 2] },
        { description: 'Write the README.', preferredChild: shell, outputs: ['README.md'], dependsOn: [3] },
      ],
      aggregation: { mode: 'concat' },
      acceptanceTests: SUITE,
    });
  }

  it('splits a DAG checkpoint, keeps the suite node whole, and remaps every dependency', () => {
    const { registry, web, shell } = cells();
    const plan = dagPlan(web, shell);

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed.subtasks).toHaveLength(6);
    expect(routed.subtasks[1]).toEqual(plan.subtasks[1]);
    expect(routed.subtasks[2]!.dependsOn).toEqual([0]);
    const browserPart = routed.subtasks[3]!;
    expect(browserPart.description).toMatch(/^BROWSER VERIFICATION ONLY/);
    expect(browserPart.preferredChild).toBe(web);
    expect(browserPart.dependsOn).toEqual([1, 2]);
    expect(browserPart.routedFrom).toEqual({ index: 3, role: 'browser-verification' });
    const shellPart = routed.subtasks[4]!;
    expect(shellPart.description).toMatch(/^FINAL SHELL\/HARNESS VERIFICATION ONLY/);
    expect(shellPart.preferredChild).toBe(shell);
    expect(shellPart.dependsOn).toEqual([1, 2, 3]);
    expect(shellPart.routedFrom).toEqual({ index: 3, role: 'shell-verification' });
    expect(routed.subtasks[5]!.dependsOn).toEqual([3, 4]);
    expect(routed.subtasks[5]!.description).toBe('Write the README.');
    expect(routed.aggregation.mode).toBe('concat');
    expect(routed.acceptanceTests).toBe(SUITE);
    expect(parallelDeclaredOutputCollision(routed)).toBeNull();

    const parsed = planSchema.parse(JSON.parse(JSON.stringify(routed)));
    expect(parsed.subtasks.map((subtask) => subtask.dependsOn)).toEqual(routed.subtasks.map((subtask) => subtask.dependsOn));
    expect(parsed.subtasks.some((subtask) => 'routedFrom' in subtask)).toBe(false);
  });

  it('never lets host parts satisfy the independent-work check for a linear planner DAG', () => {
    const { registry, web, shell } = cells();
    const plan = makePlan({
      subtasks: [
        { description: 'Build the app.', preferredChild: shell, outputs: ['app.ts'] },
        { description: CHECKPOINT, preferredChild: web, dependsOn: [0] },
        { description: 'Write the README.', preferredChild: shell, outputs: ['README.md'], dependsOn: [1] },
      ],
      aggregation: { mode: 'concat' },
    });
    const routed = routeCrossBucketVerification(plan, registry);
    expect(routed.subtasks).toHaveLength(4);

    const envelope = (count: number) => JSON.stringify({
      approved: true,
      reasoning: 'reviewed',
      delegationReview: {
        subtasks: Array.from({ length: count }, (_, index) => ({ index, kind: 'other', reason: 'scope' })),
        integration: { kind: 'other', reason: 'integration' },
        independentWork: true,
        parallelReason: 'claimed independent work',
      },
    });
    const routedRefusal = enforceDelegationReview(routed, envelope(4), false);
    const plannerRefusal = enforceDelegationReview(plan, envelope(3), false);

    expect(routedRefusal?.reasoning).toContain('Independent work must have parallel child branches');
    expect(plannerRefusal?.reasoning).toContain('Independent work must have parallel child branches');
  });

  describe('an implementation node is never split', () => {
    const browserAndCommand = 'Build the notes page in index.html. Confirm it in a real browser. Then make node test.js exit 0.';
    const browserOnly = 'Implement the page. Confirm it in a real browser with selector-based interactions.';
    const implementing = (shell: string, node: Partial<SubtaskSpec> & { description: string }): Plan => makePlan({
      subtasks: [
        { preferredChild: shell, outputs: ['index.html'], ...node },
        { description: 'Write the README.', preferredChild: shell, outputs: ['README.md'] },
      ],
      aggregation: { mode: 'concat' },
    });
    const shapes: [string, Partial<SubtaskSpec> & { description: string }][] = [
      ['an output-bearing node needing a browser and a command', { description: browserAndCommand }],
      ['a suite node needing a browser', { description: browserOnly, acceptanceTests: SUITE }],
    ];

    it.each(shapes)('%s stays whole without a full-stack cell', (_, node) => {
      const { registry, shell } = cells();
      const plan = implementing(shell, node);

      expect(routeCrossBucketVerification(plan, registry)).toBe(plan);
    });

    it.each(shapes)('%s moves whole to a full-stack cell holding every tool of its cell', (_, node) => {
      const { registry, shell, fullStack } = cells({ fullStack: ['validate_html', 'run_shell', 'start_node_server'] });
      const plan = implementing(shell, node);

      const routed = routeCrossBucketVerification(plan, registry);

      expect(routed.subtasks).toHaveLength(2);
      expect(routed.subtasks[0]).toEqual({ ...plan.subtasks[0], preferredChild: fullStack });
      expect(routed.subtasks[1]).toBe(plan.subtasks[1]);
    });

    it.each(shapes)('%s stays whole when the full-stack cell lacks a tool of its cell', (_, node) => {
      const { registry, shell } = cells({
        fullStack: ['validate_html', 'run_shell', 'start_node_server'],
        shellExtra: ['fetch_url'],
      });
      const plan = implementing(shell, node);

      expect(routeCrossBucketVerification(plan, registry)).toBe(plan);
    });

    it("keeps the planner's only subtask whole even without outputs (run 04ea696f)", () => {
      const { registry } = cells();
      const scribe = registry.create(2, seed);
      const plan = makePlan({
        subtasks: [{ description: browserAndCommand, preferredChild: scribe.name }],
        aggregation: { mode: 'sequential' },
      });

      expect(routeCrossBucketVerification(plan, registry)).toBe(plan);
    });
  });

  it('reroutes a browser-only checkpoint in place, keeping its dependencies', () => {
    const { registry, web, shell } = cells();
    const plan = makePlan({
      subtasks: [
        { description: 'Build the page.', preferredChild: shell, outputs: ['index.html'] },
        { description: 'Validate the UI in a real browser with selector-based interactions.', preferredChild: shell, dependsOn: [0] },
      ],
      aggregation: { mode: 'concat' },
    });

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed.subtasks).toHaveLength(2);
    expect(routed.subtasks[1]!.preferredChild).toBe(web);
    expect(routed.subtasks[1]!.dependsOn).toBe(plan.subtasks[1]!.dependsOn);
    expect(routed.subtasks[1]!.routedFrom).toBeUndefined();
  });

  it('leaves alone an invented cell, a plan without browser work, a full-stack cell and a dangling dependency', () => {
    const { registry, web, shell, fullStack } = cells({ fullStack: ['validate_html', 'run_shell', 'start_node_server'] });
    const withCheckpoint = (checkpoint: Partial<SubtaskSpec>): Plan => makePlan({
      subtasks: [
        { description: 'Build the app.', preferredChild: shell, outputs: ['app.ts'] },
        { description: CHECKPOINT, preferredChild: web, dependsOn: [0], ...checkpoint },
      ],
      aggregation: { mode: 'concat' },
    });
    const invented = withCheckpoint({ preferredChild: 'Xylem-Invented' });
    const fullStackCheckpoint = withCheckpoint({ preferredChild: fullStack });
    const dangling = withCheckpoint({ dependsOn: [5] });
    const noBrowser = withCheckpoint({ description: 'Run node test-api.js and require it to pass.', preferredChild: shell });

    expect(routeCrossBucketVerification(invented, registry)).toBe(invented);
    expect(routeCrossBucketVerification(fullStackCheckpoint, registry)).toBe(fullStackCheckpoint);
    expect(routeCrossBucketVerification(dangling, registry)).toBe(dangling);
    expect(routeCrossBucketVerification(noBrowser, registry)).toBe(noBrowser);
  });

  it('remaps declared keys of a sequential plan without adding a host edge', () => {
    const { registry, web, shell } = cells();
    const plan = makePlan({
      subtasks: [
        { description: 'Build the app.', preferredChild: shell, outputs: ['app.ts'] },
        { description: CHECKPOINT, preferredChild: web, dependsOn: [0] },
        { description: 'Write the README.', preferredChild: shell, outputs: ['README.md'], dependsOn: [1] },
      ],
      aggregation: { mode: 'sequential' },
    });

    const routed = routeCrossBucketVerification(plan, registry);

    expect(routed.subtasks.map((subtask) => subtask.dependsOn)).toEqual([undefined, [0], [0], [1, 2]]);
    expect(routed.aggregation.mode).toBe('sequential');
  });

  it('maps routed indices back to planner subtasks in a bounded note', () => {
    const { registry, web, shell } = cells();
    const plan = dagPlan(web, shell);
    const routed = routeCrossBucketVerification(plan, registry);

    expect(routingIndexNote(plan)).toBe('');
    const note = routingIndexNote(routed);
    expect(note).toContain('subtasks 3 and 4 are the host\'s browser then exact-shell verification of planner subtask 3');
    expect(note).toContain('Review indices refer to this routed plan.');
    expect(note).toContain('give it a cell holding validate_html, run_shell and start_node_server, or omit its preferredChild');

    const many = makePlan({
      subtasks: Array.from({ length: 60 }, (_, index): SubtaskSpec => ({
        description: CHECKPOINT,
        routedFrom: { index: Math.floor(index / 2), role: index % 2 === 0 ? 'browser-verification' : 'shell-verification' },
      })),
    });
    const bounded = routingIndexNote(many);
    expect(bounded.length).toBeLessThanOrEqual(ROUTING_INDEX_NOTE_MAX_CHARS);
    expect(bounded).toContain('more split checkpoint(s) not listed');
    expect(bounded).toContain('omit its preferredChild');
  });
});
