import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunParentTests, RunReview } from '../src/contracts/clientExperience.js';
import { AssistantRunResult } from '../src/viz/client-gl/AssistantRunResult.js';
import { translate } from '../src/viz/client/i18n-catalog.js';

/**
 * The receipt card is where a person decides to accept a delivery (G6,
 * 2026-10-16). A suite that failed or did not run, a record nobody could
 * read, or a trace that could not be read must say so there; an all-passed
 * record set adds nothing.
 */

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const target = { projectId: 'project-1', runId: 'run-1' };

function parentTests(overrides: Partial<RunParentTests> = {}): RunParentTests {
  return {
    state: 'recorded',
    note: 'note',
    suites: { total: 2, passed: 2, failed: 0, unavailable: 0 },
    records: { total: 2, invalid: 0, distinct: 2, listed: 2, omitted: 0, supersededFailures: 0 },
    observations: [],
    ...overrides,
  };
}

function review(tests: RunParentTests): RunReview {
  return {
    run: { projectId: target.projectId, projectRunId: target.runId, goal: 'Refunds', status: 'delivered',
      artifactManifestHash: null },
    acceptedReferenceRunId: null,
    delivery: 'text',
    files: null,
    filesState: 'not_delivered',
    comparison: null,
    comparisonState: 'text_only',
    verification: { stage: 'finished', message: 'Run delivered.', source: 'trace', evidence: 'available',
      lastActivityAt: null, criteria: [], criteriaTruncated: false, acceptanceApproved: true },
    parentTests: tests,
    clientAcceptance: null,
    publicationStatus: null,
    canRequestAcceptance: false,
    canRetryPublication: false,
    untrusted: true,
    bytes: 'not-revalidated',
    nextSteps: [],
    note: 'note',
  };
}

function card(tests: RunParentTests): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['viz', 'run-review', 'scope', target.projectId, target.runId], review(tests));
  const run = { ...target, status: 'delivered', traceId: 'trace-1', costUsd: 0.25, error: null };
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(AssistantRunResult, { scopeKey: 'scope', target, run, t, onRun: () => {} })));
}

describe('the receipt card at the acceptance moment', () => {
  it('says that a suite did not run', () => {
    const html = card(parentTests({ suites: { total: 2, passed: 1, failed: 0, unavailable: 1 } }));
    expect(html).toContain(t('result.tests.suitesUnavailable', { count: 1 }));
    expect(html).toContain(t('assistant.checksApproved'));
  });

  it('says that a record could not be read even when every read suite passed', () => {
    const html = card(parentTests({ records: { total: 3, invalid: 1, distinct: 2, listed: 2, omitted: 0, supersededFailures: 0 } }));
    expect(html).toContain(t('result.tests.unreadable', { count: 1 }));
  });

  it('says that the records could not be read at all', () => {
    const html = card(parentTests({ state: 'unavailable', suites: { total: 0, passed: 0, failed: 0, unavailable: 0 } }));
    expect(html).toContain(t('result.tests.recordsUnavailable'));
  });

  it('adds nothing when every suite passed', () => {
    const html = card(parentTests());
    expect(html).not.toContain(t('result.tests.suitesPassed', { count: 2 }));
    expect(html).not.toContain(t('result.tests.recordsUnavailable'));
  });
});
