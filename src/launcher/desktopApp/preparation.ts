import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, release, tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DOCKER_DOWNLOADS, type ComputePreparation, type ComputeTarget } from '../../contracts/computeSetup.js';
const exec = promisify(execFile);
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
const decode = (value: Buffer) => value.includes(0) ? value.toString('utf16le').replace(/^\uFEFF/, '') : value.toString('utf8');
async function command(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await exec(file, args, { timeout: 15_000, maxBuffer: 128 * 1024, encoding: 'buffer', windowsHide: true, signal });
  return decode(result.stdout).trim();
}
export function nativeComputeTarget(platform: string, architecture: string): ComputeTarget {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(architecture)) return architecture === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return platform === 'win32' && architecture === 'x64' ? 'windows-x64' : 'unsupported';
}
export function supportedWslVersion(output: string): boolean {
  const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  if (!version) return false;
  const [major, minor, patch] = version.slice(1).map(Number);
  return major! > 2 || major === 2 && (minor! > 1 || minor === 1 && patch! >= 5);
}
function installedDocker(): string | undefined {
  const candidates = process.platform === 'darwin' ? ['/Applications/Docker.app', join(homedir(), 'Applications/Docker.app')]
    : [join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Docker/Docker/Docker Desktop.exe'),
      join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData/Local'), 'Programs/DockerDesktop/Docker Desktop.exe')];
  return candidates.find(path => existsSync(path));
}
function addDockerPath(path: string): void {
  const bin = process.platform === 'darwin' ? join(path, 'Contents/Resources/bin') : join(path, '..', 'resources/bin');
  process.env.PATH = [bin, ...(process.env.PATH ?? '').split(delimiter).filter(part => part !== bin)].join(delimiter);
}
async function verifyDocker(path: string, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'darwin') {
    await command('/usr/bin/codesign', ['--verify', '--strict', path], signal);
    const result = await exec('/usr/bin/codesign', ['-dv', path], { timeout: 15_000, maxBuffer: 128 * 1024, signal });
    if (!/^TeamIdentifier=9BNSXJN65R$/m.test(result.stderr)) throw new Error('Docker publisher verification failed');
  } else {
    const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$s=Get-AuthenticodeSignature -LiteralPath ${ps(path)}; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(^|,\\s*)(CN|O)=Docker Inc\\.?(,|$)'){exit 1}; Write-Output 'verified'`], signal);
    if (result !== 'verified') throw new Error('Docker publisher verification failed');
  }
}
async function detached(file: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => { const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
}
/** Fixed vendor source, bounded disk streaming, no renderer-supplied URL/path. */
export async function downloadDocker(url: string, path: string, signal: AbortSignal, progress: (bytes: number, total: number | null) => void): Promise<void> {
  if (!Object.values(DOCKER_DOWNLOADS).includes(url as typeof DOCKER_DOWNLOADS[keyof typeof DOCKER_DOWNLOADS])) throw new Error('Unknown Docker installer');
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Docker download failed');
  const cap = 2 * 1024 ** 3, declared = Number(response.headers.get('content-length')) || null;
  if (declared && declared > cap) { await response.body.cancel(); throw new Error('Docker installer too large'); }
  const handle = await open(path, 'wx', 0o600); let bytes = 0; let reported = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      signal.throwIfAborted(); bytes += chunk.byteLength;
      if (bytes > cap) throw new Error('Docker installer too large');
      await handle.writeFile(chunk);
      if (Date.now() - reported >= 200) { progress(bytes, declared); reported = Date.now(); }
    }
    if (!bytes || declared !== null && bytes !== declared) throw new Error('Incomplete Docker installer');
    await handle.sync(); progress(bytes, declared);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await handle.close(); }
}
export class DesktopPreparation {
  private readonly marker: string;
  private value: ComputePreparation = { target: nativeComputeTarget(process.platform, process.arch), osVersion: release(), stage: 'checking', downloadedBytes: 0, totalBytes: null };
  constructor(private readonly root: string, private readonly changed: (value: ComputePreparation) => void) { this.marker = join(root, 'desktop-preparation.json'); }
  snapshot() { return this.value; }
  private patch(patch: Partial<ComputePreparation>) { this.value = { ...this.value, ...patch }; this.changed(this.value); }
  pending(): boolean { try { return JSON.parse(readFileSync(this.marker, 'utf8')).pending === true; } catch { return false; } }
  remember(pending: boolean): void {
    if (!pending) { rmSync(this.marker, { force: true }); return; }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = `${this.marker}.${randomUUID()}`; writeFileSync(file, '{"pending":true}', { mode: 0o600, flag: 'wx', flush: true }); renameSync(file, this.marker);
  }
  async inspect(signal?: AbortSignal): Promise<ComputePreparation> {
    const target = nativeComputeTarget(process.platform, process.arch);
    const version = release();
    let stage: ComputePreparation['stage'] = 'install-required';
    if (target === 'unsupported') stage = 'unsupported';
    else if (process.platform === 'darwin' && Number(version.split('.')[0]) < 23 || process.platform === 'win32' && Number(version.split('.')[2]) < 19045) stage = 'os-update';
    else if (process.platform === 'win32') {
      try {
        if (!supportedWslVersion(await command('wsl.exe', ['--version'], signal))) stage = 'wsl-required';
        else { await command('wsl.exe', ['--status'], signal); }
      } catch { signal?.throwIfAborted(); stage = 'wsl-required'; }
      if (stage === 'wsl-required') {
        try {
          const enabled = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'if ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent -or (Get-CimInstance Win32_Processor | Where-Object VirtualizationFirmwareEnabled)) { "yes" } else { "no" }'], signal);
          if (enabled === 'no') stage = 'virtualization';
        } catch { signal?.throwIfAborted(); /* Missing privileges are not proof virtualization is disabled. */ }
      }
    }
    if (stage === 'install-required') {
      const path = installedDocker();
      if (path) {
        addDockerPath(path);
        try { const info = JSON.parse(await command('docker', ['info', '--format', '{{json .}}'], signal)) as { OperatingSystem?: string; OSType?: string; KernelVersion?: string };
          stage = /Docker Desktop/i.test(info.OperatingSystem ?? '') && info.OSType === 'linux' ? 'ready' : 'start-failed';
          if (process.platform === 'win32' && !/WSL2/i.test(info.KernelVersion ?? '')) stage = 'start-failed';
        } catch { signal?.throwIfAborted(); stage = 'starting'; }
      }
    }
    if (stage === 'install-required' && this.value.stage === 'installer-open') stage = 'installer-open';
    this.patch({ target, osVersion: version, stage }); return this.value;
  }
  async ensureRunning(signal: AbortSignal): Promise<boolean> {
    await this.inspect(signal);
    if (this.value.stage === 'ready') return true;
    if (this.value.stage !== 'starting') return false;
    const path = installedDocker(); if (!path) return false;
    await verifyDocker(path, signal);
    if (process.platform === 'darwin') await command('/usr/bin/open', ['-a', path], signal);
    else await detached(path, []);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await delay(2000, undefined, { signal });
      await this.inspect(signal);
      if (this.snapshot().stage === 'ready') return true;
    }
    this.patch({ stage: 'start-failed' }); return false;
  }
  async installDocker(signal: AbortSignal): Promise<void> {
    const state = await this.inspect(signal);
    if (!['install-required', 'installer-open'].includes(state.stage) || !(state.target in DOCKER_DOWNLOADS)) return;
    const dir = await mkdtemp(join(tmpdir(), 'atoma-docker-'));
    const path = join(dir, process.platform === 'darwin' ? 'Docker.dmg' : 'Docker Desktop Installer.exe');
    let opened = false;
    try {
      this.patch({ stage: 'installer-download', downloadedBytes: 0, totalBytes: null });
      await downloadDocker(DOCKER_DOWNLOADS[state.target as keyof typeof DOCKER_DOWNLOADS], path,
        AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]), (downloadedBytes, totalBytes) => this.patch({ downloadedBytes, totalBytes }));
      await verifyDocker(path, signal); signal.throwIfAborted();
      if (process.platform === 'darwin') await command('/usr/bin/open', [path], signal); else await detached(path, []);
      opened = true; this.patch({ stage: 'installer-open' });
      // Keep the mounted/running installer intact; the OS owns its temporary directory.
    } catch (error) { this.patch({ stage: 'download-failed' }); throw error; }
    finally { if (!opened) await rm(dir, { recursive: true, force: true }); }
  }
  async installWsl(signal: AbortSignal): Promise<void> {
    if (process.platform !== 'win32') throw new Error('WSL is Windows only');
    const state = await this.inspect(signal);
    if (state.stage !== 'wsl-required') return;
    signal.throwIfAborted();
    let installed = false;
    try { installed = /\d+\.\d+\.\d+/.test(await command('wsl.exe', ['--version'], signal)); } catch { signal.throwIfAborted(); }
    await detached('powershell.exe', ['-NoProfile', '-Command', installed
      ? "Start-Process wsl.exe -Verb RunAs -ArgumentList '--update' -Wait"
      : "Start-Process wsl.exe -Verb RunAs -ArgumentList '--install','--no-distribution' -Wait"]);
  }
}
