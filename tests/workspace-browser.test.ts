import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { ProjectService } from '../src/projects/service.js';
import { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { MAX_WORKSPACE_FILE_BYTES, workspaceFileSchema, workspaceIndexSchema } from '../src/contracts/workspaceBrowser.js';
import { workspaceChildren } from '../src/viz/client-gl/workspace-browser.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-reader-')); roots.push(root);
  const f = projectRetrievalFixture(root);
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root });
  const service = new ProjectService({ store: f.projects, coordinator, github: null });
  return { ...f, service };
}
it('browses saved files and folders, reads literal text, and omits files outside the manifest', () => {
  const f = fixture();
  const { run, layout } = f.makeRun({ 'src/app.ts': '<script>alert(1)</script>', 'README.md': 'hello', 'image.bin': Buffer.from([0, 1, 2]) });
  writeFileSync(join(layout.workspacePath, '.env'), 'secret');
  const index = workspaceIndexSchema.parse(f.service.workspace(f.viewer, f.project.projectId, run.projectRunId));
  expect(workspaceChildren(index, '').map(f => f.name)).toEqual(['src', 'image.bin', 'README.md']);
  expect(workspaceChildren(index, 'src').map(f => f.name)).toEqual(['app.ts']);
  expect(workspaceFileSchema.parse(f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, 'src/app.ts')).text).toBe('<script>alert(1)</script>');
  expect(workspaceFileSchema.parse(f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, 'image.bin')).kind).toBe('binary');
  for (const path of ['.env', '../outside', '/etc/passwd']) expect(() => f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, path)).toThrow('file not found');
});
it('refuses foreign organisations, wrong project bindings, live workspaces and changed or symlinked bytes', () => {
  const f = fixture(), other = fixture();
  const { run, layout } = f.makeRun({ 'app.txt': 'saved' });
  expect(() => f.service.workspace(other.viewer, f.project.projectId, run.projectRunId)).toThrow('run not found');
  expect(() => f.service.workspace(f.viewer, other.project.projectId, run.projectRunId)).toThrow('run not found');
  expect(() => f.service.workspace(f.viewer, f.project.projectId, f.makeRun().run.projectRunId)).toThrow('not available');
  writeFileSync(join(layout.workspacePath, 'app.txt'), 'changed');
  expect(() => f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, 'app.txt')).toThrow('differs');
  unlinkSync(join(layout.workspacePath, 'app.txt'));
  symlinkSync('/etc/passwd', join(layout.workspacePath, 'app.txt'));
  expect(() => f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, 'app.txt')).toThrow('differs');
});
it('preserves the legacy JSON text preview bound', () => {
  const f = fixture(); const { run } = f.makeRun({ 'large.txt': 'x'.repeat(256 * 1024 + 1) });
  expect(workspaceFileSchema.parse(f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, 'large.txt')).kind).toBe('too_large');

});

it('serves exact binary preview bytes under the same saved-file authority and size bound', () => {
  const f = fixture();
  const audio = Buffer.from([82, 73, 70, 70, 0, 255, 128, 1]);
  const { run, layout } = f.makeRun({ 'sound.wav': audio, 'large.wav': Buffer.alloc(1) });
  const read = (path: string) => f.service.workspace(f.viewer, f.project.projectId, run.projectRunId, path, 'bytes');
  expect(read('sound.wav')).toEqual(audio);
  const saved = f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)!;
  const lookup = vi.spyOn(f.projects, 'getProjectRun').mockReturnValueOnce({ ...saved,
    artifactManifest: { ...saved.artifactManifest!, files: saved.artifactManifest!.files.map(file =>
      file.path === 'large.wav' ? { ...file, size: MAX_WORKSPACE_FILE_BYTES + 1 } : file) } });
  expect(() => read('large.wav')).toThrow('too large');
  lookup.mockRestore();
  expect(() => read('../sound.wav')).toThrow('file not found');
  const other = fixture();
  expect(() => f.service.workspace(other.viewer, f.project.projectId, run.projectRunId, 'sound.wav', 'bytes')).toThrow();
  writeFileSync(join(layout.workspacePath, 'sound.wav'), Buffer.alloc(audio.length));
  expect(() => read('sound.wav')).toThrow('differs');
});
