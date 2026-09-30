import { describe, expect, it } from 'vitest';
import {
  JEV_THRESHOLDS,
  NEW_RECIPE,
  NO_CANDIDATE,
  buildApproval,
  buildChoice,
  buildTwin,
  readApproval,
  readChoice,
  readTwin,
  taskRequirements,
  type JevAnswers,
  type JevQuestion,
} from '../src/core/jevQuestions.js';
import type { JevApprovalRequest, JevChoiceRequest, JevTwinRequest } from '../src/core/types.js';

/**
 * The questions TypeSafe's documentation prescribes (docs.typesafe.ai, read in
 * full 2026-09-29) and the readings that turn their answers into decisions.
 * They decide nothing until `atoma_jev_calibrate` has measured them, so these
 * pin the builders and readers alone: atomic questions, a Choice for WHICH and
 * a Noul per option for WHETHER, problem flags framed so TRUE is wrong, and a
 * middle band handed to the model rather than acted on.
 */

type Answer = JevAnswers[string];

const choiceAnswer = (choice: string, probability = 0.95, confidence = probability): Answer => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: { [choice]: probability },
});
const noulAnswer = (noul: number): Answer => ({ type: 'noul', noul });
const scoreAnswer = (score: number, confidence = 0.9): Answer => ({ type: 'score', score, confidence, probabilities: {} });

/** A clear answer of each question's type — first option, a low noul, the lowest level — unless overridden. */
function answersFor(questions: Readonly<Record<string, JevQuestion>>, overrides: Record<string, Answer> = {}): JevAnswers {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (overrides[id]) answers[id] = overrides[id]!;
    else if (question.type === 'noul') answers[id] = noulAnswer(0.05);
    else if (question.type === 'score') answers[id] = scoreAnswer(0, 0.95);
    else answers[id] = choiceAnswer(Object.keys(question.criteria)[0]!, 0.97);
  }
  return answers;
}

function built<T>(plan: T | string): T {
  if (typeof plan === 'string') throw new Error(plan);
  return plan;
}

const CATALOG = [
  { name: 'Water', description: 'builds and browser-validates static web pages' },
  { name: 'Methane', description: 'builds and probes Node HTTP JSON APIs' },
];

const choiceRequest: JevChoiceRequest = {
  question: 'agent',
  task: { description: 'build a landing page', constraints: ['no dependencies'] },
  candidates: CATALOG,
  actorName: 'Idioblast',
  actorTier: 2,
};

/** In CATALOG order: agent_1 is Water, agent_2 is Methane. */
const pickMethane = { choice: choiceAnswer('agent_2'), 'fits::agent_2': noulAnswer(0.9), 'fits::agent_1': noulAnswer(0.2) };

describe('task requirements, one question each', () => {
  it('splits sentences and semicolon clauses, leaving file names, e.g. and decimals whole', () => {
    expect(
      taskRequirements(
        'Build a small Node HTTP server in server.js with no dependencies. GET /health returns {"ok": true}; ' +
          'POST /api/notes adds a note, e.g. a title and a body. Rates are 1.08 USD per EUR.'
      )
    ).toEqual([
      'Build a small Node HTTP server in server.js with no dependencies.',
      'GET /health returns {"ok": true}',
      'POST /api/notes adds a note, e.g. a title and a body.',
      'Rates are 1.08 USD per EUR.',
    ]);
  });

  it('joins fragments too short to be a requirement, and bounds a long task', () => {
    expect(taskRequirements('Write a README. Test it. Ship.')).toEqual(['Write a README. Test it. Ship.']);
    const long = Array.from({ length: 30 }, (_, i) => `Requirement number ${i} holds.`).join(' ');
    expect(taskRequirements(long)).toHaveLength(10);
    expect(taskRequirements('   ')).toEqual([]);
  });
});

describe('the prefilter: a Choice for which, a Noul per option for whether', () => {
  it('acts on a confident pick whose own fits question says yes', () => {
    const plan = built(buildChoice(choiceRequest));
    // Opaque keys: the chemistry names mean nothing to a literal reader.
    expect(Object.keys((plan.questions['choice'] as { criteria: object }).criteria)).toEqual(['agent_1', 'agent_2', NO_CANDIDATE]);
    expect(Object.keys(plan.questions)).toEqual(['choice', 'fits::agent_1', 'fits::agent_2', 'decomposable']);
    expect(plan.state).toEqual({ task: 'build a landing page', constraints: ['no dependencies'] });
    expect(JSON.stringify([plan.state, plan.questions])).not.toContain('Methane');
    const reading = readChoice(plan, answersFor(plan.questions, { ...pickMethane, decomposable: noulAnswer(0.85) }));
    expect(reading.decision).toEqual({ target: 'Methane', confidence: 0.95, decomposable: true });
    expect(reading.outcome).toBe('picked Methane (decomposable)');
    expect(reading.answer).toMatchObject({ choice: 'Methane', yes: { 'fits:Methane': 0.9, 'fits:Water': 0.2, decomposable: 0.85 } });
    expect(reading.causes).toBeUndefined();
  });

  it('hands an unsure pick to the model: low confidence, or a pick that does not itself fit', () => {
    const plan = built(buildChoice(choiceRequest));
    for (const [answers, reason, cause] of [
      [{ ...pickMethane, choice: choiceAnswer('agent_2', 0.45) }, 'confidence 0.45', 'confidence'],
      [{ ...pickMethane, 'fits::agent_2': noulAnswer(0.5) }, 'Methane fits at 0.50', 'fit'],
    ] as const) {
      const reading = readChoice(plan, answersFor(plan.questions, answers));
      expect(reading.decision).toBeNull();
      expect(reading.outcome).toBe(`model decides (${reason})`);
      expect(reading.causes).toEqual([cause]);
    }
    // The same answers pass under looser thresholds: they are call-time inputs.
    const loose = readChoice(plan, answersFor(plan.questions, { ...pickMethane, 'fits::agent_2': noulAnswer(0.5) }), {
      ...JEV_THRESHOLDS,
      fit: 0.5,
    });
    expect(loose.decision).toMatchObject({ target: 'Methane' });
  });

  it('escalates only when every option says it does not fit, whatever the Choice ranked first', () => {
    const plan = built(buildChoice(choiceRequest));
    // A Choice's probabilities sum to 1: its winner says nothing about WHETHER anything fits.
    const nothingFits = readChoice(
      plan,
      answersFor(plan.questions, { choice: choiceAnswer('agent_2'), 'fits::agent_1': noulAnswer(0.1), 'fits::agent_2': noulAnswer(0.15) })
    );
    expect(nothingFits.decision).toMatchObject({ target: null });
    expect(nothingFits.outcome).toBe(`picked ${NO_CANDIDATE}`);
    const disagreeing = readChoice(plan, answersFor(plan.questions, { choice: choiceAnswer(NO_CANDIDATE), 'fits::agent_1': noulAnswer(0.8) }));
    expect(disagreeing.decision).toBeNull();
    expect(disagreeing.outcome).toBe('model decides (none_of_these, yet a candidate fits at 0.80)');
    expect(disagreeing.causes).toEqual(['none_but_fits']);
  });

  it('asks identically described clones as one option, and takes the canonical first', () => {
    // Run dbfaf275: four full-stack clones split the mass and made the argmax a coin toss.
    const same = 'Node full-stack app builder and verifier';
    const plan = built(
      buildChoice({
        ...choiceRequest,
        candidates: [
          { name: 'Methane', description: 'Node HTTP server builder' },
          { name: 'CarbonDioxide', description: same },
          { name: 'Ethanol', description: same },
          { name: 'Dopamine', description: same },
        ],
      })
    );
    expect(Object.keys((plan.questions['choice'] as { criteria: object }).criteria)).toEqual(['agent_1', 'agent_2', NO_CANDIDATE]);
    const reading = readChoice(
      plan,
      // 0.6 on a coupled phase is below the conservative decomposition bar.
      answersFor(plan.questions, { choice: choiceAnswer('agent_2', 0.85), 'fits::agent_2': noulAnswer(0.9), decomposable: noulAnswer(0.6) })
    );
    expect(reading.decision).toEqual({ target: 'CarbonDioxide', confidence: 0.85, decomposable: false });
    expect(reading.outcome).toBe('picked CarbonDioxide (first of 3 identical)');
  });

  it('at L3 gives a routing hint or none, never a model call, and asks no decomposition', () => {
    const plan = built(buildChoice({ ...choiceRequest, actorTier: 3 }));
    expect(Object.keys(plan.questions)).not.toContain('decomposable');
    // A lukewarm Choice is still a hint when the option fits at all...
    const lukewarm = readChoice(
      plan,
      answersFor(plan.questions, { ...pickMethane, choice: choiceAnswer('agent_2', 0.4), 'fits::agent_2': noulAnswer(0.4) })
    );
    expect(lukewarm.decision).toMatchObject({ target: 'Methane' });
    // ...and a disagreeing one is no hint rather than a model call.
    const disagreeing = readChoice(plan, answersFor(plan.questions, { choice: choiceAnswer(NO_CANDIDATE), 'fits::agent_2': noulAnswer(0.8) }));
    expect(disagreeing.decision).toMatchObject({ target: null });
    expect(disagreeing.outcome).toMatch(/^no hint \(/);
  });

  it('asks the recipe question by recipe id, with the opening of each body, and reads build against verify', () => {
    const plan = built(
      buildChoice({
        question: 'recipe',
        task: { description: 'add a break mode to the pomodoro page' },
        candidates: [
          { name: 'serve-and-validate-static-page', description: 'serve and validate a page', detail: '1. start_static_server 2. validate_html' },
          { name: 'build-self-contained-static-page', description: 'build a page', detail: '1. write_file index.html' },
        ],
        actorName: 'Idioblast',
        actorTier: 2,
      })
    );
    const criteria = (plan.questions['choice'] as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(criteria)).toEqual(['serve-and-validate-static-page', 'build-self-contained-static-page', NO_CANDIDATE]);
    expect(criteria['serve-and-validate-static-page']).toEqual({
      what: 'serve and validate a page',
      opening_steps: '1. start_static_server 2. validate_html',
    });
    expect(Object.keys(plan.questions)).toContain('task_changes_files');
    expect(Object.keys(plan.questions)).not.toContain('decomposable');
    // Run fd64b07e: the verify-only recipe for a task that had to change the page.
    const reading = readChoice(
      plan,
      answersFor(plan.questions, {
        choice: choiceAnswer('serve-and-validate-static-page', 0.8),
        'fits::serve-and-validate-static-page': noulAnswer(0.85),
        'fits::build-self-contained-static-page': noulAnswer(0.66),
        task_changes_files: noulAnswer(0.9),
        'changes_files::serve-and-validate-static-page': noulAnswer(0.1),
        'changes_files::build-self-contained-static-page': noulAnswer(0.92),
      })
    );
    expect(reading.decision).toBeNull();
    expect(reading.outcome).toBe(
      'model decides (serve-and-validate-static-page changes no files for a task that must; not offered: serve-and-validate-static-page)'
    );
    expect(reading.causes).toEqual(['files']);
    // Run 0a989a58: offered it, the model injected it. It is withheld now.
    expect(reading.withhold).toEqual(['serve-and-validate-static-page']);
  });

  it('withholds from the model every recipe read decisively against the task on files, and only those', () => {
    const candidates = [
      { name: 'serve-and-validate-static-page', description: 'serve and validate a page' },
      { name: 'build-self-contained-static-page', description: 'build a page' },
      { name: 'build-page-clone', description: 'build a page' },
      { name: 'update-docs', description: 'update the docs' },
    ];
    const plan = built(buildChoice({ question: 'recipe', task: { description: 't' }, candidates, actorTier: 2 }));
    const read = (task: number, serve: number, build: number, docs: number) =>
      readChoice(
        plan,
        answersFor(plan.questions, {
          // A lukewarm Choice, so the model decides whatever the files say.
          choice: choiceAnswer('update-docs', 0.4),
          'fits::update-docs': noulAnswer(0.8),
          task_changes_files: noulAnswer(task),
          'changes_files::serve-and-validate-static-page': noulAnswer(serve),
          'changes_files::build-self-contained-static-page': noulAnswer(build),
          'changes_files::update-docs': noulAnswer(docs),
        })
      );
    // A task that changes files: the recipe that keeps them is withheld.
    expect(read(0.97, 0.16, 0.92, 0.5).withhold).toEqual(['serve-and-validate-static-page']);
    // A task that keeps them: every recipe that changes files, clones included.
    expect(read(0.1, 0.16, 0.92, 0.5).withhold).toEqual(['build-self-contained-static-page', 'build-page-clone']);
    // A task read in the middle band withholds nothing, nor do middle-band recipes.
    expect(read(0.5, 0.16, 0.92, 0.5).withhold).toBeUndefined();
    expect(read(0.97, 0.35, 0.92, 0.5).withhold).toBeUndefined();
    // Jev's own pick needs no model, so nothing is withheld from one.
    const picked = readChoice(
      plan,
      answersFor(plan.questions, {
        choice: choiceAnswer('update-docs', 0.9),
        'fits::update-docs': noulAnswer(0.9),
        task_changes_files: noulAnswer(0.97),
        'changes_files::serve-and-validate-static-page': noulAnswer(0.16),
        'changes_files::build-self-contained-static-page': noulAnswer(0.92),
        'changes_files::update-docs': noulAnswer(0.9),
      })
    );
    expect(picked.decision).toMatchObject({ target: 'update-docs' });
    expect(picked.withhold).toBeUndefined();
    // Withheld, what is left must still fit: otherwise it is an escalate, not
    // a model call on a catalog Jev reads as fitting nothing.
    const leftUnfit = readChoice(
      plan,
      answersFor(plan.questions, {
        choice: choiceAnswer('serve-and-validate-static-page', 0.8),
        'fits::serve-and-validate-static-page': noulAnswer(0.9),
        'fits::update-docs': noulAnswer(0.1),
        task_changes_files: noulAnswer(0.97),
        'changes_files::serve-and-validate-static-page': noulAnswer(0.1),
        'changes_files::build-self-contained-static-page': noulAnswer(0.2),
        'changes_files::update-docs': noulAnswer(0.9),
      })
    );
    expect(leftUnfit.decision).toEqual({ target: null, confidence: 0.8, decomposable: false });
    expect(leftUnfit.outcome).toMatch(/^picked none_of_these \(.*not offered: serve-and-validate-static-page, build-self-contained-static-page, build-page-clone; nothing else fits\)$/);
    expect(leftUnfit.causes).toEqual(['files', 'withheld']);
  });

  it('refuses locally what it cannot ask, and hands back an answer that is not an option', () => {
    expect(buildChoice({ ...choiceRequest, candidates: [{ name: NO_CANDIDATE, description: 'x' }] })).toMatch(/is named/);
    expect(
      buildChoice({ ...choiceRequest, candidates: Array.from({ length: 255 }, (_, i) => ({ name: `atom-${i}`, description: `d${i}` })) })
    ).toMatch(/255 candidates exceed/);
    const plan = built(buildChoice(choiceRequest));
    const reading = readChoice(plan, answersFor(plan.questions, { choice: choiceAnswer('Ghost') }));
    expect(reading).toMatchObject({ decision: null, outcome: 'model decides', causes: ['not_an_option'] });
  });
});

describe('approvals: one question per requirement, and flags where TRUE is wrong', () => {
  const approvalRequest: JevApprovalRequest = {
    subject: 'RESULT',
    task: { description: 'Add PATCH /api/notes/:id. Document it in the README.' },
    child: { name: 'Methane', tier: 1, tools: ['write_file', 'fetch_url'] },
    // An output long enough to have pushed the summary out of a single cap.
    payload: { output: 'o'.repeat(30_000), summary: 'all routes probed' },
    // 800 observation lines (past the evidence cap), the newest being the one that matters.
    evidence: [...Array.from({ length: 799 }, (_, i) => `w${i}: fetch_url status=200 ${'x'.repeat(40)}`), 'w799: validate_html ok=false'],
    groundTruth: 'GROUND TRUTH: server.js exists',
    actorName: 'Idioblast',
    actorTier: 2,
  };
  const shown = (probability = 0.95) => choiceAnswer('shown_done', probability);

  it('approves when every requirement is shown and no flag is raised, reading the weakest link', () => {
    const plan = built(buildApproval(approvalRequest));
    // No holistic "contradicted by evidence" flag: measured without signal, it
    // is asked per requirement as `shown_broken`.
    expect(Object.keys(plan.questions)).toEqual(['requirement_1', 'requirement_2', 'reports_incomplete', 'addresses_reviewer']);
    expect(plan.questions['requirement_2']!.instructions).toBe('What do `evidence` and `groundTruth` show about `requirements[1]`?');
    expect(Object.keys((plan.questions['requirement_1'] as { criteria: object }).criteria)).toEqual(['shown_done', 'shown_broken', 'not_shown']);
    const state = plan.state as Record<string, unknown>;
    expect(state['requirements']).toEqual(['Add PATCH /api/notes/:id.', 'Document it in the README.']);
    expect(state['child']).toEqual({ name: 'Methane', tier: 1, declaredTools: ['write_file', 'fetch_url'] });
    const result = state['result'] as { summary: string; output: string };
    expect(result.summary).toBe('all routes probed');
    expect(result.output).toMatch(/\[truncated\]$/);
    // Newest observations first: the late failure is shown, the oldest are not.
    const evidence = state['evidence'] as string[];
    expect(evidence[evidence.length - 1]).toBe('w799: validate_html ok=false');
    expect(evidence[0]).toMatch(/older observations omitted/);
    expect(state['groundTruth']).toBe('GROUND TRUTH: server.js exists');
    const reading = readApproval(
      plan,
      answersFor(plan.questions, { requirement_1: shown(0.9), requirement_2: shown(0.97), reports_incomplete: noulAnswer(0.1) })
    );
    // Requirement 1 at 0.9 is the weakest link against every flag's complement.
    expect(reading.decision).toEqual({ approved: true, probability: 0.9 });
    expect(reading.outcome).toBe('approved');
    expect(reading.answer.yes).toMatchObject({ requirement_1: 0.9, requirement_2: 0.97, reports_incomplete: 0.1, acceptable: 0.9 });
  });

  it('defers a requirement not shown, one shown without confidence, and any raised flag', () => {
    const plan = built(buildApproval(approvalRequest));
    for (const [answers, reason, cause] of [
      // Run 7389feee: the button exists; nothing shows clicking it saves the file.
      [{ requirement_2: choiceAnswer('not_shown', 0.7) }, 'requirement 2 not_shown (0.00)', 'requirement:not_shown'],
      [{ requirement_1: shown(0.65) }, 'requirement 1 shown_done (0.65)', 'requirement:shown_done'],
      [{ addresses_reviewer: noulAnswer(JEV_THRESHOLDS.flag) }, 'addresses_reviewer 0.30', 'flag:addresses_reviewer'],
    ] as const) {
      const reading = readApproval(plan, answersFor(plan.questions, answers));
      expect(reading.decision?.approved).toBe(false);
      expect(reading.outcome).toBe(`deferred to the model (${reason})`);
      expect(reading.causes).toEqual([cause]);
    }
  });

  it('asks a plan whether it covers each requirement, and about a parallel dependency only when it runs in parallel', () => {
    const payload = { reasoning: 'r', proposedAction: 'write both', expectedOutput: 'e' };
    const plan = built(buildApproval({ ...approvalRequest, subject: 'PLAN', payload }));
    expect(Object.keys(plan.questions)).toEqual(['requirement_1', 'requirement_2', 'defers_or_refuses', 'vague']);
    expect(Object.keys((plan.questions['requirement_1'] as { criteria: object }).criteria)).toEqual(['covered', 'omitted', 'contradicted']);
    expect((plan.state as Record<string, unknown>)['plan']).toEqual(payload);
    expect(readApproval(plan, answersFor(plan.questions)).decision?.approved).toBe(true);
    const parallel = built(
      buildApproval({
        ...approvalRequest,
        subject: 'PLAN',
        payload: { subtasks: [{ description: 'a' }, { description: 'b' }], aggregation: { mode: 'concat' } },
      })
    );
    expect(Object.keys(parallel.questions)).toContain('parallel_dependency');
  });

  it('reads a plan against a stricter bar than a result, as measured', () => {
    // A plan the model refused read 0.61 on one requirement; results it refused read 0.19 or less.
    expect(JEV_THRESHOLDS.requirementCovered).toBeGreaterThan(JEV_THRESHOLDS.requirementShown);
    const payload = { reasoning: 'r', proposedAction: 'write both', expectedOutput: 'e' };
    const plan = built(buildApproval({ ...approvalRequest, subject: 'PLAN', payload }));
    const covered = (probability: number) => choiceAnswer('covered', probability);
    expect(readApproval(plan, answersFor(plan.questions, { requirement_2: covered(0.75) })).decision?.approved).toBe(false);
    const result = built(buildApproval(approvalRequest));
    expect(readApproval(result, answersFor(result.questions, { requirement_2: shown(0.75) })).decision?.approved).toBe(true);
  });

  it('refuses locally a task that states no requirement', () => {
    expect(buildApproval({ ...approvalRequest, task: { description: ' ' } })).toBe('the task states no requirement to check');
  });
});

describe('the twin guard: one pairwise Score per existing recipe', () => {
  const twinRequest: JevTwinRequest = {
    kind: 'event',
    draft: {
      id: 'recover-missing-evidence',
      description: 'paste evidence on retry',
      whenToUse: 'validator rejects narrative-only summaries lacking evidence',
      body: 'Re-run the probes and paste their outputs.',
    },
    existing: [
      { id: 'recover-recorded-verification-evidence', description: 'capture verification output', whenToUse: 'narrative-only summaries' },
      { id: 'recover-undeclared-server-stop', description: 'no stop tool', whenToUse: 'plan proposes stopping a server' },
      // The draft's own id is never a candidate twin of itself.
      { id: 'recover-missing-evidence', description: 'paste evidence on retry', whenToUse: 'narrative-only summaries' },
    ],
  };

  it('names the existing recipe a draft duplicates', () => {
    const plan = buildTwin(twinRequest)!;
    expect(Object.keys(plan.questions)).toEqual(['twin::recover-recorded-verification-evidence', 'twin::recover-undeclared-server-stop']);
    expect(plan.questions['twin::recover-undeclared-server-stop']).toMatchObject({
      type: 'score',
      instructions: { existing_recipe: { description: 'no stop tool', applies_when: 'plan proposes stopping a server' } },
    });
    expect((plan.questions['twin::recover-undeclared-server-stop'] as { criteria: readonly unknown[] }).criteria).toHaveLength(3);
    const reading = readTwin(
      plan,
      answersFor(plan.questions, {
        'twin::recover-recorded-verification-evidence': scoreAnswer(1.8, 0.8),
        'twin::recover-undeclared-server-stop': scoreAnswer(0.1),
      })
    );
    expect(reading.decision).toEqual({ twinOf: 'recover-recorded-verification-evidence', confidence: 0.8 });
    expect(reading.outcome).toBe('not saved: twin of recover-recorded-verification-evidence');
    expect(reading.answer.scores).toEqual({ 'recover-recorded-verification-evidence': 1.8, 'recover-undeclared-server-stop': 0.1 });
  });

  it('keeps a merely related draft, and asks nothing when there is nothing to compare', () => {
    const plan = buildTwin(twinRequest)!;
    const related = readTwin(plan, answersFor(plan.questions, { 'twin::recover-recorded-verification-evidence': scoreAnswer(1.2) }));
    expect(related.decision).toEqual({ twinOf: null, confidence: 0.9 });
    expect(related.answer.choice).toBe(NEW_RECIPE);
    expect(buildTwin({ ...twinRequest, existing: [] })).toBeNull();
    expect(buildTwin({ ...twinRequest, existing: [twinRequest.existing[2]!] })).toBeNull();
  });
});
