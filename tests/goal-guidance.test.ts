import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_VOCABULARY } from '../src/atoms/verdict.js';
import { GOAL_GUIDANCE } from '../src/run/guidance.js';

describe('the goal guidance is describable', () => {
  it('carries real help and examples', () => {
    expect(GOAL_GUIDANCE.help.length, 'help too short').toBeGreaterThan(200);
    expect(GOAL_GUIDANCE.examples.length, 'needs examples').toBeGreaterThanOrEqual(2);
    for (const example of GOAL_GUIDANCE.examples) expect(example.trim()).not.toBe('');
  });

  it('names an npm script that actually exists', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    expect(scripts[GOAL_GUIDANCE.npmScript], `points at missing script "${GOAL_GUIDANCE.npmScript}"`).toBeTruthy();
  });

  it('never tells a user to name a tool in their goal', () => {
    const corpus = [GOAL_GUIDANCE.help, ...GOAL_GUIDANCE.examples].join(' \n ');
    for (const tool of BUILTIN_TOOL_VOCABULARY) {
      expect(corpus, `guidance names "${tool}"`).not.toContain(tool);
    }
  });
});
