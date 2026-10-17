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
 * A recipe naming a read-run copy (`.atoma-runs/<run id>`) — review
 * 2026-10-17. The catalogue is every organisation's, so such a recipe would
 * carry one organisation's run id into all of them, and replay a path that
 * existed in one run: a script trusted from its first match fails on it, and a
 * recipe a model applies keeps injecting it. Never learned, revised or
 * compiled. Real catalogue on disk; only the author and compiler are scripted.
 */

const COPY = '.atoma-runs/50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a';
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
    expect(recipeNamesReadRunCopy({ body: "1. npx eslint . --ignore-pattern '.atoma-runs/**'\n2. cp .atoma-runs/<run id>/<file> <file>" })).toBe(false);
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
      when_to_use: 'When asked to restore a file to the bytes of an earlier run', body: '1. run_shell cp .atoma-runs/<run id>/<file> <file>' }));
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

  it('is never compiled: a recipe naming one costs no call, and a script naming one is refused and stamped', async () => {
    // Learned before the rule: no compile call at all.
    skills.save(namespace, { id: 'legacy-restore', description: 'Restore', whenToUse: 'When restoring a saved file', kind: 'llm',
      body: `1. run_shell cp ${COPY}/browser/collect.js browser/collect.js` });
    const legacy = makeCtx();
    await lifecycle.tryPromoteSkill({ l1Name: namespace, skillId: 'legacy-restore', subTask: task, result: approved, ctx: legacy });
    expect(legacy.llm.calls).toHaveLength(0);
    expect(skills.loadFor(namespace).find((skill) => skill.id === 'legacy-restore')).toMatchObject({ kind: 'llm' });
    // A general recipe, compiled from this run's example: the compiler bakes the run's copy in.
    skills.save(namespace, { id: 'general-restore', description: 'Restore', whenToUse: 'When restoring a saved file', kind: 'llm',
      body: '1. run_shell cp .atoma-runs/<run id>/<file> <file>' });
    const compiling = makeCtx();
    compiling.llm.enqueueText(jsonText({ promotable: true, language: 'node', writes: ['browser/collect.js'],
      body: `import fs from 'node:fs';\nfs.copyFileSync('${COPY}/browser/collect.js', 'browser/collect.js');\n` +
        "console.log(JSON.stringify({ output: { files: ['browser/collect.js'] }, summary: 'Restored' }));\n" }));
    await lifecycle.tryPromoteSkill({ l1Name: namespace, skillId: 'general-restore', subTask: task, result: approved, ctx: compiling });
    expect(compiling.llm.calls).toHaveLength(1);
    const general = skills.loadFor(namespace).find((skill) => skill.id === 'general-restore')!;
    expect(general.kind).toBe('llm');
    expect(general.promotionRefusedReason).toContain('it names a read-run copy (.atoma-runs/<run id>), a path one run held');
  });

  it('is never written by a revision', async () => {
    skills.save(namespace, { id: 'general-restore', description: 'Restore', whenToUse: 'When restoring a saved file', kind: 'llm',
      body: '1. run_shell cp .atoma-runs/<run id>/<file> <file>' });
    const skill = skills.loadFor(namespace)[0]!;
    const revising = makeCtx();
    revising.llm.enqueueText(`1. run_shell cp ${COPY}/browser/collect.js browser/collect.js`);
    expect(await lifecycle.improveSkillBody({ skill, diagnostic: `the file differs from ${COPY}/browser/collect.js`,
      subtaskDescription: task.description, ctx: revising })).toBeNull();
    revising.llm.enqueueText('1. run_shell cp .atoma-runs/<run id>/<file> <file>\n2. sha256sum both files and compare them');
    expect(await lifecycle.improveSkillBody({ skill, diagnostic: 'no comparison was shown', subtaskDescription: task.description, ctx: revising }))
      .toContain('sha256sum both files');
  });
});
