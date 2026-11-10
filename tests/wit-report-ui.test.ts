// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WitAccessible } from '../src/viz/client-gl/WitAccessible.js';
import { visibleViews, isRoutableView } from '../src/viz/client-gl/store.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { WitReport } from '../src/contracts/witReport.js';
afterEach(cleanup);
const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
it('reserves reporting navigation for platform administrators', () => {
  expect(visibleViews({ viewer: { platformAdmin: true } })).toContain('wit');
  for (const auth of [null, { viewer: { platformAdmin: false } }]) {
    expect(visibleViews(auth)).not.toContain('wit'); expect(isRoutableView('wit', auth)).toBe(false);
  }
});
it('exposes coverage, escaped evidence and keyboard controls', () => {
  const onActivate = vi.fn();
  const report: WitReport = { generatedAt: '2026-11-10T00:00:00Z', runsScanned: 10, totalRuns: 30,
    unreadableRuns: 1, omittedEvents: 20, nextBefore: 'older', receipts: [{
      runId: 'r', projectId: null, runLabel: 'Report', eventId: 'e', at: 1, actor: null,
      mode: 'check', command: 'wit check report.md', status: 'unknown', exitCode: null, durationMs: 0,
      output: '<script>alert(1)</script>', outputTruncated: true,
    }] };
  const { container } = render(createElement(WitAccessible, { report, locale: 'en', t, onActivate }));
  expect(screen.getByRole('status')).toHaveTextContent('1 unreadable runs, 20 omitted events');
  expect(screen.getByText('<script>alert(1)</script>')).toBeVisible(); expect(container.querySelector('script')).toBeNull();
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Outcome unknown');
  fireEvent.click(screen.getByRole('button', { name: 'Open source run' })); expect(onActivate).toHaveBeenLastCalledWith('wit.open.0');
  fireEvent.click(screen.getByRole('button', { name: 'Scan older runs' })); expect(onActivate).toHaveBeenLastCalledWith('wit.next');
});

it('announces initial loading and cached refresh without discarding results', () => {
  const onActivate = vi.fn();
  const report: WitReport = { generatedAt: '2026-11-10T00:00:00Z', runsScanned: 10, totalRuns: 20,
    unreadableRuns: 0, omittedEvents: 0, nextBefore: 'older', receipts: [] };
  const { rerender } = render(createElement(WitAccessible, { report: null, fetching: true, locale: 'en', t, onActivate }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading Wit results');
  rerender(createElement(WitAccessible, { report, fetching: true, locale: 'en', t, onActivate }));
  expect(screen.getByText('This page: 10 runs out of 20 indexed runs')).toBeVisible();
  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Latest runs / refresh' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Scan older runs' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Latest runs / refresh' }));
  expect(onActivate).not.toHaveBeenCalled();
  rerender(createElement(WitAccessible, { report, fetching: false, locale: 'en', t, onActivate }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Latest runs / refresh' })).toBeEnabled();
});
