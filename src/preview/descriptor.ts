import { lstatSync } from 'node:fs';
import path from 'node:path';
import { servableCheckFile } from '../contracts/webCheck.js';
import {
  previewDescriptorSchema,
  type PreviewDescriptor,
  type PreviewUnavailableReason,
} from '../contracts/preview.js';
import { PROBE_MANIFEST_FILENAME, probeEntryKind, probeManifestSchema } from '../contracts/probeManifest.js';
import { normalizeArtifactPath } from '../projects/artifacts.js';
import { previewWorkspaceHasFile, readPreviewClassifierFile } from './policy.js';

/**
 * WHAT KIND OF THING DID THIS RUN DELIVER?
 *
 * Decided ONCE, at delivery, from machine-observed facts, and persisted — so
 * unavailability has a stable reason and no request ever probes the filesystem
 * (design §6). Two properties are load-bearing:
 *
 * 1. NOTHING HERE READS MODEL PROSE. Not `result.output`, not a README, not
 *    trace text, and no `run_shell` is replayed. The inputs are the probe
 *    manifest — written by the machine from what tools actually did — plus the
 *    presence of files on disk. Verification is read-only, and a classifier
 *    that trusted a model's claim about its own deliverable would be the
 *    supervisor replaying a child's command by another name.
 * 2. THE ANSWER IS TOTAL. Every delivered run gets a descriptor: available
 *    with a kind, or unavailable with a bounded reason a member can read. A
 *    button that fails after the click is worse than a stated absence.
 */

const NODE_ENTRY_FALLBACKS = ['server.js', 'index.js', 'app.js'] as const;
const STATIC_INDEX = 'index.html';
const JS_ENTRY = /\.(?:c|m)?js$/i;

export interface PreviewClassification {
  readonly availability: 'available' | 'unavailable';
  readonly kind: 'static' | 'node' | null;
  readonly entry: string | null;
  readonly unavailableReason: PreviewUnavailableReason | null;
}

function unavailable(reason: PreviewUnavailableReason): PreviewClassification {
  return { availability: 'unavailable', kind: null, entry: null, unavailableReason: reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The manifest's own kind dispatch, the one the health check performs
 * (`probeEntryKind`), so a manifest cannot mean one thing to the validator
 * and another to the classifier.
 */
const entryKind = probeEntryKind;

/**
 * The entry file, from the tool argument that actually started a server.
 *
 * LAST WINS. HTTP entries are an ordered SEQUENCE and never merge by route
 * (`src/contracts/probeManifest.ts`), so a run that restarted its server under
 * a new filename leaves both stamps behind; the newest observation is the one
 * describing the deliverable as it ended.
 *
 * An unusable stamp is treated as no stamp rather than as a refusal — the
 * fallbacks below still have a chance, and a run is not unpreviewable because
 * one recorded field is malformed.
 */
function stampedEntry(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entryKind(entry) !== 'http') continue;
    const stamped = entry['entry'];
    if (typeof stamped !== 'string' || stamped.length === 0) continue;
    try {
      return normalizeArtifactPath(stamped);
    } catch {
      continue;
    }
  }
  return null;
}

/** A workspace-relative path, or null when the value is not one. */
function relativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return normalizeArtifactPath(value);
  } catch {
    return null;
  }
}

/**
 * Nothing at all is at `stamp`, and node would have run it as written: a
 * `.js`, `.mjs` or `.cjs` path, never one node resolves further (`server`,
 * a directory). A link or a directory there is something; only ENOENT is not.
 */
function stampedServerGone(workspaceRoot: string, stamp: string): boolean {
  if (!JS_ENTRY.test(stamp)) return false;
  try {
    lstatSync(path.join(path.resolve(workspaceRoot), ...stamp.split('/')));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Anything named `package.json` at the root: the mark of a Node project, whatever became of its server. */
function hasPackageJson(workspaceRoot: string): boolean {
  try {
    lstatSync(path.join(path.resolve(workspaceRoot), 'package.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the http probes describe a server this workspace no longer holds
 * and a browser validated a page it still does. Asked only once no node entry
 * resolves. Every http entry stamps the script its server ran from, nothing
 * is left at any of them, no `package.json` says this is a Node project, and
 * a web entry names a servable HTML file that is here. The manifest keeps
 * every run's probes: run 81375f01 (2026-10-01) added a stray `server.js` and
 * probed it, 3cbef119 deleted it, and its two http entries left the static
 * page `not-runnable`, with no preview and no replay of its inherited checks.
 * The review of 2026-10-01 measured renamed, cleaned or deleted Node servers,
 * stamps node resolves further and servers behind a link turning `static`
 * under a looser test, and the replay then removing their checks as dead.
 */
function httpProbesOutlivedTheirServer(workspaceRoot: string, entries: readonly unknown[]): boolean {
  const records = entries.filter(isRecord);
  const stamps = records.filter((entry) => entryKind(entry) === 'http').map((entry) => relativePath(entry['entry']));
  if (stamps.length === 0 || stamps.some((stamp) => stamp === null || !stampedServerGone(workspaceRoot, stamp))) return false;
  if (hasPackageJson(workspaceRoot)) return false;
  return records.some((entry) => {
    if (entryKind(entry) !== 'web') return false;
    const file = typeof entry['file'] === 'string' ? servableCheckFile(entry['file']) : null;
    return file !== null && previewWorkspaceHasFile(workspaceRoot, file);
  });
}

/** `package.json`'s `main`, only when it names a regular file in this tree. */
function packageMainEntry(workspaceRoot: string): string | null {
  const raw = readPreviewClassifierFile(workspaceRoot, 'package.json');
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A deliverable whose package.json does not parse is not a reason to
    // refuse a preview: the fallback names below still describe most servers.
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['main'] !== 'string') return null;
  try {
    return normalizeArtifactPath(parsed['main']);
  } catch {
    return null;
  }
}

function usableEntry(workspaceRoot: string, candidate: string | null): string | null {
  if (candidate === null) return null;
  // `node <entry>` is the ONLY start command a preview will ever run (design
  // D7), so an entry node cannot execute is not an entry. Saying so here turns
  // a runtime crash a member would have to interpret into `not-runnable`.
  if (!JS_ENTRY.test(candidate)) return null;
  return previewWorkspaceHasFile(workspaceRoot, candidate) ? candidate : null;
}

/**
 * Classify one delivered workspace.
 *
 * Throws nothing: every failure it can meet — an unreadable workspace, a
 * manifest that will not parse — is one of the bounded reasons, because this
 * runs inside the delivery path and a run must never be un-delivered by the
 * host failing to describe it.
 */
export function classifyDeliveredWorkspace(
  workspaceRoot: string,
  options: {
    /**
     * Where the probe manifest is read from, when it is not `workspaceRoot`.
     *
     * The in-flight path classifies a COPY, so the bytes cannot move under the
     * classifier — but the copy is made under the COPY policy, which excludes
     * every `.atoma*` file, the manifest included. Reading the manifest from
     * the copy therefore found nothing, `kinds` was empty, and a Node
     * deliverable in flight was `unsupported-deliverable` by construction:
     * only an `index.html` already on disk could ever classify. Measured on a
     * live run (2026-09-02, snapshot at 16:49).
     *
     * The manifest is host-observed evidence and the CLASSIFY policy admits
     * it at the workspace root, so it is read from the SOURCE through that
     * policy, while every file check below stays on the frozen copy. A torn
     * read mid-write is `manifest-unreadable`, a bounded answer for a moment.
     */
    readonly manifestRoot?: string;
  } = {}
): PreviewClassification {
  let manifestRaw: string | null;
  try {
    manifestRaw = readPreviewClassifierFile(options.manifestRoot ?? workspaceRoot, PROBE_MANIFEST_FILENAME);
  } catch {
    // The jail refused, the file changed under the read, or the workspace is
    // not a directory any more. All three mean the same to a member.
    return unavailable('workspace-unreadable');
  }

  let entries: readonly unknown[] | null = null;
  if (manifestRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      return unavailable('manifest-unreadable');
    }
    const document = probeManifestSchema.safeParse(parsed);
    if (!document.success) return unavailable('manifest-unreadable');
    entries = document.data.entries;
  }

  const kinds = (entries ?? [])
    .filter(isRecord)
    .map(entryKind);

  if (kinds.includes('http')) {
    let resolved = usableEntry(workspaceRoot, stampedEntry(entries ?? []));
    if (resolved === null) {
      let main: string | null;
      try {
        main = packageMainEntry(workspaceRoot);
      } catch {
        // A package.json that is a link or no regular file is refused by the
        // read: a workspace the host declines to describe, like an unreadable
        // manifest, and never a throw out of the delivery path (review 2026-10-01).
        return unavailable('workspace-unreadable');
      }
      resolved =
        usableEntry(workspaceRoot, main) ??
        NODE_ENTRY_FALLBACKS.map((name) => usableEntry(workspaceRoot, name)).find(
          (name): name is string => name !== null
        ) ??
        null;
    }
    if (resolved !== null) {
      return {
        availability: 'available',
        kind: 'node',
        entry: resolved,
        unavailableReason: null,
      };
    }
    // Probes of a server that is gone say nothing about this workspace; the
    // page a browser validated is what remains. Otherwise it is not runnable.
    if (!httpProbesOutlivedTheirServer(workspaceRoot, entries ?? [])) return unavailable('not-runnable');
  }

  // A web probe means a browser validated a page in this workspace; the page
  // itself is what a member wants to open. No manifest at all still classifies
  // static when the conventional entry document is present — a run may deliver
  // a page without ever recording a browser probe.
  if (kinds.includes('web') || previewWorkspaceHasFile(workspaceRoot, STATIC_INDEX)) {
    return { availability: 'available', kind: 'static', entry: null, unavailableReason: null };
  }

  return unavailable('unsupported-deliverable');
}

/**
 * The immutable row, built and validated in one place.
 *
 * `requestedHosts` is an INPUT rather than something read from the workspace,
 * and it is empty in v1: there is no run-side channel through which a run
 * declares the HTTPS hosts its deliverable needs. Inventing one from the
 * probe manifest would mean reading localhost probes as internet destinations.
 * The column and the approval flow exist so that channel lands without a
 * migration; until it does, every descriptor requests nothing and every
 * preview starts with egress denied, which is the correct default anyway.
 */
export function buildPreviewDescriptor(input: {
  readonly projectRunId: string;
  readonly projectId: string;
  readonly orgId: string;
  readonly workspaceRoot: string;
  readonly requestedHosts?: readonly string[];
  readonly now?: Date;
}): PreviewDescriptor {
  const classification = classifyDeliveredWorkspace(input.workspaceRoot);
  return previewDescriptorSchema.parse({
    projectRunId: input.projectRunId,
    projectId: input.projectId,
    orgId: input.orgId,
    availability: classification.availability,
    kind: classification.kind,
    entry: classification.entry,
    unavailableReason: classification.unavailableReason,
    requestedHosts: [...(input.requestedHosts ?? [])],
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}
