// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComputeOnboarding } from '../src/viz/client-gl/ComputeOnboarding.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(payload: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(ComputeOnboarding, { scopeKey: 'member:org', projectId: null, locale: 'fr', t: key => key }), { wrapper });
  return client;
}
it('offers pairing before a first project exists without promising hosted fallback', async () => {
  const client = setup({ hostedAllowed: false, devices: [] });
  expect(await screen.findByRole('heading', { name: 'compute.onboarding.title' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'compute.connectComputer' })).toHaveAttribute('href', '/compute/setup?lang=fr');
  expect(screen.queryByText('compute.hosted')).not.toBeInTheDocument();
  client.clear();
});
it('shows an offline paired machine as disconnected and still explains project authorization', async () => {
  const client = setup({ hostedAllowed: false, devices: [{ deviceId: 'cfaec756-b83e-46fc-b787-2128f05ce7b8', name: 'Office PC', connected: false }] });
  expect(await screen.findByText(/Office PC · compute.availability.disconnected/)).toBeInTheDocument();
  expect(screen.getByText('compute.onboarding.selectProject')).toBeInTheDocument();
  client.clear();
});
it('keeps an actionable setup error when inventory cannot be read', async () => {
  const client = setup({}, 503);
  expect(await screen.findByRole('alert')).toHaveTextContent('compute.loadFailed');
  expect(screen.getByRole('button', { name: 'compute.refresh' })).toBeInTheDocument();
  client.clear();
});
it('does not require pairing for platform administrators', async () => {
  const client = setup({ hostedAllowed: true, devices: [] });
  await screen.findByRole('link', { name: 'compute.connectComputer' });
  await vi.waitFor(() => expect(screen.queryByRole('heading')).not.toBeInTheDocument());
  client.clear();
});
