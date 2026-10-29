import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeReleasePresentation } from '../scripts/compute-desktop-release-notes.mjs';

const identity = { repository: 'atoma-run/atoma', tag: 'compute-desktop-preview-aaaaaaaaaaaa', version: '0.5.224', revision: 'a'.repeat(40), signed: false };

it('puts the installer version first and links to exactly the three native installers', () => {
  const { title, body } = computeReleasePresentation(identity);
  expect(title).toBe('Compute 0.5.224 — preview');
  const downloads = [...body.matchAll(/\]\((https:\/\/github\.com\/[^)]+\/download\/[^)]+)\)/g)].map(match => match[1]);
  expect(downloads).toEqual(['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'].map(suffix => `https://github.com/atoma-run/atoma/releases/download/${identity.tag}/Atoma-Compute-0.5.224-${suffix}`));
  expect(body).toContain('**Mac — Apple Silicon**');
  expect(body).toContain('**Mac — Intel**');
  expect(body).toContain('**Windows — 64-bit**');
  expect(body).toContain('Get the current version');
  expect(body).toContain('Unsigned preview');
  expect(body).toContain('manually');
});

it('distinguishes current and signed channels without promising updates for previews', () => {
  expect(computeReleasePresentation({ ...identity, tag: 'compute-desktop-current' }).title).toBe('Compute 0.5.224 — downloads');
  const signed = computeReleasePresentation({ ...identity, tag: 'compute-desktop-stable', signed: true });
  expect(signed.body).toContain('notarized');
  expect(signed.body).toContain('Updates are offered in the application');
  expect(signed.body).not.toContain('Unsigned preview');
  expect(signed.body).not.toContain('Get the current version');
});

it('runs the real publication CLI from the installers directory and uses the receipt version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'compute-release-notes-'));
  try {
    writeFileSync(join(directory, 'compute-desktop-content.json'), JSON.stringify({ schema: 1, revision: identity.revision, sha256: 'b'.repeat(64), installerVersion: '0.5.999' }));
    const args = [resolve('scripts/compute-desktop-release-notes.mjs'), 'compute-desktop-content.json', 'compute-desktop-current', '0', identity.repository, 'notes.md'];
    expect(execFileSync(process.execPath, args, { cwd: directory, encoding: 'utf8' })).toBe('Compute 0.5.999 — downloads');
    const notes = readFileSync(join(directory, 'notes.md'), 'utf8');
    expect(notes).toContain('Atoma-Compute-0.5.999-mac-arm64.dmg');
    expect(notes).not.toContain('0.5.224');
    // Preserve the legacy content reader's source-revision fallback.
    expect(/\bfrom ([a-f0-9]{40})\./.exec(notes)?.[1]).toBe(identity.revision);
    writeFileSync(join(directory, 'compute-desktop-content.json'), JSON.stringify({ schema: 1, revision: identity.revision, sha256: 'b'.repeat(64) }));
    expect(() => execFileSync(process.execPath, args, { cwd: directory, stdio: 'pipe' })).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
