import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

/**
 * Production runs 2026-09-27: molecules holding validate_html's `viewport`
 * argument laid every page out at 800x600 under "usable at 375 px" — once
 * after a refusal that named the gap — and proved each <select> by assigning
 * its value from the smoke. Both lines reach a molecule at execution, not
 * through a stored prompt, so branches receive them too.
 */
describe('browser proof lines at execution', () => {
  const molecule = () => new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: 'a stored prompt that predates the rule',
    tools: makeTools(['write_file', 'validate_html']), params: {} });

  it('names every width the task and its approved criteria name, and the select interaction', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
    await molecule().execute({
      description: 'Build a configurator usable on a 375 px wide phone',
      inputs: { acceptanceChecklist: { items: ['c1: the estimate sits beside the steps at 1280 px on desktop (judged by review)'] } },
    }, makePlan({ proposedAction: 'build' }), ctx);
    const prompt = ctx.llm.calls[0]!.userContent;
    expect(prompt).toContain('This task names 375 px and 1280 px wide. Lay the page out at EACH with its own');
    expect(prompt).toContain('viewport {width: 375}');
    expect(prompt).toContain('{type:"select", selector, value}');
  });

  it('adds no width line when the task names none, and nothing without a browser tool', async () => {
    const plain = makeCtx();
    plain.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
    await molecule().execute({ description: 'Build a pomodoro timer' }, makePlan({ proposedAction: 'build' }), plain);
    expect(plain.llm.calls[0]!.userContent).not.toContain('This task names');
    const scribe = new L1Atom({ name: 'Ammonia', ordinal: 2, systemPrompt: '', tools: makeTools(['write_file']), params: {} });
    const docs = makeCtx();
    docs.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
    await scribe.execute({ description: 'Document the 375 px wide phone layout' }, makePlan({ proposedAction: 'document' }), docs);
    expect(docs.llm.calls[0]!.userContent).not.toContain('This task names');
    expect(docs.llm.calls[0]!.userContent).not.toContain('{type:"select"');
  });
});
