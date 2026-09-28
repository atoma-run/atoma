import { createHash } from 'node:crypto';
import { WITHHELD_QUOTE, type SanitisedFinding, type SupervisorMendReport } from '../contracts/supervisorMend.js';
import type {
  FindingConfidence,
  SupervisorVerdict,
  VerdictFinding,
} from '../contracts/supervisorVerdict.js';
import type { ServedModelUsage } from '../contracts/supervisorVerdict.js';
import { truncate } from './digest.js';
import type { SupervisorProvider } from './session.js';

/**
 * THE MENDER'S PURE HALF: which findings may be mended, what the model may
 * and may not have touched, how the branch, the commit and the pull request
 * are named and worded. `mender.ts` owns the worktree, the processes and the
 * network; this file is what the tests hold without any of that.
 */

export const CONFIDENCE_RANK: Record<FindingConfidence, number> = { low: 0, medium: 1, high: 2 };

export interface EligibleFinding {
  readonly index: number;
  readonly finding: VerdictFinding;
}

/**
 * What the mender may be asked to fix, and — the load-bearing half — what it
 * must never be asked to fix.
 *
 *   - a `defect`, and since 2026-09-27 (owner decision) a `mechanism_candidate`:
 *     the candidate's remedy is a choice nobody has made yet (a threshold, a
 *     policy), so its pull request PROPOSES that choice and says so, and the
 *     person who merges makes it. Before, candidates only reached a backlog
 *     nobody drained: seventeen of seventeen findings in three weeks, none
 *     mended. A PR is still the only way out; nothing merges itself.
 *   - `security_incident` is an alert for a person, not a patch.
 *   - a `proposedFix` is REQUIRED: the analyst's citation rule exists because
 *     reading intentional choices was measurably not enough, and a fix with no
 *     cited file inherits that gap.
 *   - confidence at or above the floor (`high` by default: a mend costs real
 *     quota and ten minutes of a dedicated machine).
 */
export function eligibleFindings(
  verdict: Pick<SupervisorVerdict, 'findings'>,
  minConfidence: FindingConfidence = 'high'
): EligibleFinding[] {
  const floor = CONFIDENCE_RANK[minConfidence];
  const out: EligibleFinding[] = [];
  verdict.findings.forEach((finding, index) => {
    if (finding.kind !== 'defect' && finding.kind !== 'mechanism_candidate') return;
    if (CONFIDENCE_RANK[finding.confidence] < floor) return;
    if (!finding.proposedFix) return;
    out.push({ index, finding });
  });
  return out;
}

/** Repository paths the mender may quote verbatim to the model. */
const SOURCE_REF = /^(src|tests|docs|scripts|benchmark|deploy|docker)\//;
export { WITHHELD_QUOTE };
export type { SanitisedFinding };

/**
 * The finding as the mender's model is allowed to see it. Evidence quotes
 * carry verbatim trace text — model and tool output, fetched pages, error
 * prose — and stage 3 never receives raw trace prose. A quote whose `ref`
 * points into the repository source is kept (it is our own code); every other
 * quote is replaced by a marker and only its `path:line` pointer survives.
 * The model still cannot open those pointers: its worktree has no `runs/` and
 * no `supervisor/`.
 */
export function sanitiseFinding(finding: VerdictFinding | SanitisedFinding): SanitisedFinding {
  const fix = finding.proposedFix;
  return {
    kind: finding.kind,
    title: truncate(finding.title, 200),
    detail: truncate(finding.detail, 4000),
    confidence: finding.confidence,
    proposedFix: {
      where: truncate(fix?.where ?? '', 300),
      what: truncate(fix?.what ?? '', 2000),
      checkedIntentionalChoices: truncate(fix?.checkedIntentionalChoices ?? '', 1000),
    },
    evidence: finding.evidence.slice(0, 12).map((item) => {
      const ref = truncate(item.ref, 300);
      if (SOURCE_REF.test(ref) && typeof item.quote === 'string') {
        return { ref, quote: truncate(item.quote, 200) };
      }
      return { ref, quote: WITHHELD_QUOTE };
    }),
  };
}

/**
 * One defect, across runs. Two runs that surface the same bug must not open
 * two pull requests, and a finding has no id, so the key is derived from WHERE
 * the fix lands and what the analyst called it — normalised so casing,
 * punctuation and run-specific numbers do not split one defect in two. An
 * approximation, documented as one; it rides the commit and the PR body as a
 * `Defect-Key:` line for `gh pr list --search`.
 */
export function defectKey(finding: Pick<VerdictFinding, 'title' | 'proposedFix'>): string {
  const norm = (text: string | undefined): string =>
    (text ?? '')
      .toLowerCase()
      .replace(/\d+/g, 'n')
      .replace(/[^a-z\s/._-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return createHash('sha256')
    .update(`${norm(finding.proposedFix?.where)}|${norm(finding.title)}`)
    .digest('hex')
    .slice(0, 12);
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'fix';
}

export function shortRunId(runId: string): string {
  return runId.split('-').pop()?.slice(0, 8) ?? 'run';
}

/** Every branch the harness publishes starts here; the review back-pressure counts by it. */
export const MENDER_BRANCH_PREFIX = 'mender/';

export function branchName(runId: string, findingIndex: number, finding: Pick<VerdictFinding, 'title'>): string {
  return `${MENDER_BRANCH_PREFIX}${shortRunId(runId)}-${findingIndex}-${slugify(finding.title)}`;
}

/**
 * WHAT THE MODEL MAY HAVE CHANGED. An allowlist, not a denylist: a fix for a
 * run-time defect lives in `src/` with its regression test in `tests/`, and a
 * dated note may land under `docs/incidents/`. Workflows, deploy scripts,
 * hooks, dependencies and the supervisor's own code are a person's decision,
 * and a "fix" that needs one is not a fix the mender may ship. The cap on
 * changed lines is the same idea by size.
 *
 * Stated ONCE, as lists: the patterns the harness enforces and the sentence
 * the model is given (`MENDABLE_SCOPE`) are both built from them. The prompt
 * once told the model to record a candidate's choice "in the subsystem
 * AGENTS.md you changed" while this policy refused every AGENTS.md, and the
 * only candidate mended in production was refused the instant its session
 * ended (2026-09-27).
 */
export const MENDABLE_ROOTS = ['src/', 'tests/', 'docs/incidents/'] as const;
/** Prefixes, matched as such: `src/contracts/supervisor` covers both of its schema files. */
export const PROTECTED_ROOTS = ['src/supervisor/', 'src/cli/', 'src/contracts/supervisor'] as const;
/** Refused at any depth: every agent that works here reads them as instructions. */
export const PROTECTED_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;
const pattern = (items: readonly string[]): string => items.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
export const ALLOWED_PATH = new RegExp(`^(${pattern(MENDABLE_ROOTS)})`);
export const PROTECTED_PATH = new RegExp(`^(${pattern(PROTECTED_ROOTS)})|(^|/)(${pattern(PROTECTED_FILE_NAMES)})$`);
export const MENDABLE_SCOPE =
  `only files under ${MENDABLE_ROOTS.map((root) => `\`${root}\``).join(', ')} may change, and never ` +
  `anything under ${PROTECTED_ROOTS.map((root) => `\`${root}${root.endsWith('/') ? '' : '*'}\``).join(', ')} ` +
  `nor any ${PROTECTED_FILE_NAMES.map((name) => `\`${name}\``).join(' or ')}, wherever it sits`;
export const DEFAULT_MAX_DIFF_LINES = 600;

/**
 * How long ONE model-authored command may run: the Codex `worktree_command`
 * bound, and Claude Code's own default for a Bash call. Neither the full
 * `npm run check` nor the harness's `check:changed` fits in it, so the prompt
 * names the checks that do and leaves the rest to the harness and CI; it used
 * to make a green full check, run by the model, the condition for `fixed`.
 */
export const MENDER_COMMAND_BOUND_MS = 120_000;

export interface NumstatRow {
  readonly added: number;
  readonly deleted: number;
  readonly file: string;
}

export interface DiffPolicyVerdict {
  readonly ok: boolean;
  readonly problems: string[];
  readonly testFiles: string[];
  readonly sourceFiles: string[];
  readonly changedLines: number;
}

export function checkDiffPolicy(input: {
  files: readonly string[];
  numstat: readonly NumstatRow[];
  maxLines?: number;
}): DiffPolicyVerdict {
  const maxLines = input.maxLines ?? DEFAULT_MAX_DIFF_LINES;
  const problems: string[] = [];
  if (input.files.length === 0) {
    return {
      ok: false,
      problems: ['the model reported a fix but changed no file'],
      testFiles: [],
      sourceFiles: [],
      changedLines: 0,
    };
  }
  const outside = input.files.filter((file) => !ALLOWED_PATH.test(file) || PROTECTED_PATH.test(file));
  if (outside.length > 0) {
    problems.push(`changes outside the permitted source/test scope or inside protected supervisor policy: ${outside.join(', ')}`);
  }
  const testFiles = input.files.filter((file) => /^tests\/.*\.test\.[cm]?[jt]sx?$/.test(file));
  const sourceFiles = input.files.filter((file) => !testFiles.includes(file));
  if (testFiles.length === 0) {
    problems.push('no regression test under tests/ — the exit contract requires one');
  }
  if (!sourceFiles.some((file) => file.startsWith('src/'))) {
    problems.push('no change under src/ — a test alone does not fix a defect');
  }
  const changedLines = input.numstat.reduce((total, row) => total + row.added + row.deleted, 0);
  if (changedLines > maxLines) {
    problems.push(`${changedLines} changed lines exceed the ${maxLines}-line cap for an autonomous fix`);
  }
  return { ok: problems.length === 0, problems, testFiles, sourceFiles, changedLines };
}

/** `git diff --numstat` rows. Binary files report `-` and count as one line each. */
export function parseNumstat(text: string): NumstatRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [added = '0', deleted = '0', ...rest] = line.split('\t');
      return {
        added: added === '-' ? 1 : Number(added) || 0,
        deleted: deleted === '-' ? 1 : Number(deleted) || 0,
        file: rest.join('\t'),
      };
    });
}

/** `fix(<area>): <title>` — area is the first path segment under `src/`. */
export function commitSubject(report: Pick<SupervisorMendReport, 'title'>, sourceFiles: readonly string[]): string {
  const first = sourceFiles.find((file) => file.startsWith('src/')) ?? '';
  const segment = first.split('/')[1] ?? 'core';
  // `src/atoms/plan.ts` → atoms; `src/index.ts` → index.
  const area = segment.replace(/\.[cm]?[jt]sx?$/, '') || 'core';
  const title = report.title.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return truncate(`fix(${area}): ${title}`, 72);
}

export interface MendVerification {
  readonly testFailedBefore: boolean;
  readonly checkPassed: boolean;
  readonly testFiles: readonly string[];
  readonly checkCommand: string;
}

export function commitMessage(input: {
  report: SupervisorMendReport;
  sourceFiles: readonly string[];
  runId: string;
  key: string;
  verification: MendVerification;
}): string {
  return [
    commitSubject(input.report, input.sourceFiles),
    '',
    input.report.summary.trim(),
    '',
    `Run: ${input.runId}`,
    `Regression test fails before the fix: ${input.verification.testFailedBefore ? 'yes' : 'no'}`,
    `Harness check after the fix (${input.verification.checkCommand}): ${input.verification.checkPassed ? 'green' : 'red'}`,
    'Full check: CI, on the pull request',
    `Defect-Key: ${input.key}`,
    'Authored-By: atoma mender (supervisor stage 3, docs/supervisor-design.md)',
  ].join('\n');
}

export interface DiffStat {
  readonly files: number;
  readonly added: number;
  readonly deleted: number;
}

export function pullRequestBody(input: {
  report: SupervisorMendReport;
  finding: VerdictFinding | SanitisedFinding;
  /** Which deployment asked, when the request came across a boundary. */
  instance?: string | null;
  runId: string;
  key: string;
  verification: MendVerification;
  provider: SupervisorProvider;
  served: readonly ServedModelUsage[] | null;
  costUsd: number | null;
  diffStat: DiffStat;
}): string {
  const safe = sanitiseFinding(input.finding);
  const evidence = safe.evidence.map((item) => `- \`${item.ref}\` — ${item.quote}`).join('\n');
  const servedLine = input.served
    ? input.served
        .map((entry) => `${entry.model}${entry.costUsd != null ? ` ($${entry.costUsd.toFixed(4)})` : ''}`)
        .join(', ')
    : 'not reported';
  const { report, verification, provider } = input;
  return [
    '## What the analyst found',
    '',
    `**${safe.title}** (\`${safe.kind}\`, confidence ${safe.confidence}) on run \`${input.runId}\`.`,
    '',
    ...(safe.kind === 'mechanism_candidate'
      ? ['> **A design choice for the reviewer.** This finding asked for a NEW mechanism — a rule, a threshold,',
        '> a policy — that nobody has chosen yet. The change below proposes one; merging it is making that choice.',
        '']
      : []),
    safe.detail,
    '',
    '### Evidence',
    '',
    evidence || '- (none recorded)',
    '',
    '### Proposed direction',
    '',
    `- where: ${safe.proposedFix.where}`,
    `- what: ${safe.proposedFix.what}`,
    `- intentional choices checked by the analyst: ${safe.proposedFix.checkedIntentionalChoices}`,
    '',
    '## What the mender changed',
    '',
    report.summary.trim(),
    '',
    `Intentional choices checked by the mender: ${report.checkedIntentionalChoices.trim()}`,
    ...(report.reviewerNotes ? ['', `**Reviewer notes:** ${report.reviewerNotes.trim()}`] : []),
    '',
    '## Verification (harness-run, not model-reported)',
    '',
    `- regression test FAILS before the fix: ${verification.testFailedBefore ? '✅' : '❌'} (${verification.testFiles.join(', ')})`,
    `- \`${verification.checkCommand}\` after the fix: ${verification.checkPassed ? '✅ green' : '❌ red'}`,
    '- the full `npm run check` runs in CI on this pull request; the ruleset requires it before a merge',
    `- files changed: ${input.diffStat.files} · lines: +${input.diffStat.added} −${input.diffStat.deleted}`,
    '',
    '## Provenance',
    '',
    `- model requested: \`${provider.model}\` (${provider.source} provider${provider.baseUrl ? `, ${provider.baseUrl}` : ''})`,
    `- models served: ${servedLine}`,
    `- mend cost: ${input.costUsd != null ? `$${input.costUsd.toFixed(4)}` : 'not reported'}`,
    `- Defect-Key: ${input.key}`,
    ...(input.instance ? [`- requested by: ${input.instance}`] : []),
    '',
    '---',
    '',
    'Opened by the atoma mender (supervisor stage 3). The model edited files in an',
    'isolated worktree and ran the checks; the harness re-ran them, wrote the commit,',
    'pushed the branch and opened this PR. **A person owns the merge** — the mender',
    'has no auto-merge path, by design (`docs/supervisor-design.md`, open decision 2).',
    'Trace text never reached the model: it saw the structured finding above only.',
  ].join('\n');
}
