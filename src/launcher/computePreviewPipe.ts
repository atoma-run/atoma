import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { COMPUTE_PREVIEW_CHUNK_BYTES } from '../contracts/computePreview.js';

/** A pipe issued by the launcher for one isolated preview. Buffers and pending
 * reads/writes are bounded independently; no caller selects a destination. */
export class ComputePreviewPipe {
  private ended = false;
  private closed = false;
  private reading = false;
  private writing = false;
  private wake?: () => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly onClose: () => void = () => {}) {
    child.stderr.resume();
    child.stdout.on('readable', () => this.wake?.());
    child.stdout.on('end', () => { this.ended = true; this.wake?.(); });
    child.on('close', () => { this.ended = true; this.wake?.(); });
    child.on('error', () => this.close());
    child.stdin.on('error', () => this.close());
    this.timer = setTimeout(() => this.close(), 120_000); this.timer.unref();
  }
  async read(): Promise<string | null> {
    if (this.reading) throw new Error('Preview read already pending');
    this.reading = true; this.timer.refresh();
    try {
      for (;;) {
        const available = this.child.stdout.readableLength;
        if (available) {
          const bytes = this.child.stdout.read(Math.min(available, COMPUTE_PREVIEW_CHUNK_BYTES)) as Buffer;
          return bytes.toString('base64');
        }
        if (this.ended) return null;
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally { this.reading = false; }
  }
  async write(encoded: string): Promise<void> {
    if (this.ended || this.writing) throw new Error('Preview write unavailable');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > COMPUTE_PREVIEW_CHUNK_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid preview bytes');
    this.writing = true; this.timer.refresh();
    try { await new Promise<void>((resolve, reject) => this.child.stdin.write(bytes, error => error ? reject(error) : resolve())); }
    finally { this.writing = false; }
  }
  async end(): Promise<void> {
    if (this.writing) throw new Error('Preview write pending');
    await new Promise<void>(resolve => this.child.stdin.end(resolve));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.ended = true; clearTimeout(this.timer); this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.kill(); this.wake?.();
  }
}
