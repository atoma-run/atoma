import type { ToolInvocationInfo } from '../core/types.js';
import { toolInvocationSucceeded } from './validationLedger.js';

/**
 * What one execution of a molecule DID, rendered for its next attempt at the
 * same task. A rejected attempt was re-run from nothing but the validator's
 * feedback: run 87e672d7 (2026-10-04) spent its second attempt's first
 * ninety seconds listing and re-reading the six files the first had just read.
 * Built from the transport's observations only — paths, statuses, exit codes —
 * never from what the model said it did; its own report rides along, labelled.
 */

const MAX_PATHS = 20;
const MAX_HTTP = 30;
const MAX_COMMANDS = 8;
const MAX_REPORT_CHARS = 800;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.slice(0, 120);
  }
}

function listed(values: Iterable<string>, max: number): string {
  const all = [...values];
  return all.length > max ? `${all.slice(0, max).join(', ')} (+${all.length - max} more)` : all.join(', ');
}

export class AttemptDigest {
  private readonly changed = new Set<string>();
  private readonly read = new Set<string>();
  private readonly servers = new Map<string, number>();
  private readonly http = new Map<string, number>();
  private readonly commands: string[] = [];
  private validations = 0;
  private lastValidationOk: boolean | null = null;
  private calls = 0;

  observe(info: ToolInvocationInfo): void {
    this.calls++;
    // In-band failures count as failures: a server that did not start, a write that changed nothing.
    const ok = toolInvocationSucceeded(info);
    const filePath = text(info.args['path']);
    switch (info.name) {
      case 'write_file':
      case 'edit_file':
        if (ok && filePath) this.changed.add(filePath);
        break;
      case 'read_file':
        if (ok && filePath) this.read.add(filePath);
        break;
      case 'start_node_server':
      case 'start_static_server': {
        const entry = text(info.args['entry']) ?? text(info.args['root']) ?? text(info.args['dir']) ?? '.';
        if (ok) this.servers.set(entry, (this.servers.get(entry) ?? 0) + 1);
        break;
      }
      case 'fetch_url': {
        const url = text(info.args['url']);
        if (!url) break;
        const method = (text(info.args['method']) ?? 'GET').toUpperCase();
        const status = field(info.result, 'status');
        // A refusal status is an answer, not a failed request.
        const outcome = typeof status === 'number' ? String(status) : 'error';
        const key = `${method} ${pathOf(url)} → ${outcome}`;
        this.http.set(key, (this.http.get(key) ?? 0) + 1);
        break;
      }
      case 'validate_html':
        this.validations++;
        this.lastValidationOk = ok;
        break;
      case 'run_shell':
      case 'record_probe': {
        const argv = Array.isArray(info.args['args']) ? (info.args['args'] as unknown[]).map(String).join(' ') : '';
        const line = text(info.args['cmd']) ?? [text(info.args['command']), argv].filter(Boolean).join(' ');
        if (!line || this.commands.length >= MAX_COMMANDS) break;
        const code = field(info.result, 'exitCode');
        const outcome = typeof code === 'number' ? `exit ${code}` : info.error === undefined ? 'ran' : 'error';
        this.commands.push(`\`${line.length > 80 ? `${line.slice(0, 80)}…` : line}\` → ${outcome}`);
        break;
      }
      default:
        break;
    }
  }

  /** Null when the attempt observed no tool call: there is nothing to carry. */
  render(report: string): string | null {
    if (this.calls === 0) return null;
    const counted = (entries: Map<string, number>): string[] =>
      [...entries].map(([key, count]) => (count > 1 ? `${key} (×${count})` : key));
    const lines = [
      '== YOUR PREVIOUS ATTEMPT AT THIS TASK ==',
      `It was not accepted. The workspace still holds what it wrote. It made ${this.calls} tool call(s); the host observed:`,
      this.changed.size ? `- files written or edited: ${listed(this.changed, MAX_PATHS)}` : null,
      this.read.size ? `- files read: ${listed(this.read, MAX_PATHS)}` : null,
      this.servers.size ? `- servers started: ${listed(counted(this.servers), MAX_PATHS)}` : null,
      this.http.size ? `- HTTP requests: ${listed(counted(this.http), MAX_HTTP)}` : null,
      this.validations ? `- validate_html calls: ${this.validations} (last ${this.lastValidationOk ? 'ok' : 'not ok'})` : null,
      this.commands.length ? `- commands: ${this.commands.join('; ')}` : null,
      `Its own final report (not evidence): ${report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}…` : report}`,
      'Read a file again only when you need its current text; repeat a check when you changed what it covers or your supervisor questioned it.',
    ];
    return lines.filter((line): line is string => line !== null).join('\n');
  }
}
