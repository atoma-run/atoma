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

/**
 * Production run ed84d7be (2026-09-28): the molecule restored `notes.json` to
 * `[]` as told, then probed again; the app's server, still holding the probe
 * notes in memory, wrote them back and the delivery carried them. There is no
 * tool to stop that server, so the restore has to come after the last write.
 */
describe('a data store the probes filled', () => {
  it('is restored after the last request that changes data, since the server rewrites it', async () => {
    const molecule = new L1Atom({ name: 'Branched', ordinal: 7, systemPrompt: 'a stored prompt', tools: [], params: {} });
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
    await molecule.execute({ description: 'Add CSV import to the notes app' }, makePlan({ proposedAction: 'implement' }), ctx);
    const prompt = ctx.llm.calls[0]!.userContent;
    expect(prompt).toMatch(/Restore it AFTER your last request that changes data/);
    expect(prompt).toMatch(/server you started keeps the data in memory/);
  });
});
