import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { JEV_THRESHOLDS } from '../../../src/core/jevQuestions.ts';
import { JEV_MODEL } from '../../../src/core/jev.ts';
const root = new URL('.', import.meta.url);
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'));
const controls = read('replay-control-selection.json');
const disagreements = read('disagreement-evidence.json').map((item) => ({
  runId: item.trace.id, eventId: item.event.id, subject: item.event.subject,
  group: 'disagreement',
}));
const proposal = read('question-proposal.json');
const config = {
  experimentId: '20261021-questions-v1',
  model: JEV_MODEL, thresholds: JEV_THRESHOLDS, proposal,
  cases: [...disagreements, ...controls],
};
const template = fs.readFileSync(new URL('replay-worker-template.mjs', root), 'utf8');
const worker = 'const CONFIG = JSON.parse(' + JSON.stringify(JSON.stringify(config)) + ');\n' + template;
fs.writeFileSync(new URL('remote-replay.mjs', root), worker);
fs.writeFileSync(new URL('remote-replay-preflight.mjs', root),
  'const CONFIG = JSON.parse(' + JSON.stringify(JSON.stringify({ ...config, preflightOnly: true })) + ');\n' + template);
fs.writeFileSync(new URL('replay-preregistration.json', root), JSON.stringify({
  createdAt: new Date().toISOString(), model: config.model, thresholds: config.thresholds,
  experimentId: config.experimentId, cases: config.cases,
  arms: ['original questions/original state', 'new questions/original state', 'original questions/restored bounded state', 'new questions/restored bounded state'],
  repeats: 3,
  reversedOptionDiagnostic: 'one additional reading per arm for four disagreements and eight previous agreements',
  totalRequests: 336,
  selection: 'first distinct run per stratum in archived page order; 6 agreed plans, 2 agreed results, 6 model-approved deferred plans, 6 model-approved deferred results',
  availabilityExclusion: 'Initial no-network preflight found run cafd0d69-267e-4caf-a94c-60a6e2f1ec25 absent; replaced with the next distinct run before observing any new model answer.',
  stateRestoration: 'binding host-rendered phase criteria outside capped history; fair per-observation evidence cap; bounded readbacks of task-named sources, all within existing field budgets. Experimental packet shaping, not a production implementation.',
  limitations: ['approval states reconstructed from validator prompts, not exact wire captures', 'model reference is not independent correctness', 'four-arm state changes combine scope and evidence packet restoration', 'no deployment regardless of outcome; no thresholds fitted'],
  predictions: 'Measure whether missing-proof disagreements defer more often, and whether previously agreed approvals are lost; no accuracy or savings claim from mocked tests.',
  proposalHash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
  workerHash: createHash('sha256').update(worker).digest('hex'),
  rawControlTextExported: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ cases: config.cases.length, requests: 336, workerHash: createHash('sha256').update(worker).digest('hex') }));
