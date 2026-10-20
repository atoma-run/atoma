import type { VizEvent, VizRun } from './types.js';
import { tryParseJson } from './run-utils.js';
import type { DetailTone, StructuredDetailNode } from './structured-detail.js';

type Translate = (key: string, vars?: Record<string, unknown>) => string;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const prose = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const excerpt = (value: string, limit = 1800): string => value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;

/** Recorded facts only: an operation succeeding never proves the whole delivery. */
export function explainEvent(event: VizEvent, run: VizRun, t: Translate): {
  title: string; description: string; nodes: readonly StructuredDetailNode[];
} {
  const nodes: StructuredDetailNode[] = [];
  const field = (key: string, value: string, tone: DetailTone = 'neutral') => {
    if (value) nodes.push({ kind: 'field', key, label: t(`detail.readable.${key}`),
      value: excerpt(value, key === 'purpose' ? 420 : key === 'explanation' ? 1000 : 1800), tone, presentation: 'text' });
  };
  const branch = event.branchId ? run.events.find(candidate => candidate.kind === 'branch' &&
    candidate.op === 'start' && candidate.branchId === event.branchId) : undefined;
  const parsed = tryParseJson(event.response ?? '');
  const responses = (Array.isArray(parsed) ? parsed : [parsed]).map(record);
  const response = responses.find(value => typeof value.approved === 'boolean') ?? responses[0] ?? {};
  const result = record(event.result);
  const args = event.args ?? {};
  let family: string;
  let outcome = '';
  let tone: DetailTone = 'neutral';
  if (event.kind === 'tool') {
    const known = ['read_file', 'list_files', 'write_file', 'edit_file', 'run_shell', 'record_probe',
      'search_project_docs', 'start_node_server', 'fetch_url', 'validate_html'];
    family = known.includes(event.name ?? '') ? `tool.${event.name}` : 'tool.other';
    const failed = Boolean(event.error) || result.ok === false ||
      (typeof result.exitCode === 'number' && result.exitCode !== 0);
    const succeeded = !failed && (result.ok === true || result.exitCode === 0 ||
      (event.name === 'read_file' && typeof result.content === 'string') ||
      (event.name === 'list_files' && Array.isArray(result.entries)));
    outcome = t(`detail.readable.${failed ? 'operationFailed' : succeeded ? 'operationCompleted' : 'operationRecorded'}`);
    tone = failed ? 'error' : succeeded ? 'success' : 'neutral';
    field('outcome', outcome, tone);
    field('target', prose(result.path) || prose(args.path) || prose(result.url) || prose(args.url) || prose(args.entry));
    field('purpose', prose(args.note) || prose(args.query));
    if (event.name === 'run_shell' || event.name === 'record_probe') field('command', excerpt(prose(args.cmd), 320));
    if (typeof result.status === 'number') field('observation', t('detail.readable.httpStatus', { status: result.status }));
    if (typeof result.replacements === 'number') field('observation', t('detail.readable.replacements', { count: result.replacements }));
    if (Array.isArray(result.entries)) field('observation', t('detail.readable.entries', { count: result.entries.length }));
    if (event.name === 'record_probe' && result.recorded === true) field('observation',
      t(`detail.readable.${failed ? 'failedCheckSaved' : 'checkSaved'}`), failed ? 'warning' : 'info');
    field('problem', event.error || prose(result.message) ||
      (failed ? prose(result.stderr) || (Array.isArray(result.errors)
        ? result.errors.map(error => typeof error === 'string' ? error : prose(record(error).message)).filter(Boolean).join('\n') : '') : ''), 'error');
  } else if (event.kind === 'llm' || event.kind === 'llm-start') {
    const role = event.role ?? 'execute';
    const roles = ['plan', 'validate-plan', 'validate-result', 'prefilter', 'execute', 'aggregate', 'jev-audit',
      'fallback-plan', 'fallback-execute', 'skill'];
    family = `call.${roles.includes(role) ? role : 'other'}`;
    if (event.kind === 'llm-start') {
      const completion = run.events.find(candidate => candidate.kind === 'llm' && candidate.id === event.llmEventId);
      outcome = t(`detail.readable.${completion ? 'responseAvailable' : run.endedAt ? 'noResponse' : 'waitingResponse'}`);
      tone = completion ? 'info' : 'warning';
    } else if (event.error) {
      outcome = t('detail.readable.operationFailed'); tone = 'error';
    } else if (typeof response.approved === 'boolean') {
      outcome = t(`detail.readable.${response.approved ? 'reviewApproved' : 'reviewRejected'}`);
      tone = response.approved ? 'success' : 'warning';
    } else outcome = t(`detail.readable.${event.response ? 'responseAvailable' : 'noResponse'}`);
    field('outcome', outcome, tone);
    field('explanation', responses.map(value => prose(value.summary) || prose(value.reasoning) ||
      prose(value.description) || prose(value.output)).filter(Boolean).join('\n\n') ||
      (parsed === undefined ? event.response ?? '' : ''));
    const steps = responses.flatMap(value => Array.isArray(value.subtasks) ? value.subtasks : []);
    if (steps.length) nodes.push({ kind: 'section', key: 'steps', label: t('detail.readable.steps'),
      children: steps.map((step, index) => ({ kind: 'field', key: 'step',
        label: t('detail.readable.step', { number: index + 1 }),
        value: excerpt(prose(record(step).description) || prose(record(step).task) || prose(step)),
        tone: 'neutral', presentation: 'text' })) });
    field('problem', event.error ?? '', 'error');
    if (response.approved === false) field('next', prose(record(response.modifications).additionalContext));
  } else {
    const families = ['branch', 'jev', 'trust', 'cache', 'context', 'registry', 'skill', 'topology', 'acceptance'];
    family = families.includes(event.kind) ? event.kind : 'other';
    if (event.kind === 'acceptance' && typeof event.approved === 'boolean') {
      outcome = t(`detail.readable.${event.approved ? 'deliveryApproved' : 'deliveryRejected'}`);
      tone = event.approved ? 'success' : 'warning';
    } else if (event.kind === 'branch') outcome = t(`detail.readable.${event.op === 'start' ? 'partStarted'
      : event.op === 'end' ? 'partEnded' : 'operationRecorded'}`);
    else if (event.kind === 'jev') {
      // The recorder owns this outcome vocabulary; never infer approval from
      // probability scores or from words embedded in its explanation.
      const recorded = prose(event.outcome);
      const answer = record(event.answer);
      const roles = ['prefilter', 'validate-plan', 'validate-result', 'execute-effort'];
      if (roles.includes(event.role ?? '')) family = `decision.${event.role}`;
      outcome = recorded === 'approved' ? t('detail.readable.reviewApproved')
        : recorded === 'rejected' ? t('detail.readable.reviewRejected')
          : recorded.startsWith('deferred to the model') ? t('detail.readable.referredForReview')
            : recorded.startsWith('default effort') ? t('detail.readable.standardEffort')
              : recorded.startsWith('effort ') ? t('detail.readable.selectedEffort', { effort: prose(answer.choice) || recorded.slice(7) })
                : recorded.startsWith('picked ') && prose(answer.choice) ? t('detail.readable.agentSelected', { agent: prose(answer.choice) }) : recorded;
      tone = recorded === 'approved' ? 'success' : recorded === 'rejected' ? 'warning' : 'neutral';
    } else if (event.kind === 'skill' && event.op) {
      const operations = ['match', 'inject', 'failure', 'update', 'credit-withheld', 'learn', 'compile', 'dispatch', 'credit'];
      outcome = operations.includes(event.op) ? t(`detail.readable.skill.${event.op}`) : event.op;
    }
    field('outcome', outcome, tone);
    if (event.kind === 'topology' && (event.mode === 'deep' || event.mode === 'short'))
      field('observation', t(`detail.readable.topology.${event.mode}`));
    if (event.kind === 'trust' && typeof event.successes === 'number' && typeof event.failures === 'number')
      field('observation', [t('detail.readable.priorSuccesses', { count: event.successes }),
        t('detail.readable.priorFailures', { count: event.failures })].join(' · '));
    if (event.kind === 'context' && event.source === 'coaching') field('next', excerpt(prose(event.preview), 700));
    if (!['trust', 'registry', 'skill', 'cache', 'context'].includes(event.kind)) field('explanation', event.reasoning ?? '');
    if (event.kind === 'registry') {
      field('target', prose(event.name) || event.child?.name || '');
      const operations: Record<string, string> = { recordSuccess: 'agentSuccess', recordFailure: 'agentFailure',
        create: 'agentCreated', modify: 'agentUpdated', mutate: 'agentUpdated' };
      const operation = event.op ? operations[event.op] : undefined;
      if (operation) field('outcome', t(`detail.readable.${operation}`));
    }
    if (event.kind === 'branch') field('purpose', prose(event.label));
  }
  if (event.kind !== 'branch' && !nodes.some(node => node.key === 'purpose')) field('purpose', prose(branch?.label));
  return { title: t(`detail.readable.${family}.title`), description: t(`detail.readable.${family}.description`), nodes };
}
