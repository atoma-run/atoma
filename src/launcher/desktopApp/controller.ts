import { DesktopPreparation } from './preparation.js';
import { existsSync, statfsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { COMPUTE_IMAGES } from '../../contracts/computeImages.js';
import { computeDesktopCommandSchema, computeDesktopStateSchema, type ComputeDesktopCommand, type ComputeDesktopState } from '../../contracts/computeDesktop.js';
import { computeMain, computeSettings, computeStateRoot, type ComputeApplicationHooks, type ComputeLiveStatus } from '../computeApplication.js';

export const DESKTOP_ORIGIN = 'https://atoma.run';
export function desktopIssue(error: unknown): ComputeDesktopState['issue'] {
  const message = error instanceof Error ? error.message : '';
  if (/unconfirmed|teardown/i.test(message)) return 'stop-unconfirmed';
  if (/locked|already connected|another|SQLITE_BUSY/i.test(message)) return 'busy';
  if (/credential|keychain|storage/i.test(message)) return 'credential';
  if (/CPU|RAM|GiB|disk space/i.test(message)) return 'resources';
  if (/docker|ENOENT|daemon|WSL2/i.test(message)) return 'docker';
  if (/pairing/i.test(message)) return 'pairing';
  if (/connect|socket|fetch|network/i.test(message)) return 'connection';
  return 'setup';
}
/** Trusted utility-process adapter. All protocol, credential and teardown work
 * remains in the same application lifecycle as the terminal client. */
export class ComputeDesktopController {
  private value: ComputeDesktopState = { preparationPending: false, preparation: null, paired: false, connected: false, accepting: true, phase: 'idle', issue: null,
    deviceName: hostname().slice(0, 120), download: null, diagnostic: null, allocations: [], transfers: [], resources: [] };
  private task?: Promise<void>;
  private abort?: AbortController;
  private control?: (action: 'accept' | 'drain' | 'pause' | 'stop') => Promise<void>;
  private status?: () => Promise<ComputeLiveStatus>;
  private polling = false;
  private controlling = false;
  private waiting = false;
  private readonly preparation: Pick<DesktopPreparation, 'inspect' | 'ensureRunning' | 'installDocker' | 'installWsl' | 'pending' | 'remember'>;
  constructor(private readonly version: string, private readonly changed: (state: ComputeDesktopState) => void,
    private readonly openPairing: (url: string) => void,
    private readonly run = computeMain, private readonly root = computeStateRoot(), preparation?: ComputeDesktopController['preparation']) {
    this.preparation = preparation ?? new DesktopPreparation(root, value => this.patch({ preparation: value }));
    if (process.platform !== 'darwin' && process.platform !== 'win32') this.patch({ phase: 'error', issue: 'unsupported' });
    else if (existsSync(join(root, 'settings.json'))) {
      try { if (computeSettings(root).origin !== DESKTOP_ORIGIN) throw new Error('Unsupported server'); this.value.paired = true; }
      catch { this.patch({ phase: 'error', issue: 'setup' }); }
    }
  }
  async initialize(): Promise<void> {
    this.patch({ preparation: await this.preparation.inspect() });
    if (this.preparation.pending() && this.value.paired) await this.execute({ action: 'prepare' });
  }
  snapshot(): ComputeDesktopState { return computeDesktopStateSchema.parse(this.value); }
  private patch(patch: Partial<ComputeDesktopState>) { this.value = { ...this.value, ...patch }; this.changed(this.snapshot()); }
  async execute(input: ComputeDesktopCommand): Promise<void> {
    const command = computeDesktopCommandSchema.parse(input);
    if (command.action === 'refresh') { await this.refresh(); return; }
    if (command.action === 'cancel' || command.action === 'disconnect') { await this.stop(command.action === 'cancel'); return; }
    if (['accept', 'drain', 'pause', 'stop'].includes(command.action)) {
      if (!this.control || !this.value.connected || this.controlling) throw new Error('Compute control unavailable');
      this.controlling = true;
      try {
        const action = command.action as 'accept' | 'drain' | 'pause' | 'stop';
        await this.control(action);
        if (action === 'accept' || action === 'drain') this.patch({ accepting: action === 'accept' });
        await this.refresh();
      } catch (error) { this.patch({ issue: desktopIssue(error) }); throw new Error('Compute control unavailable'); }
      finally { this.controlling = false; }
      return;
    }
    if (this.task || this.value.issue === 'unsupported') throw new Error('Compute operation already active or unsupported');
    if (command.action === 'pair' && this.value.paired) throw new Error('This computer is already paired');
    if (!['pair', 'install-docker', 'install-wsl'].includes(command.action) && !this.value.paired) throw new Error('Pair this computer first');
    this.abort = new AbortController();
    const hooks: ComputeApplicationHooks = { signal: this.abort.signal, appVersion: this.version,
      pairing: url => this.openPairing(url), download: (completed, total) => this.patch({ download: { completed, total } }),
      connection: connected => this.patch({ connected, phase: connected ? 'connected' : this.value.phase === 'connected' ? 'connecting' : this.value.phase }),
      controls: (control, status) => { this.control = control; this.status = status; },
      diagnostic: result => { const disk = statfsSync(this.root); this.patch({ diagnostic: { ...result, hostDiskBytes: disk.bavail * disk.bsize } }); },
      reconnect: () => this.value.accepting,
    };
    this.patch({ issue: null, download: null });
    this.task = (async () => {
      try {
        if (command.action === 'install-docker' || command.action === 'install-wsl') {
          this.patch({ phase: 'diagnosing' });
          if (command.action === 'install-docker') await this.preparation.installDocker(hooks.signal!);
          else await this.preparation.installWsl(hooks.signal!);
        } else if (command.action === 'pair') {
          const images = COMPUTE_IMAGES[process.arch === 'arm64' ? 'arm64' : 'amd64'];
          this.patch({ phase: 'pairing', deviceName: command.name });
          await this.run(['pair', '--server', DESKTOP_ORIGIN, '--name', command.name,
            ...Object.entries(images).flatMap(([kind, image]) => [`--${kind}-image`, image])], hooks);
          this.patch({ paired: true, phase: 'idle' });
        } else if (command.action === 'prepare') {
          this.preparation.remember(true); this.patch({ preparationPending: true });
          this.patch({ phase: 'diagnosing' });
          if (!await this.preparation.ensureRunning(hooks.signal!)) {
            this.waiting = true; this.patch({ phase: 'idle' }); return;
          }
          this.waiting = false; this.preparation.remember(false); this.patch({ preparationPending: false });
          this.patch({ phase: 'downloading' }); await this.run(['pull'], hooks);
          this.patch({ phase: 'diagnosing' }); await this.run(['doctor'], hooks);
          this.patch({ phase: 'connecting', accepting: true }); await this.run(['start'], hooks);
        } else {
          this.patch({ phase: 'diagnosing' });
          if (!await this.preparation.ensureRunning(hooks.signal!)) { this.patch({ phase: 'idle' }); return; }
          this.patch({ phase: command.action === 'diagnose' ? 'diagnosing' : 'connecting', accepting: true });
          await this.run([command.action === 'diagnose' ? 'doctor' : 'start'], hooks);
        }
        this.patch({ phase: 'idle', connected: false });
      } catch (error) {
        this.waiting = false; this.preparation.remember(false); this.patch({ preparationPending: false });
        // Cancellation is successful only if the shared lifecycle completed its
        // cleanup; an engine failure is never disguised as an ordinary cancel.
        if (error instanceof Error && error.name === 'AbortError') this.patch({ phase: 'idle', connected: false });
        else this.patch({ phase: 'error', connected: false, issue: desktopIssue(error) });
      } finally { this.control = undefined; this.status = undefined; this.task = undefined; this.abort = undefined; }
    })();
  }
  async refresh(): Promise<void> {
    if (this.polling) return;
    if (!this.task && !this.status) {
      this.polling = true;
      try {
        const before = this.value.preparation?.stage;
        const next = await this.preparation.inspect(); this.patch({ preparation: next });
        if (this.waiting && (next.stage === 'ready' || next.stage === 'starting' && before !== 'starting' && before !== 'start-failed')) await this.execute({ action: 'prepare' });
      } finally { this.polling = false; }
      return;
    }
    if (!this.status) return;
    this.polling = true;
    try { const status = await this.status(); this.patch({ allocations: status.allocations.slice(-20), transfers: status.transfers, resources: status.resources.slice(0, 20) }); }
    catch { this.patch({ resources: [] }); }
    finally { this.polling = false; }
  }
  async stop(cancelPreparation = false): Promise<void> {
    this.waiting = false; if (cancelPreparation) { this.preparation.remember(false); this.patch({ preparationPending: false }); }
    if (this.task) { this.patch({ phase: 'stopping' }); this.abort?.abort(); await this.task; }
    if (this.value.issue === 'stop-unconfirmed') throw new Error('Workload stop remains unconfirmed');
  }
}
