import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import type { Result } from '../src/core/types.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { recipeNamesReadRunCopy, SkillLifecycle } from '../src/skills/lifecycle.js';
import { namespaceOf, type SkillNamespace } from '../src/skills/namespace.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { jsonText, makeCtx } from './helpers.js';

/**
 * A recipe naming a read-run copy (`.atoma-runs/node_modules/<run id>`) — review
 * 2026-10-17. The catalogue is every organisation's, so such a recipe would
 * carry one organisation's run id into all of them, and replay a path that
 * existed in one run: a script trusted from its first match fails on it, and a
 * recipe a model applies keeps injecting it. Never learned, revised or
 * compiled. Real catalogue on disk; only the author and compiler are scripted.
 */

const COPY = '.atoma-runs/node_modules/50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a';
const task = { description: `Restore browser/collect.js to the bytes of ${COPY}/browser/collect.js.` };

let dir: string;
let skills: SkillRegistry;
let namespace: SkillNamespace;
let child: L1Atom;
let lifecycle: SkillLifecycle;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atoma-read-run-skills-'));
  const registry = new AtomRegistry(openDb(':memory:'));
  const seed = { description: 'Restore files', systemPrompt: 'Restore files from saved copies.', params: {}, createdBy: 'read-runs-test',
    tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' as const } },
      { name: 'run_shell', description: 's', inputSchema: { type: 'object' as const } }] };
  const supervisor = registry.create(2, { ...seed, tools: [] });
  const molecule = registry.create(1, seed);
  namespace = namespaceOf(molecule);
  child = L1Atom.fromType(molecule);
  skills = new SkillRegistry(dir);
  const host = L2Atom.fromType(supervisor, registry, [], skills);
  lifecycle = new SkillLifecycle({ name: host.name, model: host.model, params: {},
    toLlmRequest: (role, args) => host.toLlmRequest(role, args) }, skills);
  vi.stubEnv('ATOMA_SKILL_PROMOTE', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const approved: Result = { output: { files: ['browser/collect.js'] }, summary: 'Restored browser/collect.js',
  toolCallResults: [{ name: 'run_shell', ok: true, result: { exitCode: 0, stdout: '', stderr: '' } }],
  trace: [], producedBy: { tier: 1, name: 'Molecule', viaFallback: false } };

describe('a recipe that names a read-run copy', () => {
  it('reads a path into a copy in any field, and an exclusion of the directory as none', () => {
    expect(recipeNamesReadRunCopy({ body: `1. cp ${COPY}/<file> <file>` })).toBe(true);
    expect(recipeNamesReadRunCopy({ whenToUse: `when asked to restore from ${COPY}` })).toBe(true);
    expect(recipeNamesReadRunCopy({ trigger: `ENOENT on ${COPY}/x.js` })).toBe(true);
    // As a recipe learned while the copies sat at .atoma-runs/<run id> spells it (before 2026-10-17).
    expect(recipeNamesReadRunCopy({ body: '1. cp .atoma-runs/50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a/<file> <file>' })).toBe(true);
    expect(recipeNamesReadRunCopy({ body: "1. npx eslint . --ignore-pattern '.atoma-runs/**'\n2. cp .atoma-runs/node_modules/<run id>/<file> <file>" })).toBe(false);
  });

  it('is never learned, and costs nothing past the author\'s call', async () => {
    const learning = makeCtx();
    learning.llm.enqueueText(jsonText({ id: 'restore-from-read-run', description: 'Restore a file from a read run',
      when_to_use: 'When asked to restore a file to the bytes of an earlier run', body: `1. run_shell cp ${COPY}/browser/collect.js browser/collect.js` }));
    await lifecycle.learnSkillFromRun({ l1Name: namespace, subTask: task, result: approved, child, ctx: learning, hostTools: ['read_file', 'run_shell'] });
    expect(learning.llm.calls).toHaveLength(1);
    expect(skills.loadFor(namespace)).toEqual([]);
    // The same recipe in its general form is learned, and compiled at learn time.
    const general = makeCtx();
    general.llm.enqueueText(jsonText({ id: 'restore-from-read-run', description: 'Restore a file from a read run',
      when_to_use: 'When asked to restore a file to the bytes of an earlier run', body: '1. run_shell cp .atoma-runs/node_modules/<run id>/<file> <file>' }));
    general.llm.enqueueText(jsonText({ promotable: false, reason: 'needs the run id from the task' }));
    await lifecycle.learnSkillFromRun({ l1Name: namespace, subTask: task, result: approved, child, ctx: general, hostTools: ['read_file', 'run_shell'] });
    expect(skills.loadFor(namespace).map((skill) => skill.id)).toEqual(['restore-from-read-run']);
  });

  it('is never learned as a recovery recipe', async () => {
    const learning = makeCtx();
    learning.llm.enqueueText(jsonText({ id: 'recover-missing-copy', description: 'Recover a missing saved file',
      when_to_use: 'When a restore cannot find its source', trigger: 'ENOENT: no such file',
      body: `1. read_file ${COPY}/browser/collect.js again` }));
    await lifecycle.learnEventSkillFromRecovery({ l1Name: namespace, subTask: task, diagnostic: 'ENOENT: no such file',
      recoverySummary: 'Read the saved copy again', ctx: learning });
    expect(learning.llm.calls).toHaveLength(1);
    expect(skills.loadFor(namespace)).toEqual([]);
  });

  it('is never compiled: a recipe naming one costs no call, and an example naming one postpones without a stamp', async () => {
    // Learned before the rule: no compile call at all.
    skills.save(namespace, { id: 'legacy-restore', description: 'Restore', whenToUse: 'When restoring a saved file', kind: 'llm',
      body: `1. run_shell cp ${COPY}/browser/collect.js browser/collect.js` });
    const legacy = makeCtx();
    await lifecycle.tryPromoteSkill({ l1Name: namespace, skillId: 'legacy-restore', subTask: task, result: approved, ctx: legacy });
    expect(legacy.llm.calls).toHaveLength(0);
    expect(skills.loadFor(namespace).find((skill) => skill.id === 'legacy-restore')).toMatchObject({ kind: 'llm' });
    // A general recipe whose compile EXAMPLE (this run's subtask) names a copy:
    // postponed at no cost and never stamped (second review 2026-10-17), so a
    // later clean example still compiles it.
    skills.save(namespace, { id: 'general-restore', description: 'Restore', whenToUse: 'When restoring a saved file', kind: 'llm',
      body: '1. run_shell sha256sum the restored file and its saved copy, and compare them' });
    const postponed = makeCtx();
    await lifecycle.tryPromoteSkill({ l1Name: namespace, skillId: 'general-restore', subTask: task, result: approved, ctx: postponed });
    expect(postponed.llm.calls).toHaveLength(0);
    const waiting = skills.loadFor(namespace).find((skill) => skill.id === 'general-restore')!;
    expect(waiting.kind).toBe('llm');
    expect(waiting.promotionRefusedAt).toBeUndefined();
    const clean = makeCtx();
    clean.llm.enqueueText(jsonText({ promotable: true, language: 'node', writes: [],
      body: "import { createHash } from 'node:crypto';\nimport fs from 'node:fs';\n" +
        "const digest = (path) => createHash('sha256').update(fs.readFileSync(path)).digest('hex');\n" +
        "console.log(JSON.stringify({ output: { equal: digest(process.argv[2]) === digest(process.argv[3]) }, summary: 'Compared' }));\n" }));
    await lifecycle.tryPromoteSkill({ l1Name: namespace, skillId: 'general-restore', subTask: { description: 'Check browser/collect.js against its saved version.' },
      result: { summary: 'Compared the two digests' }, ctx: clean });
    expect(clean.llm.calls).toHaveLength(1);
    expect(skills.loadFor(namespace).find((skill) => skill.id === 'general-restore')).toMatchObject({ kind: 'script' });
  });

  it('is never written by a revision', async () => {
    skills.save(namespace, { id: 'general-restore', description: 'Restore', whenToUse: 'When restoring a saved file', kind: 'llm',
      body: '1. run_shell cp .atoma-runs/node_modules/<run id>/<file> <file>' });
    const skill = skills.loadFor(namespace)[0]!;
    const revising = makeCtx();
    revising.llm.enqueueText(`1. run_shell cp ${COPY}/browser/collect.js browser/collect.js`);
    expect(await lifecycle.improveSkillBody({ skill, diagnostic: `the file differs from ${COPY}/browser/collect.js`,
      subtaskDescription: task.description, ctx: revising })).toBeNull();
    revising.llm.enqueueText('1. run_shell cp .atoma-runs/node_modules/<run id>/<file> <file>\n2. sha256sum both files and compare them');
    expect(await lifecycle.improveSkillBody({ skill, diagnostic: 'no comparison was shown', subtaskDescription: task.description, ctx: revising }))
      .toContain('sha256sum both files');
  });
});
