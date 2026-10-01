import { describe, expect, it } from 'vitest';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES } from '../src/atoms/capability.js';
import { isRecipePrefilter } from '../src/atoms/jevCalibration.js';
import { skillContextBlock } from '../src/skills/lifecycle.js';
import { eventSkillBlock } from '../src/skills/events.js';
import { renderActiveSkillBlock } from '../src/atoms/verdict.js';
import { READER_FACING_DOC_GUIDANCE } from '../src/atoms/prompts.js';

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

  it('tells a molecule following a recipe what no step changes (runs 0b51e494, dadeea78)', () => {
    const edit = 'Never write_file over a file the workspace already holds, even where your instructions or a recipe step say to: change it with edit_file, only where it must change. Restoring a behaviour is an edit.';
    const rerun = 'A step that says not to rerun covers only what an earlier run recorded, never a new example.';
    const recipe = '2. write_file <entry>, changing only the requested UI behavior.';
    for (const block of [skillContextBlock({ id: 'patch-verified-static-ui', body: recipe }), eventSkillBlock({ id: 'recover', body: 'rewrite index.html', trigger: 'x' })]) {
      expect(flat(block)).toContain(edit);
      expect(flat(block)).toContain(rerun);
      expect(flat(block)).toContain('.atoma-probes.json is outside this rule.');
    }
    // The validator judging adherence reads them with the recipe: obeying them is following it.
    expect(flat(renderActiveSkillBlock({ id: 'patch-verified-static-ui', body: recipe }))).toContain(edit);
    // A script recipe runs verbatim: none of this applies to it.
    expect(skillContextBlock({ id: 's', body: 'console.log(1)', kind: 'script', language: 'node' })).not.toContain('Two things no recipe step changes');
    expect(flat(READER_FACING_DOC_GUIDANCE)).toContain('An example output you add is copied from a tool result of this run (a command or request you ran, or an entry this run recorded), never composed;');
  });

  it('teaches the file scribe to edit a file that exists, never to write it again whole', () => {
    const prompt = flat(CANONICAL_FILESCRIBE_L1_SYSTEM_PROMPT_LINES.join('\n'));
    expect(prompt).toContain('1. write_file <path> (a NEW file the subtask asks for; to change one that exists, read_file it and edit_file only what changes; the probe manifest is never edited: record_probe adds to it)');
    expect(prompt).not.toContain('(the file the subtask asks for)');
  });
});
