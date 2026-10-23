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
