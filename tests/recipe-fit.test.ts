import { describe, expect, it } from 'vitest';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES } from '../src/atoms/capability.js';
import { isRecipePrefilter } from '../src/atoms/jevCalibration.js';

/**
 * A documentation phase is not a build. Runs 9854553c and fa8b6ce3
 * (2026-09-30) matched `build-text-frequency-cli`, a recipe that builds a
 * word-frequency CLI, to a README update. Its step "write_file <fixture> and
 * README with a real invocation and exact output" had the README rewritten
 * whole, and fa8b6ce3's lost the examples three earlier runs had asked for.
 */

const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('which recipe fits a documentation phase', () => {
  it('tells the recipe matcher that a recipe which builds an artefact does not fit a task that only documents or verifies it', () => {
    const prompt = flat(SKILL_PREFILTER_SYSTEM_PROMPT);
    expect(prompt).toContain('it BUILDS an artefact (writes or rewrites its code) but the task only documents or only verifies one that already exists.');
    // A recipe that documents, example fixtures included, is not a build.
    expect(prompt).not.toContain('fixtures and docs');
    // Jev's calibration still tells this prompt from the agent one.
    expect(isRecipePrefilter(SKILL_PREFILTER_SYSTEM_PROMPT)).toBe(true);
  });

  it('teaches the file scribe to edit a file that exists, never to write it again whole', () => {
    const prompt = flat(CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES.join('\n'));
    expect(prompt).toContain('1. write_file <path> (a NEW file the subtask asks for; to change one that exists, read_file it and edit_file only what changes; the probe manifest is never edited: record_probe adds to it)');
    expect(prompt).not.toContain('(the file the subtask asks for)');
  });
});
