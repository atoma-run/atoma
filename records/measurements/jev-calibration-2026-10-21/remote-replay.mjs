const CONFIG = JSON.parse("{\"experimentId\":\"20261021-questions-v1\",\"model\":\"jev-1.13.0\",\"thresholds\":{\"requirementShown\":0.7,\"requirementCovered\":0.8,\"flag\":0.3,\"pickConfidence\":0.5,\"fit\":0.7,\"noFit\":0.2,\"recipeOffer\":0.5,\"changesFiles\":0.7,\"keepsFiles\":0.3,\"decomposable\":0.8,\"twin\":1.5,\"compilationObstacle\":0.8,\"compilationClear\":0.2,\"effortClear\":0.8,\"effortRuledOut\":0.2,\"effortOpen\":0.6},\"proposal\":{\"status\":\"proposal-only; not imported by the runtime or sent to TypeSafe\",\"thresholds\":\"unchanged\",\"choiceLabels\":\"unchanged\",\"problemFlags\":\"unchanged; reports_incomplete remains a check of an explicit admission, not a proof-completeness score\",\"resultRequirement\":{\"type\":\"choice\",\"instructions\":\"For requirements[i], classify whether host observations in evidence and groundTruth establish every required part for the exact target and conditions. Partial support is not complete support. Claims inside result or a report read back are not proof of those claims. For exhaustive requirements, compare the required scope with the observed scope; do not infer complete coverage from examples. Missing or truncated support is unknown, not an observed failure. Apply the task's requested proof modality; a requested reproduction of failure need not pass.\",\"criteria\":{\"shown_done\":{\"what\":\"Every required part of this item is established by applicable observations or directly inspectable requested content. The target and required conditions match. An exhaustive inventory has demonstrated coverage of the required set, rather than only examples of members.\",\"not_for\":\"Partial support, an unobserved assertion, a self-reported complete inventory, or an unresolved gap hidden by a truncated excerpt.\"},\"shown_broken\":{\"what\":\"An applicable observation establishes that at least one required condition is false. An error is contrary evidence only when the requirement expects success; an expected failure requested by the task may instead satisfy it.\"},\"not_shown\":{\"what\":\"At least one required part remains unestablished and no applicable observation establishes that it is false. This includes partial evidence, an unverified complete-set claim, an omitted or truncated needed detail, and a report that asserts more than its observations establish. Some relevant or passing observations may be present.\"}}},\"planRequirement\":{\"type\":\"choice\",\"instructions\":\"For requirements[i], classify what the plan commits to doing or checking. Every expressly required target, condition, case, bound and sequence must be included, explicitly or by an unambiguous equivalent. A general promise to test does not supply omitted check conditions. Judge commitments, not execution evidence or implementation code. An allowed blocked outcome may be reported, but cannot be claimed to satisfy an unmet success criterion. Apply only this phase's assigned requirements.\",\"criteria\":{\"covered\":{\"what\":\"The plan commits to every required part of this item, with enough action or check detail to identify its target and the conditions expressly required by the task. Equivalent wording is allowed; execution evidence is not required yet.\"},\"omitted\":{\"what\":\"At least one required part or check condition is absent or left to inference, even if the plan addresses the general topic and includes other concrete actions.\"},\"contradicted\":{\"what\":\"The plan explicitly proposes an action, omission, deferral or success claim incompatible with a binding requirement of this phase. An allowed diagnostic failure outcome is not itself a contradiction; claiming that outcome satisfies an unmet success criterion is.\"}}},\"statePrerequisites\":[\"Pass already typed, binding criteria of the current child phase through the existing JevApprovalRequest.criteria field, using the same scope selection as the model validator; keep contextual and unassigned root criteria contextual.\",\"Keep binding requirements outside capped historical inputs. Do not recover requirements by searching arbitrary context prose or by treating an entire originalTask as the current phase.\",\"Keep the host-owned provenance of observations distinct from the truth of assertions inside their content: a read_file of a report establishes the report's bytes, not its unexecuted claims.\",\"For exhaustive proof, provide a bounded host-derived inventory and its observation references only when existing inspected source or typed contracts establish the required set. If the set cannot be established, leave coverage unknown for model review; never call a list of observed members exhaustive.\",\"Use existing typed items to ask narrower questions where possible. Do not introduce heuristic comma splitting, generated requirements, a new model extraction call or a global contradiction/completeness flag as part of this proposal.\",\"Do not increase evidence budgets to hide the omission. Preserve the existing validity and staleness rules for standing observations.\"],\"validationPlan\":{\"scope\":\"Archived inputs only; no new execution run\",\"measurementStatus\":\"not measured against Jev\",\"arms\":[\"Original questions and original reconstructed state\",\"Replacement questions with the same state\",\"Original questions with correctly scoped typed criteria and evidence references\",\"Replacement questions with the corrected state\"],\"controls\":[\"Freeze model version, thresholds and sampling; do not choose thresholds on these four examples.\",\"Use both recorded disagreements and previously agreed approvals, including earlier incidents.\",\"Keep references and diagnoses hidden from Jev; adjudicate disputed audit labels separately.\",\"Repeat identical cases and permute Choice option order as diagnostic checks; keep the recorded answer distributions.\",\"Measure disagreements, additional deferrals, input tokens, cost and latency; mocked answers cannot establish improved judgment accuracy.\"]}},\"cases\":[{\"runId\":\"2c628a5b-ec3b-4c7a-bb36-f0776312b666\",\"eventId\":\"3c7bdf59-a4d9-4875-a24d-0fd8b96ee9ca\",\"subject\":\"PLAN\",\"group\":\"disagreement\"},{\"runId\":\"e457d2c8-74f1-49e3-b1b7-4d4df1deba31\",\"eventId\":\"02500b38-a77e-44e9-9404-e7af67f0be4a\",\"subject\":\"RESULT\",\"group\":\"disagreement\"},{\"runId\":\"ade448fc-7cb2-47ec-a538-437bcd077d69\",\"eventId\":\"7a9dcacc-b55d-4494-b63e-7c386b2e9378\",\"subject\":\"PLAN\",\"group\":\"disagreement\"},{\"runId\":\"b04565ec-aa95-4748-8702-ea34bb4c266d\",\"eventId\":\"2b6f2987-ef1e-4caf-ae90-a65e6163557a\",\"subject\":\"RESULT\",\"group\":\"disagreement\"},{\"runId\":\"bec269a3-18c4-477b-8e55-3512e0ef17f6\",\"eventId\":\"6bf46a41-fa36-4f45-b8ad-5749fa53805b\",\"subject\":\"PLAN\",\"group\":\"previous-agreement\"},{\"runId\":\"760fef4c-6e76-4db4-8cfb-f969aaecb88c\",\"eventId\":\"f1d9aad7-c589-4586-ba65-22cd075b9b2c\",\"subject\":\"PLAN\",\"group\":\"previous-agreement\"},{\"runId\":\"1b1c9564-c6ec-419e-aeca-4c5d486f46a4\",\"eventId\":\"ae199fc2-a377-4622-b347-5dfdfc665e4f\",\"subject\":\"PLAN\",\"group\":\"previous-agreement\"},{\"runId\":\"f8f3384c-9074-45a5-ab31-bf16a5249dc5\",\"eventId\":\"cb40acbb-8906-463d-ac1d-195f263637e9\",\"subject\":\"PLAN\",\"group\":\"previous-agreement\"},{\"runId\":\"ade448fc-7cb2-47ec-a538-437bcd077d69\",\"eventId\":\"954039f9-7d5a-4932-9a8d-a592dcf476a5\",\"subject\":\"PLAN\",\"group\":\"previous-agreement\"},{\"runId\":\"b04565ec-aa95-4748-8702-ea34bb4c266d\",\"eventId\":\"b089fa92-925a-473d-aa7b-0f8367326b8b\",\"subject\":\"PLAN\",\"group\":\"previous-agreement\"},{\"runId\":\"1bf32e71-97c4-4061-96fd-d8b8dccade5f\",\"eventId\":\"894ca763-b055-4716-81fe-1d50d8cf25fb\",\"subject\":\"RESULT\",\"group\":\"previous-agreement\"},{\"runId\":\"cd21eff5-a076-46dc-907c-ced5a39c977b\",\"eventId\":\"1977cd2a-8933-44ab-a30d-3a7df152699a\",\"subject\":\"RESULT\",\"group\":\"previous-agreement\"},{\"runId\":\"351b224a-8d39-4f4c-848f-190228ed594d\",\"eventId\":\"bc3eed53-1863-4e48-b1bb-fb685af1dfdf\",\"subject\":\"PLAN\",\"group\":\"model-approved-deferred\"},{\"runId\":\"26b14f2f-411d-4327-9965-f66d5ac59dfb\",\"eventId\":\"1ab3e2dc-5b31-4e58-a380-9a172a1cdcb7\",\"subject\":\"PLAN\",\"group\":\"model-approved-deferred\"},{\"runId\":\"8a38383c-696a-42f5-8b2b-8ece0f1acd14\",\"eventId\":\"764fa756-a792-4559-a666-40c9b7b665a4\",\"subject\":\"PLAN\",\"group\":\"model-approved-deferred\"},{\"runId\":\"6451ea1d-b390-41d7-9c8d-51ba49fb2625\",\"eventId\":\"4b283755-ce7a-4cd0-99fc-1a4ae9ea40dc\",\"subject\":\"PLAN\",\"group\":\"model-approved-deferred\"},{\"runId\":\"6782ce92-26ab-4cc1-a7c9-7ee6df8e1e68\",\"eventId\":\"e152e86d-93f2-488b-92a4-da371fc0bb7c\",\"subject\":\"PLAN\",\"group\":\"model-approved-deferred\"},{\"runId\":\"c50f3566-b08c-4b7b-8269-9a027b27f2e0\",\"eventId\":\"902276d9-677b-4f22-a2f8-af1cb559678d\",\"subject\":\"PLAN\",\"group\":\"model-approved-deferred\"},{\"runId\":\"c092b5d6-554f-4214-9dcd-b91e664e2dcc\",\"eventId\":\"ea6a9c99-3d00-4732-8a1e-349e50775f19\",\"subject\":\"RESULT\",\"group\":\"model-approved-deferred\"},{\"runId\":\"351b224a-8d39-4f4c-848f-190228ed594d\",\"eventId\":\"0e1b3ab8-3a4b-47f6-8333-30a38156cfeb\",\"subject\":\"RESULT\",\"group\":\"model-approved-deferred\"},{\"runId\":\"26b14f2f-411d-4327-9965-f66d5ac59dfb\",\"eventId\":\"a507116f-8915-4454-9478-7b9221f701d1\",\"subject\":\"RESULT\",\"group\":\"model-approved-deferred\"},{\"runId\":\"8a38383c-696a-42f5-8b2b-8ece0f1acd14\",\"eventId\":\"fe8d6666-cb33-45df-b353-625cee669abb\",\"subject\":\"RESULT\",\"group\":\"model-approved-deferred\"},{\"runId\":\"6451ea1d-b390-41d7-9c8d-51ba49fb2625\",\"eventId\":\"4f95c75d-3bef-48bb-a3d0-2de44447bb58\",\"subject\":\"RESULT\",\"group\":\"model-approved-deferred\"},{\"runId\":\"6782ce92-26ab-4cc1-a7c9-7ee6df8e1e68\",\"eventId\":\"0226b09e-6131-428a-8af1-23c047616bb6\",\"subject\":\"RESULT\",\"group\":\"model-approved-deferred\"}]}");
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// CONFIG is inserted by assemble-replay.mjs. Only numeric results leave this
// worker; trace content stays in memory on the existing production host.
const release = fs.realpathSync('/home/atoma/current');
const load = (name) => import(pathToFileURL(path.join(release, 'dist', name)).href);
const { jevAsk, JEV_MODEL } = await load('core/jev.js');
const { buildApproval, readApproval, headAndTail, JEV_THRESHOLDS, JEV_STATE_CHARS } = await load('core/jevQuestions.js');
const { parseValidationPrompt } = await load('atoms/jevCalibration.js');
if (JEV_MODEL !== CONFIG.model || JSON.stringify(JEV_THRESHOLDS) !== JSON.stringify(CONFIG.thresholds)) {
  throw new Error('Pinned model or thresholds changed before replay');
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resultsPath = '/tmp/atoma-jev-question-replay-' + CONFIG.experimentId + (CONFIG.preflightOnly ? '-preflight-' + Date.now() : '') + '.ndjson';
if (fs.existsSync(resultsPath)) throw new Error('Experiment id already exists; do not pay twice');
const output = fs.openSync(resultsPath, 'wx', 0o600);
const emit = (value) => {
  const line = JSON.stringify(value);
  fs.writeSync(output, line + '\n');
  console.log(line);
};

function listRunFiles() {
  const root = '/home/atoma/state/projects/orgs';
  const found = new Map();
  for (const org of fs.readdirSync(root, { withFileTypes: true })) {
    const projects = path.join(root, org.name, 'projects');
    if (!org.isDirectory() || !fs.existsSync(projects)) continue;
    for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
      const runs = path.join(projects, project.name, 'runs');
      if (!project.isDirectory() || !fs.existsSync(runs)) continue;
      for (const run of fs.readdirSync(runs, { withFileTypes: true })) {
        if (!CONFIG.cases.some((item) => item.runId === run.name)) continue;
        const traces = path.join(runs, run.name, 'traces');
        if (!fs.existsSync(traces)) continue;
        found.set(run.name, fs.readdirSync(traces).filter((name) => name.endsWith('.json')).map((name) => path.join(traces, name)));
      }
    }
  }
  return found;
}

function basePlan(item, event, trace) {
  const subject = event.subject;
  const parsed = parseValidationPrompt({
    runId: item.runId, orgId: '', startedAt: trace.startedAt,
    eventId: event.id, role: subject === 'PLAN' ? 'validate-plan' : 'validate-result',
    actor: event.actor, recipe: false, userContent: event.userContent, response: event.response,
  });
  if (!parsed) throw new Error('Unparseable selected event ' + item.eventId);
  const lines = event.userContent.split('\n');
  const taskAt = lines.findIndex((line) => line.startsWith('Task: '));
  const payloadAt = lines.findIndex((line) => line.startsWith(subject + ': '));
  const contextAt = lines.findIndex((line, index) => index > taskAt && index < payloadAt && line === '== TASK CONTEXT ==');
  const context = lines.slice(contextAt >= 0 ? contextAt + 1 : taskAt + 1, payloadAt).filter((line) => line.trim());
  const description = contextAt >= 0
    ? [lines[taskAt].slice(6), ...lines.slice(taskAt + 1, contextAt)].join('\n').trim()
    : lines[taskAt].slice(6);
  const request = { ...parsed.request, task: { ...parsed.request.task, description }, context };
  const plan = buildApproval(request);
  if (typeof plan === 'string') throw new Error('Selected case exceeds current builder: ' + item.eventId);
  const expected = JSON.parse(event.response).approved;
  if (typeof expected !== 'boolean') throw new Error('Selected reference has no verdict');
  return { plan, request, lines, expected };
}

function restoredState(baseline, request, lines) {
  const state = structuredClone(baseline.state);
  const requirements = [...baseline.requirements];
  // Read only the host-rendered binding phase block. Do not promote root
  // context, previous diagnoses or arbitrary tool text into requirements.
  const at = lines.findIndex((line) => line.startsWith('Acceptance criteria this phase must prove ('));
  let addedCriteria = 0;
  if (at >= 0) {
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith('- ')) break;
      if (!requirements.includes(line.slice(2))) {
        requirements.push(line.slice(2));
        addedCriteria++;
      }
    }
  }
  state.requirements = requirements;
  // Diagnostic bounded packet: retain all original observation IDs, sharing
  // the same evidence character budget rather than discarding whole lines.
  const evidence = request.evidence;
  let balancedEvidence = false;
  if (Array.isArray(evidence) && JSON.stringify(evidence).length > JEV_STATE_CHARS.evidence) {
    let perLine = Math.max(64, Math.floor((JEV_STATE_CHARS.evidence - 100) / evidence.length) - 5);
    state.evidence = evidence.map((line) => headAndTail(line, perLine));
    while (JSON.stringify(state.evidence).length > JEV_STATE_CHARS.evidence && perLine > 64) {
      perLine = Math.max(64, Math.floor(perLine * 0.85));
      state.evidence = evidence.map((line) => headAndTail(line, perLine));
    }
    if (JSON.stringify(state.evidence).length > JEV_STATE_CHARS.evidence) throw new Error('Restored evidence exceeds unchanged budget');
    balancedEvidence = true;
  }
  // Keep named source readbacks from the independent host block alongside a
  // bounded baseline excerpt. Selection uses task paths, never verdict labels.
  let sourceReadbacks = 0;
  const truth = request.groundTruth;
  if (truth && truth.length > JEV_STATE_CHARS.groundTruth) {
    const relevant = truth.split('\n').filter((line) => {
      const match = /^- (.+?) \(\d+ chars(?:,.*?)?\):/.exec(line);
      return match && request.task.description.includes(match[1]);
    });
    if (relevant.length) {
      const available = Math.floor((JEV_STATE_CHARS.groundTruth - 220) / 2);
      const perRead = Math.max(80, Math.floor(available / relevant.length) - 30);
      state.groundTruth = headAndTail(truth, available) +
        '\n== HOST-READ SOURCE EXCERPTS (same independent readback; excerpts are not complete files) ==\n' +
        relevant.map((line) => headAndTail(line, perRead)).join('\n');
      sourceReadbacks = relevant.length;
    }
  }
  return { state, requirements, addedCriteria, balancedEvidence, sourceReadbacks };
}

function questionSet(plan, requirements, proposed) {
  const questions = {};
  for (let index = 0; index < requirements.length; index++) {
    const original = plan.questions['requirement_' + Math.min(index + 1, plan.requirements.length)];
    const template = proposed
      ? (plan.request.subject === 'PLAN' ? CONFIG.proposal.planRequirement : CONFIG.proposal.resultRequirement)
      : original;
    const question = structuredClone(template);
    question.instructions = proposed
      ? question.instructions.replaceAll('requirements[i]', 'requirements[' + index + ']')
      : question.instructions.replace(/requirements\[\d+\]/g, 'requirements[' + index + ']');
    questions['requirement_' + (index + 1)] = question;
  }
  for (const flag of plan.flags) questions[flag] = plan.questions[flag];
  return questions;
}

const runs = listRunFiles();
const cases = [];
for (const item of CONFIG.cases) {
  let event, trace;
  for (const file of runs.get(item.runId) ?? []) {
    const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
    const found = candidate.events?.find((entry) => entry.id === item.eventId);
    if (found) { event = found; trace = candidate; break; }
  }
  if (!event) throw new Error('Missing selected archived event ' + item.eventId);
  const { plan, request, lines, expected } = basePlan(item, event, trace);
  const restored = restoredState(plan, request, lines);
  if (restored.requirements.length > 48) throw new Error('Restored case exceeds question cap');
  if ((restored.state.groundTruth?.length ?? 0) > JEV_STATE_CHARS.groundTruth + 24) throw new Error('Restored truth exceeds unchanged budget');
  cases.push({ ...item, plan, restored, expected });
}
emit({
  type: 'manifest', experimentId: CONFIG.experimentId, model: JEV_MODEL,
  thresholds: JEV_THRESHOLDS, release: path.basename(release),
  proposalHash: hash(CONFIG.proposal), cases: cases.length, repeats: 3,
  controlsStayOnHost: true, resultsPath,
  states: cases.map((item) => ({
    caseId: item.eventId, runId: item.runId, group: item.group,
    subject: item.plan.request.subject, modelReference: item.expected,
    baselineHash: hash(item.plan.state), restoredHash: hash(item.restored.state),
    originalRequirements: item.plan.requirements.length, restoredRequirements: item.restored.requirements.length,
    addedCriteria: item.restored.addedCriteria, balancedEvidence: item.restored.balancedEvidence,
    sourceReadbacks: item.restored.sourceReadbacks,
    baselineChars: JSON.stringify(item.plan.state).length,
    restoredChars: JSON.stringify(item.restored.state).length,
  })),
});
if (CONFIG.preflightOnly) {
  emit({ type: 'preflight-complete', cases: cases.length, externalRequests: 0, credentialRead: false });
  fs.closeSync(output);
  process.exit(0);
}

const envText = fs.readFileSync('/home/atoma/config/atoma.env', 'utf8');
const keyLine = envText.split(/\r?\n/).find((line) => line.startsWith('TYPESAFE_API_KEY='));
if (!keyLine) throw new Error('Host TypeSafe credential unavailable');
let apiKey = keyLine.slice('TYPESAFE_API_KEY='.length).trim();
if ((apiKey.startsWith('"') && apiKey.endsWith('"')) || (apiKey.startsWith("'") && apiKey.endsWith("'"))) {
  apiKey = apiKey.slice(1, -1);
}
if (!apiKey) throw new Error('Empty host TypeSafe credential');

const jobs = [];
for (const item of cases) {
  for (const arm of ['original', 'questions', 'state', 'both']) {
    const corrected = arm === 'state' || arm === 'both';
    const proposed = arm === 'questions' || arm === 'both';
    const state = corrected ? item.restored.state : item.plan.state;
    const requirements = corrected ? item.restored.requirements : item.plan.requirements;
    const questions = questionSet(item.plan, requirements, proposed);
    const readings = item.group === 'disagreement' || item.group === 'previous-agreement' ? 4 : 3;
    for (let repeat = 0; repeat < readings; repeat++) {
      const reversedOptions = repeat === 3;
      const asked = structuredClone(questions);
      if (reversedOptions) {
        for (const question of Object.values(asked)) {
          if (question.type === 'choice') question.criteria = Object.fromEntries(Object.entries(question.criteria).reverse());
        }
      }
      const jobId = item.eventId + ':' + arm + ':' + repeat;
      jobs.push({
        item, arm, repeat, reversedOptions, state, requirements, questions: asked, jobId,
        order: hash(CONFIG.experimentId + ':' + jobId),
      });
    }
  }
}
jobs.sort((a, b) => a.order.localeCompare(b.order));
if (jobs.length !== 336) throw new Error('Unexpected paid request count ' + jobs.length);
let cursor = 0, spent = 0, done = 0;
const started = Date.now();
async function worker() {
  while (cursor < jobs.length) {
    if (spent >= 1 || Date.now() - started > 8 * 60_000) return;
    const job = jobs[cursor++];
    const before = Date.now();
    let result;
    try {
      const deadlineAt = Date.now() + 15_000;
      const answer = await jevAsk({
        apiKey, state: job.state, questions: job.questions,
        signal: AbortSignal.timeout(15_000), deadlineAt,
      });
      const reading = readApproval({
        request: { subject: job.item.plan.request.subject },
        requirements: job.requirements, flags: job.item.plan.flags,
      }, answer.answers, CONFIG.thresholds);
      spent += answer.costUsd;
      result = {
        type: 'reading', jobId: job.jobId, caseId: job.item.eventId, runId: job.item.runId,
        group: job.item.group, subject: job.item.plan.request.subject,
        arm: job.arm, repeat: job.repeat, reversedOptions: job.reversedOptions,
        modelReference: job.item.expected, approved: reading.decision?.approved === true,
        acceptable: reading.answer.yes.acceptable, causes: reading.causes ?? [],
        scores: reading.answer, rawAnswers: answer.answers,
        durationMs: Date.now() - before, costUsd: answer.costUsd,
        inputTokens: answer.inputTokens, outputTokens: answer.outputTokens,
        servedModel: answer.servedModel, requestId: answer.requestId,
        requestHash: hash({ state: job.state, questions: job.questions }),
      };
    } catch (error) {
      result = {
        type: 'failure', jobId: job.jobId, caseId: job.item.eventId,
        arm: job.arm, repeat: job.repeat, reversedOptions: job.reversedOptions,
        error: error instanceof Error ? error.name : 'unknown',
        durationMs: Date.now() - before, costUsd: null,
      };
    }
    emit(result);
    done++;
    if (done % 24 === 0) console.error(JSON.stringify({ completed: done, total: jobs.length, costUsd: spent }));
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
emit({ type: 'complete', completed: done, planned: jobs.length, costUsd: spent, wallMs: Date.now() - started, thresholdsChanged: false, runsStarted: 0 });
fs.closeSync(output);
