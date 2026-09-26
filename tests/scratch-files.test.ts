import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { L1Atom, SCRATCH_DIRECTORY } from '../src/atoms/L1Atom.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * Production run 80d1af73 (2026-09-26) published five `probe-*` inputs, written
 * only to exercise the CLI it documented, into the customer's repository. The
 * molecule is now told where such inputs go, and publication leaves that
 * place out.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('scratch inputs', () => {
  it('are never published with the deliverable', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-scratch-'));
    dirs.push(root);
    writeFileSync(join(root, 'csv2json.mjs'), 'export {};\n');
    mkdirSync(join(root, SCRATCH_DIRECTORY));
    writeFileSync(join(root, SCRATCH_DIRECTORY, 'probe-malformed.csv'), 'a,b\n"x\n');
    const { manifest } = buildWorkspaceArtifactManifest({ workspaceRoot: root });
    expect(manifest.files.map((file) => file.path)).toEqual(['csv2json.mjs']);
  });

  it('are named to every molecule at execution, not in a stored prompt', async () => {
    const molecule = new L1Atom({ name: 'Branched', ordinal: 7, systemPrompt: 'a branch whose stored prompt predates the rule', tools: [], params: {} });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
    await molecule.execute({ description: 'Document the CLI' }, makePlan({ proposedAction: 'document' }), ctx);
    expect(ctx.llm.calls[0]!.userContent).toContain(`"${SCRATCH_DIRECTORY}/"`);
  });
});
