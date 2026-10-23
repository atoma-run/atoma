import fs from 'node:fs';
import { buildApproval, JEV_STATE_CHARS } from '../../../src/core/jevQuestions.ts';
import { parseValidationPrompt } from '../../../src/atoms/jevCalibration.ts';

// Offline reconstruction from saved validator events. Approval requests were not
// persisted verbatim; these states are reconstructions, not wire captures.
const root = new URL('.', import.meta.url);
const cases = JSON.parse(fs.readFileSync(new URL('disagreement-evidence.json', root), 'utf8'));
const proposal = JSON.parse(fs.readFileSync(new URL('question-proposal.json', root), 'utf8'));
const report = [];
for (const entry of cases) {
  const event = entry.event;
  const lines = event.userContent.split('\n');
  const taskAt = lines.findIndex((line) => line.startsWith('Task: '));
  const payloadAt = lines.findIndex((line) => line.startsWith(event.subject + ': '));
  const parsed = parseValidationPrompt({
    runId: entry.trace.id,
    orgId: '',
    startedAt: entry.trace.startedAt,
    eventId: event.id,
    role: event.subject === 'PLAN' ? 'validate-plan' : 'validate-result',
    actor: event.actor,
    recipe: false,
    userContent: event.userContent,
    response: event.response,
  });
  if (!parsed) throw new Error('Cannot reconstruct ' + entry.key);
  const context = lines.slice(taskAt + 1, payloadAt)
    .filter((line) => line.trim() && line !== '== TASK CONTEXT ==');
  const originalShape = buildApproval({
    ...parsed.request,
    task: { ...parsed.request.task, description: lines[taskAt].slice(6) },
    context,
  });
  const replayShape = buildApproval(parsed.request);
  if (typeof originalShape === 'string' || typeof replayShape === 'string') {
    throw new Error('Builder refused ' + entry.key);
  }
  const state = originalShape.state;
  const rawContext = JSON.stringify(context);
  const keptContext = typeof state.context === 'string' ? state.context : JSON.stringify(state.context);
  const groundTruth = parsed.request.groundTruth ?? '';
  const half = Math.floor(JEV_STATE_CHARS.groundTruth / 2);
  const removedMiddle = groundTruth.length > JEV_STATE_CHARS.groundTruth
    ? groundTruth.slice(half, -half) : '';
  const markers = [
    'Acceptance criteria this phase must prove',
    '- c1: A fresh Spitogatos response yields',
  ];
  report.push({
    case: entry.key,
    modelEventId: event.id,
    jevEventId: entry.jev?.id ?? null,
    provenance: entry.trace.provenance,
    reconstructionOnly: true,
    proseRequirements: originalShape.requirements,
    requirementCount: originalShape.requirements.length,
    recordedJevRequirementCount: entry.jev
      ? Object.keys(entry.jev.answer.yes).filter((key) => key.startsWith('requirement_')).length : null,
    historicalReplayRequirementCount: replayShape.requirements.length,
    historicalReplayAddsContextProse: replayShape.requirements.length !== originalShape.requirements.length,
    context: {
      rawSerializedChars: rawContext.length,
      budgetChars: JEV_STATE_CHARS.plan,
      keptFieldChars: keptContext?.length,
      truncated: rawContext.length > JEV_STATE_CHARS.plan,
      markers: markers.map((marker) => ({
        marker,
        offsetInSerializedContext: rawContext.indexOf(marker),
        presentAfterCap: keptContext?.includes(marker) ?? false,
      })),
    },
    groundTruth: {
      rawChars: groundTruth.length,
      budgetChars: JEV_STATE_CHARS.groundTruth,
      keptFieldChars: state.groundTruth?.length ?? 0,
      removedMiddleContainsProtectedFilesDeclaration: removedMiddle.includes('protectedFiles'),
      removedMiddleContainsChecksumCall: removedMiddle.includes('protectedFiles.map(checksum)'),
    },
    evidence: {
      modelLines: parsed.request.evidence?.length ?? 0,
      jevLinesIncludingOmissionNotice: state.evidence?.length ?? 0,
      serializedChars: JSON.stringify(state.evidence ?? []).length,
    },
    originalQuestion: originalShape.questions.requirement_1,
    proposedQuestion: event.subject === 'PLAN'
      ? proposal.planRequirement : proposal.resultRequirement,
    modelReference: JSON.parse(event.response),
    observedJevAnswer: entry.jev?.answer ?? null,
  });
}
fs.writeFileSync(new URL('question-diagnosis.json', root), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.map(({ originalQuestion, proposedQuestion, modelReference, observedJevAnswer, proseRequirements, ...entry }) => entry), null, 2));
