import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunParentTests, RunReview } from '../src/contracts/clientExperience.js';
import { AssistantRunResult, outcomeKey } from '../src/viz/client-gl/AssistantRunResult.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { DeploymentSettingsView } from '../src/viz/client-gl/project-deployment.js';

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

function card(tests: RunParentTests, options: { hosting?: { view: DeploymentSettingsView; onActivate: (id: string) => void }; review?: RunReview; title?: string } = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['viz', 'run-review', 'scope', target.projectId, target.runId], options.review ?? review(tests));
  const run = { ...target, status: 'delivered', traceId: 'trace-1', costUsd: 0.25, error: null, endedAt: null, ...(options.title ? { title: options.title } : {}) };
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(AssistantRunResult, { scopeKey: 'scope', target, run, locale: 'en', t, onRun: () => {}, hosting: options.hosting ?? null })));
}

describe('the card headline follows the delivery state (2026-10-26)', () => {
  const accepted = { manifestHash: 'h', review: 'Ok', principalId: 'p', acceptedAt: '2026-10-26T10:22:14.146Z' };
  it('asks to be looked at only while the delivery awaits acceptance', () => {
    expect(outcomeKey('delivered', { clientAcceptance: null, publicationStatus: null }, true)).toBe('assistant.outcome.delivered');
    expect(outcomeKey('delivered', { clientAcceptance: accepted, publicationStatus: 'published' }, false)).toBe('assistant.outcome.deliveredAccepted');
    expect(outcomeKey('delivered', { clientAcceptance: accepted, publicationStatus: 'failed' }, false)).toBe('assistant.outcome.deliveredAccepted');
    expect(outcomeKey('delivered', { clientAcceptance: null, publicationStatus: null }, false)).toBe('assistant.outcome.deliveredSettled');
    expect(outcomeKey('delivered', undefined, undefined)).toBe('assistant.outcome.deliveredSettled');
    expect(outcomeKey('partial', undefined, undefined)).toBe('assistant.outcome.partial');
  });
  it('no longer asks to accept an accepted and published result', () => {
    const html = card(parentTests(), { review: { ...review(parentTests()), clientAcceptance: accepted, publicationStatus: 'published' } });
    expect(html).toContain(t('assistant.outcome.deliveredAccepted'));
    expect(html).not.toContain(t('assistant.outcome.delivered'));
    expect(html).toContain(t('assistant.deliveryPublished'));
  });
  it('names the version it accepted as its deployment line does, so the two read as one', () => {
    const html = card(parentTests(), { title: 'Repair the control page', review: { ...review(parentTests()), clientAcceptance: accepted, publicationStatus: 'published' } });
    expect(html).toContain('<p><strong>Repair the control page</strong></p>');
    expect(html.indexOf('Repair the control page')).toBeLessThan(html.indexOf(t('assistant.outcome.deliveredAccepted')));
    expect(t('assistant.deployment.replace.done', { title: 'Repair the control page' })).toContain('Repair the control page');
    // Untitled: the outcome stays the card's headline.
    expect(card(parentTests())).toContain(`<strong>${t('assistant.outcome.deliveredSettled')}</strong>`);
  });
  it('says "accepted" once: the headline, never a second sentence', () => {
    const text = card(parentTests(), { review: { ...review(parentTests()), clientAcceptance: accepted } });
    expect(text).toContain(t('assistant.outcome.deliveredAccepted'));
    expect(text).not.toContain(t('assistant.deliveryAccepted'));
    const pending = card(parentTests(), { review: { ...review(parentTests()), delivery: 'files',
      files: { projectId: target.projectId, runId: target.runId, status: 'delivered', files: [{ path: 'index.html', size: 10 }], total: 1, nextOffset: null },
      clientAcceptance: accepted, publicationStatus: 'failed' } });
    expect(pending).toContain(t('assistant.deliveryAcceptedPending'));
    expect(t('assistant.deliveryAcceptedPending')).not.toMatch(/accepted/i);
    expect(t('assistant.deliveryPublished')).not.toMatch(/accepted/i);
  });
});

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

/**
 * Right after a delivery is accepted and published, the card says what to do
 * with the online application (owner decision 2026-10-25): an explicit
 * update, never automatic, and only for this run's accepted version.
 */
describe('the run card offers the hosted application update', () => {
  const a = 'a'.repeat(40); const b = 'b'.repeat(40);
  const online = (overrides: Partial<NonNullable<DeploymentSettingsView['hosting']>> = {}): NonNullable<DeploymentSettingsView['hosting']> => ({
    available: true, state: 'ready', deploymentId: 'deployment-1', runId: 'run-0', commitSha: a,
    url: 'https://attica.app.atoma.run/', error: null, address: 'https://attica.app.atoma.run/',
    version: { runId: 'run-0', commitSha: a, title: 'First control page', acceptedAt: '2026-10-24T09:00:00.000Z' },
    candidate: { runId: target.runId, commitSha: b, manifestHash: 'f'.repeat(64), title: 'Finish Attica control page repair', acceptedAt: '2026-10-25T09:00:00.000Z' },
    previous: null, updateStops: true, failed: null, ...overrides });
  const view = (hosting: DeploymentSettingsView['hosting'], overrides: Partial<DeploymentSettingsView> = {}): DeploymentSettingsView =>
    ({ projectId: target.projectId, hosting, destination: 'atoma', saved: 'atoma', canEdit: true, busy: false, status: 'idle', ...overrides });
  const published = { ...review(parentTests()), publicationStatus: 'published' as const };
  const button = (key: string) => `${t(key)}</button>`;

  it('offers the update when the online application still runs the previous version', () => {
    const html = card(parentTests(), { hosting: { view: view(online()), onActivate: () => {} }, review: published });
    expect(html).toContain(t('assistant.deliveryPublished'));
    expect(html).toContain(t('hosting.offer.outdated'));
    expect(html).toContain(button('hosting.update'));
    expect(html).not.toContain(t('hosting.confirm.update'));
  });

  it('shows the plain confirmation in place of the button once asked', () => {
    const html = card(parentTests(), { hosting: { view: view(online(), { confirming: { action: 'update', runId: target.runId, deploymentId: 'deployment-1' } }), onActivate: () => {} }, review: published });
    expect(html).toContain(t('hosting.confirm.update'));
    expect(html).toContain(button('hosting.confirm'));
    expect(html).toContain(button('hosting.cancel'));
    expect(html).not.toContain(button('hosting.update'));
  });

  it('offers the first deployment when nothing is online yet', () => {
    const html = card(parentTests(), { hosting: { view: view(online({ state: 'not-deployed', deploymentId: null, runId: null, commitSha: null,
      url: null, version: null, updateStops: false })), onActivate: () => {} }, review: published });
    expect(html).toContain(t('hosting.offer.notOnline'));
    expect(html).toContain(button('hosting.deploy'));
  });

  it('tells someone without the right role whom to ask, with no button', () => {
    const html = card(parentTests(), { hosting: { view: view(online(), { canEdit: false }), onActivate: () => {} }, review: published });
    expect(html).toContain(t('hosting.offer.outdated'));
    expect(html).toContain(t('hosting.offer.askAdmin'));
    expect(html).not.toContain(button('hosting.update'));
  });

  it('still explains, after a reload, that this run\'s version did not start', () => {
    // No action from this tab: the status alone says the newest deployment, this run's version, failed.
    const beside = card(parentTests(), { hosting: { view: view(online({ state: 'failed', error: 'startup-failed', updateStops: false, failed: { runId: target.runId } })),
      onActivate: () => {} }, review: published });
    expect(beside).toContain(t('hosting.outcome.failedOnline'));
    expect(beside).toContain(button('hosting.retry'));
    const offline = card(parentTests(), { hosting: { view: view(online({ state: 'failed', error: 'startup-failed', url: null, failed: { runId: target.runId },
      runId: target.runId, commitSha: b, version: online().candidate })), onActivate: () => {} }, review: published });
    expect(offline).toContain(t('hosting.outcome.failed'));
    expect(offline).toContain(button('hosting.retry'));
  });

  it('offers it only where it applies', () => {
    // The applicable case first, so the quiet ones below prove a decision, not an absent feature.
    expect(card(parentTests(), { hosting: { view: view(online()), onActivate: () => {} }, review: published })).toContain(t('hosting.offer.outdated'));
    const quiet = [
      view(online({ candidate: { ...online().candidate!, commitSha: a } })), // already online
      view(online({ candidate: { ...online().candidate!, runId: 'run-2' } })), // a newer run is the accepted version
      view(online(), { saved: 'none', destination: 'none' }), // not hosted on Atoma
      view(online(), { projectId: 'project-2' }), // another project's application
      view(online({ state: 'stopped', url: null, updateStops: false })), // stopped on purpose
      view(null), // hosting unavailable
    ];
    for (const settings of quiet) {
      const html = card(parentTests(), { hosting: { view: settings, onActivate: () => {} }, review: published });
      expect(html).not.toContain(t('hosting.offer.outdated'));
      expect(html).not.toContain(t('hosting.offer.notOnline'));
      expect(html).not.toContain(button('hosting.update'));
      expect(html).not.toContain(button('hosting.deploy'));
    }
  });
});
