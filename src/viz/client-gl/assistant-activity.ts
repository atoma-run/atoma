import type { AssistantView } from '../../contracts/assistant.js';
import type { RunRequestedVia } from '../../contracts/projects.js';
import type { HostingSummary } from '../../contracts/projectHosting.js';

/**
 * The project's runs narrated INSIDE its conversation (2026-10-26): who asked
 * for each, from where, and how it ended, at its place in time. Host facts
 * projected at display time from `AssistantView.activity`, never written into
 * the conversation journal: the Runs tab and this narration read one record.
 */
export type AssistantActivity = NonNullable<AssistantView['activity']>[number];
type Message = AssistantView['conversation']['messages'][number];

/** One line of the narration: a run asked for, or a run that ended. */
export interface ActivityLine {
  readonly key: string;
  readonly kind: 'started' | 'ended';
  readonly at: string;
  readonly run: AssistantActivity;
}

const FINISHED = new Set(['delivered', 'partial', 'failed', 'cancelled']);

/**
 * The lines to interleave with the loaded messages. A run this conversation
 * started already has its receipt there, so its request is not told twice; a
 * run shown as a result card ends on that card, not on a line. While older
 * messages remain unloaded, nothing older than the first loaded one is told:
 * it would sit above messages it followed.
 */
export function activityLines(input: {
  readonly activity: readonly AssistantActivity[];
  readonly messages: readonly Pick<Message, 'role' | 'at' | 'run'>[];
  readonly carded: ReadonlySet<string>;
  readonly olderUnloaded: boolean;
}): ActivityLine[] {
  const receipted = new Set(input.messages.flatMap(message => message.role === 'receipt' && message.run ? [message.run.runId] : []));
  const first = input.messages[0] ? Date.parse(input.messages[0].at) : NaN;
  const lines: ActivityLine[] = [];
  for (const run of input.activity) {
    if (!receipted.has(run.runId)) lines.push({ key: `started:${run.runId}`, kind: 'started', at: run.createdAt, run });
    if (FINISHED.has(run.status) && run.endedAt && !input.carded.has(run.runId)) {
      lines.push({ key: `ended:${run.runId}`, kind: 'ended', at: run.endedAt, run });
    }
  }
  return lines
    .filter(line => !input.olderUnloaded || !Number.isFinite(first) || Date.parse(line.at) >= first)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Where an MCP client's self-declared name reads as a product people know.
 * Display copy over a CLAIM: an unknown name is shown as sent, as text.
 */
const KNOWN_CLIENTS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude',
  claude: 'Claude',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  vscode: 'VS Code',
  'visual-studio-code': 'VS Code',
};

export function mcpClientLabel(name: string): string {
  return KNOWN_CLIENTS[name.trim().toLowerCase()] ?? name.trim();
}

/** "You, from Claude Code", "Sam, from the command line", or just who, when the door was not recorded. */
export function activityWho(run: Pick<AssistantActivity, 'mine' | 'requestedByName' | 'requestedVia'>,
  t: (key: string, vars?: Record<string, unknown>) => string): string {
  // A display name is the person's own, shown as text and never translated.
  const who = run.mine ? t('assistant.activity.you') : run.requestedByName ?? t('assistant.activity.someone');
  const via = doorCopy(run.requestedVia, t);
  return via ? t('assistant.activity.whoVia', { who, via }) : who;
}

function doorCopy(via: RunRequestedVia | undefined, t: (key: string, vars?: Record<string, unknown>) => string): string | null {
  if (!via) return null;
  if (via.door === 'mcp') return via.client ? t('assistant.activity.via.mcp', { client: mcpClientLabel(via.client) }) : t('assistant.activity.via.agent');
  return t(`assistant.activity.via.${via.door}`);
}

/** What happened, in one plain sentence: asked, resumed or compared; or how it ended. */
export function activityWhat(line: ActivityLine, t: (key: string, vars?: Record<string, unknown>) => string): string {
  const { run } = line;
  if (line.kind === 'started') {
    const goal = run.goalExcerpt.length >= 240 ? `${run.goalExcerpt}…` : run.goalExcerpt;
    return t(run.continuation ? 'assistant.activity.resumed' : run.comparison ? 'assistant.activity.compared' : 'assistant.activity.started', { goal });
  }
  return t(`assistant.activity.ended.${run.status}`, { title: run.title ?? run.goalExcerpt });
}

/** The ended line's follow-up, when the client already settled the result. */
export function activitySettled(run: AssistantActivity, t: (key: string) => string): string | null {
  if (run.publicationStatus === 'published') return t('assistant.activity.published');
  return run.acceptedAt ? t('assistant.activity.accepted') : null;
}

/** One deployment of the project as its conversation narrates it (2026-10-26). */
export type DeploymentEntry = NonNullable<HostingSummary['history']>[number];

/** A deployment told at its place in time: which version went online, and what became of it. */
export interface DeploymentLine {
  readonly key: string;
  readonly at: string;
  readonly deployment: DeploymentEntry;
}

/**
 * The project's deployments to interleave with the loaded messages, oldest
 * first. Like `activityLines`, nothing older than the first loaded message is
 * told while older messages remain unloaded.
 */
export function deploymentLines(input: {
  readonly history: readonly DeploymentEntry[];
  readonly messages: readonly Pick<Message, 'at'>[];
  readonly olderUnloaded: boolean;
}): DeploymentLine[] {
  const first = input.messages[0] ? Date.parse(input.messages[0].at) : NaN;
  return input.history
    .filter(entry => Number.isFinite(Date.parse(entry.createdAt)))
    .filter(entry => !input.olderUnloaded || !Number.isFinite(first) || Date.parse(entry.createdAt) >= first)
    .map(deployment => ({ key: `deployed:${deployment.deploymentId}`, at: deployment.createdAt, deployment }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * What the deployment did, in one sentence, and where it stands now: the
 * headline follows the outcome (an attempt that never served "tried"; a row
 * from before 2026-10-26 that proves neither, a plain "Deployment"), and a
 * failed replacement says whether the version before it stayed online.
 */
export function deploymentWhat(line: DeploymentLine, t: (key: string, vars?: Record<string, unknown>) => string): { what: string; state: string } {
  const { deployment } = line;
  const title = deployment.title ?? t('assistant.deployment.untitled');
  const tense = deployment.outcome === 'starting' ? 'starting' : deployment.outcome === 'not-started' ? 'tried'
    : deployment.outcome === 'stopped' ? 'unproven' : 'done';
  const state = deployment.outcome === 'not-started' && deployment.keptOnline ? 'notStartedKept' : deployment.outcome;
  return {
    what: t(tense === 'unproven' ? 'assistant.deployment.unproven' : `assistant.deployment.${deployment.replaced ? 'replace' : 'online'}.${tense}`, { title }),
    state: t(`assistant.deployment.state.${state}`),
  };
}
