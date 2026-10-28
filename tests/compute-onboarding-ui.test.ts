// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComputeOnboarding } from '../src/viz/client-gl/ComputeOnboarding.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(payload: unknown, status = 200, hostedAllowed = false) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  render(createElement(ComputeOnboarding, { scopeKey: 'member:org', projectId: null, locale: 'fr', hostedAllowed, t: key => key }), { wrapper });
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
  const title = await screen.findByText('compute.onboarding.readyTitle');
  expect(screen.queryByRole('heading', { name: 'compute.onboarding.title' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'compute.connectComputer' })).not.toBeInTheDocument();
  fireEvent.click(title.closest('summary')!);
  expect(screen.getByText(/Office PC · compute.availability.disconnected/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'compute.connectAnother' })).toBeVisible();
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
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  client.clear();
});
it('drops the pairing prompt for an administrator whose computer is already connected', async () => {
  const client = setup({ hostedAllowed: true, devices: [{ deviceId: 'cfaec756-b83e-46fc-b787-2128f05ce7b8', name: 'Office PC', connected: true }] });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await vi.waitFor(() => expect(screen.queryByRole('link')).not.toBeInTheDocument());
  expect(screen.queryByText('compute.connectComputer')).not.toBeInTheDocument();
  client.clear();
});
it('offers another computer, not a first one, once a member has one connected', async () => {
  const client = setup({ hostedAllowed: false, devices: [{ deviceId: 'cfaec756-b83e-46fc-b787-2128f05ce7b8', name: 'Office PC', connected: true }] });
  const title = await screen.findByText('compute.onboarding.readyTitle');
  fireEvent.click(title.closest('summary')!);
  expect(screen.getByRole('link', { name: 'compute.connectAnother' })).toHaveAttribute('href', '/compute/setup?lang=fr');
  expect(screen.queryByRole('link', { name: 'compute.connectComputer' })).not.toBeInTheDocument();
  client.clear();
});

it('never asks an administrator to pair again when their computer is offline', async () => {
  const client = setup({ hostedAllowed: true, devices: [{ deviceId: 'cfaec756-b83e-46fc-b787-2128f05ce7b8', name: 'Office PC', connected: false }] });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  client.clear();
});
it('uses the authenticated administrator capability without loading or flashing setup', () => {
  const client = setup({}, 503, true);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  client.clear();
});
