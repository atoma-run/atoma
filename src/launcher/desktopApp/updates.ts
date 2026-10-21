import type { ComputeDesktopCommand, ComputeDesktopState, ComputeDesktopUpdateAction, ComputeDesktopUpdateState } from '../../contracts/computeDesktop.js';

/** Main-process update orchestration; no engine access or renderer-supplied URLs. */
export class DesktopUpdates {
  private value: ComputeDesktopUpdateState;
  private busy = false;
  private downloaded = false;
  private requested = false;
  constructor(supported: boolean, private readonly hooks: {
    check(): Promise<string | null>;
    download(): Promise<unknown>;
    command(command: ComputeDesktopCommand): Promise<void>;
    runtime(): ComputeDesktopState | undefined;
    install(): void;
    changed(state: ComputeDesktopUpdateState): void;
  }) {
    this.value = { phase: supported ? 'idle' : 'unsupported', version: null, percent: null };
  }
  snapshot(): ComputeDesktopUpdateState { return { ...this.value }; }
  get pending(): boolean { return this.requested; }
  private patch(patch: Partial<ComputeDesktopUpdateState>): void {
    this.value = { ...this.value, ...patch }; this.hooks.changed(this.snapshot());
  }
  progress(percent: number): void {
    if (this.value.phase === 'downloading' && Number.isFinite(percent)) this.patch({ percent: Math.min(100, Math.max(0, percent)) });
  }
  failed(): void { this.requested = false; this.patch({ phase: 'error', percent: null }); }
  async action(action: ComputeDesktopUpdateAction): Promise<void> {
    if (this.value.phase === 'unsupported' || this.value.phase === 'installing') return;
    if (action === 'cancel') {
      // A cancelled wait leaves the computer drained; accepting new runs stays explicit.
      if (this.value.phase === 'waiting') { this.requested = false; this.patch({ phase: 'available' }); }
      return;
    }
    if (this.busy || this.requested) return;
    if (action === 'check' && this.downloaded) { this.patch({ phase: 'available' }); return; }
    this.busy = true;
    try {
      if (action === 'check') {
        this.patch({ phase: 'checking' });
        const version = await this.hooks.check();
        this.patch({ phase: version ? 'available' : 'current', version, percent: null });
      } else if (this.value.version) {
        if (!this.downloaded) {
          this.patch({ phase: 'downloading', percent: 0 });
          await this.hooks.download(); this.downloaded = true;
        }
        this.requested = true; this.patch({ phase: 'waiting', percent: null });
      }
    } catch { this.failed(); }
    finally { this.busy = false; }
    if (this.requested) await this.advance();
  }
  /** Re-entered on runtime state changes. Drain acknowledgement and a fresh
   * utility-process check must precede disconnect; stale UI state proves nothing. */
  async advance(): Promise<void> {
    if (!this.requested || this.busy || this.value.phase === 'installing') return;
    const runtime = this.hooks.runtime();
    if (!runtime) return;
    if (runtime.issue === 'stop-unconfirmed') { this.failed(); return; }
    if (!['idle', 'error', 'connected'].includes(runtime.phase)) return;
    this.busy = true;
    try {
      if (runtime.connected && runtime.accepting) { await this.hooks.command({ action: 'drain' }); return; }
      if (runtime.allocations.some(row => row.state !== 'stopped') || runtime.transfers.some(row => row.state === 'transferring')) return;
      await this.hooks.command({ action: 'disconnect-idle' });
      if (!this.requested) return;
      this.patch({ phase: 'installing' }); this.hooks.install();
    } catch { this.failed(); }
    finally { this.busy = false; }
  }
}
