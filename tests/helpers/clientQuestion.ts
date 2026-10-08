import type { ClientQuestion, ClientQuestionView } from '../../src/contracts/clientQuestion.js';
export function clientQuestionFixture(): ClientQuestion {
  return { question: 'Keep local login alongside Google login?', whyClient: 'This changes which customers can sign in.',
    missingDecision: 'The request asks for Google login but does not decide the future of existing local accounts.',
    options: [{ id: 'keep_both', label: 'Keep both login methods', consequence: 'Existing local accounts keep working.' },
      { id: 'google_only', label: 'Use Google only', consequence: 'Existing local users need a migration.' }] };
}

export function clientQuestionViewFixture(): ClientQuestionView {
  return { projectId: 'p', runId: 'r', question: null, waitingForClient: false,
    canAnswer: false, canResume: false, nextAction: 'none', continuation: null };
}
