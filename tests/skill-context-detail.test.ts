import { describe, expect, it } from 'vitest';
import { skillContextBlock } from '../src/skills/lifecycle.js';
import { skillContextDetail } from '../src/viz/client/skill-context-detail.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

const t = (key: string) => key;

describe('recorded skill context presentation', () => {
  it('opens on the actual recipe instead of the runtime preamble, keeping every raw byte', () => {
    const recipe = '# Build an interactive page\n\nCreate an HTML page with local state.\n\n## Steps\n\n1. Inspect the existing files.\n2. Implement the controls.\n3. Verify the interactions.';
    const raw = skillContextBlock({ id: 'build-widget', body: recipe });
    const detail = skillContextDetail({ preview: raw, chars: raw.length }, t);
    expect(detail.raw).toBe(raw);
    expect(detail.truncated).toBe(false);
    expect(detail.nodes[0]).toMatchObject({ kind: 'section', label: 'Build an interactive page' });
    expect(JSON.stringify(detail.nodes)).toContain('Verify the interactions.');
    expect(JSON.stringify(detail.nodes)).not.toMatch(/TRUST BOUNDARY|FASTEST|Two things no recipe/);
  });

  it('reflows wrapped prose while preserving script indentation', () => {
    const script = 'if (true) {\n  console.log("done");\n}';
    const raw = skillContextBlock({ id: 'build-widget', kind: 'script', language: 'node', body: script });
    const detail = skillContextDetail({ preview: raw, chars: raw.length }, t);
    expect(detail.nodes).toEqual([expect.objectContaining({ presentation: 'code', value: script })]);
    expect(skillContextDetail({ preview: 'A sentence wrapped\nacross two lines.' }, t).nodes[0])
      .toMatchObject({ presentation: 'text', value: 'A sentence wrapped across two lines.' });
  });

  it('reports missing recipe content in a truncated preamble without borrowing current catalog text', () => {
    const raw = skillContextBlock({ id: 'build-widget', body: 'Recipe body.' });
    const detail = skillContextDetail({ preview: `${raw.slice(0, 200)}…`, chars: raw.length }, t);
    expect(detail.truncated).toBe(true);
    expect(detail.nodes).toEqual([]);
  });

  it('keeps unfamiliar context text and fenced code visible', () => {
    const raw = '== ACTIVE SKILL: custom ==\nAn unfamiliar introduction.\n\n```js\n  const x = 1;\n```\n\n== END ACTIVE SKILL ==';
    expect(skillContextDetail({ preview: raw }, t).nodes).toEqual([
      expect.objectContaining({ value: 'An unfamiliar introduction.', presentation: 'text' }),
      expect.objectContaining({ value: '  const x = 1;', presentation: 'code' }),
    ]);
  });

  it('returns to the readable view when selecting a different event or run', () => {
    const store = useGpuStore.getState();
    store.selectEvent('context-a');
    store.toggleContextRaw();
    expect(useGpuStore.getState().contextRawOpen).toBe(true);
    store.selectEvent('context-b');
    expect(useGpuStore.getState().contextRawOpen).toBe(false);
    store.toggleContextRaw();
    store.selectRun('other-run');
    expect(useGpuStore.getState().contextRawOpen).toBe(false);
  });
});
