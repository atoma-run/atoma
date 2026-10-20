import { describe, expect, it } from 'vitest';
import { explainEvent } from '../src/viz/client/event-explanation.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { VizEvent, VizRun } from '../src/viz/client/types.js';

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const run: VizRun = { id: 'run', label: 'Inspect the project', startedAt: '2026-10-20T05:33:16Z', events: [] };
const event = (extra: Partial<VizEvent>): VizEvent => ({ id: 'step', ts: 1, kind: 'tool', ...extra });
const values = (value: ReturnType<typeof explainEvent>) => value.nodes.flatMap(node => node.kind === 'field' ? [node.value] : []);

describe('plain-language event explanation', () => {
  it('explains an edit without exposing its raw replacement payload', () => {
    const detail = explainEvent(event({ name: 'edit_file', args: { path: 'tests/scenarios.ts', old_string: 'PRIVATE BEFORE', new_string: 'PRIVATE AFTER' },
      result: { ok: true, path: 'tests/scenarios.ts', bytes: 14_868, replacements: 1 } }), run, t);
    expect(detail.title).toBe('Updating a file');
    expect(values(detail)).toContain('tests/scenarios.ts');
    expect(values(detail)).toContain('1 section of the file was replaced.');
    expect(JSON.stringify(detail)).not.toContain('PRIVATE BEFORE');
    expect(JSON.stringify(detail)).not.toContain('14868');
  });

  it('does not present a recorded failed probe as a successful verification', () => {
    const detail = explainEvent(event({ name: 'record_probe', result: { recorded: true, exitCode: 127, stderr: 'tsc: not found' } }), run, t);
    expect(values(detail)).toContain('This action reported a problem');
    expect(values(detail)).toContain('The failed check was saved as evidence. Saving it does not mean it passed.');
    expect(detail.nodes.find(node => node.key === 'outcome')).toMatchObject({ tone: 'error' });
  });

  it('keeps browser failures visible even when the nested smoke succeeds', () => {
    const detail = explainEvent(event({ name: 'validate_html', result: { ok: false, smokeResult: { ok: true }, errors: ['Button not found'] } }), run, t);
    expect(values(detail)).toContain('This action reported a problem');
    expect(values(detail)).toContain('Button not found');
  });

  it('distinguishes missing receipts from a successful operation', () => {
    const detail = explainEvent(event({ name: 'edit_file', args: { path: 'app.ts' } }), run, t);
    expect(values(detail)).toContain('This action was recorded; its outcome is not confirmed');
    expect(detail.nodes.find(node => node.key === 'outcome')).toMatchObject({ tone: 'neutral' });
  });

  it('reads array-shaped plans and retains their recorded task descriptions', () => {
    const detail = explainEvent(event({ kind: 'llm', role: 'plan', response: JSON.stringify([
      { strategy: 'reuse', reasoning: 'Inspect before making changes.' },
      { reasoning: 'Read only.', subtasks: [{ description: 'Inspect the scheduler.' }] },
    ]) }), run, t);
    expect(values(detail)).toContain('Inspect before making changes.\n\nRead only.');
    expect(detail.nodes.find(node => node.key === 'steps')).toMatchObject({ children: [{ value: 'Inspect the scheduler.' }] });
  });

  it('explains rejection and deferral without treating either as an approved delivery', () => {
    const rejected = explainEvent(event({ kind: 'llm', role: 'validate-result', response: '{"approved":false,"reasoning":"The test did not run."}' }), run, t);
    expect(values(rejected)).toContain('Changes were requested for this step');
    expect(values(rejected)).toContain('The test did not run.');
    const deferred = explainEvent(event({ kind: 'jev', role: 'validate-result', outcome: 'deferred to the model (requirement 1 shown_done (0.63))' }), run, t);
    expect(values(deferred)).toContain('A model was asked to review this decision');
    expect(JSON.stringify(deferred)).not.toContain('0.63');
  });

  it.each(['branch', 'trust', 'cache', 'context', 'registry', 'skill', 'topology', 'acceptance', 'future-event'])(
    'explains the %s family and preserves unknown events', kind => {
      const detail = explainEvent(event({ kind, op: 'start' }), run, t);
      expect(detail.title).not.toMatch(/^detail\./);
      expect(detail.description).not.toMatch(/^detail\./);
    });
});
