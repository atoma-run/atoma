// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { UpstreamSetting } from '../src/viz/client-gl/UpstreamSetting.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps the saved value after a refused update and names the failure', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 403 }));
  vi.stubGlobal('fetch', fetch);
  render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(UpstreamSetting,
    { projectId: 'p1', enabled: false, t: (key: string) => key })));
  await userEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('projects.followUpstreamFailed'));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(fetch).toHaveBeenCalledWith('/api/projects/p1/upstream', expect.objectContaining({ method: 'PUT', body: '{"followUpstream":true}' }));
});
