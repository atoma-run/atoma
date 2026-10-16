// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServersPanel, connectorKeyFromName } from '../src/viz/client-gl/McpServersPanel.js';
import { ProjectSettingsAccessible } from '../src/viz/client-gl/ProjectSettingsAccessible.js';
import { connectorsCopy, type ConnectorSettingsView } from '../src/viz/client-gl/project-connectors.js';
import { buttonIconKind } from '../src/viz/client-gl/button-icons.js';
import { api } from '../src/viz/client/data-api.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { ConnectorView } from '../src/contracts/mcpConnectors.js';

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SERVER: ConnectorView = {
  id: '7f1c3a52-9d1e-4a55-8a4b-1f2e3d4c5b6a', key: 'notes', name: 'Notes', host: 'notes.example', url: 'https://notes.example/mcp',
  authKind: 'header', headerName: 'Authorization', hasHeaderSecret: true, hasOauthClientSecret: false, oauthConnected: false,
  status: 'ready', tools: [{ name: 'search', readOnly: true }, { name: 'delete_note', destructive: true }],
  toolsRefreshedAt: '2026-10-16T08:00:00.000Z', toolsError: null, disabledTools: [], revision: 3,
  createdAt: '2026-10-16T08:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z',
};

function panel() {
  const onError = vi.fn();
  render(createElement(McpServersPanel, { t, locale: 'en', enabled: true, onError }));
  return onError;
}

describe('Settings → Your MCP servers', () => {
  it('proposes a run identifier from the name', () => {
    expect(connectorKeyFromName('Linear (prod)')).toBe('linear-prod');
    expect(connectorKeyFromName('42 Notes')).toBe('mcp-42-notes');
    expect(connectorKeyFromName('!')).toBe('');
  });

  it('shows a member the servers and their tools, with no way to change them', async () => {
    vi.spyOn(api, 'mcpServers').mockResolvedValue({ servers: [{ ...SERVER, url: undefined, headerName: undefined }], encryptionReady: true, canManage: false });
    panel();
    expect(await screen.findByText(/Only an organisation owner or admin/)).toBeInTheDocument();
    expect(screen.getByText(/notes\.example/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add an MCP server/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByRole('group', { name: 'Tools a run may call' })).toBeDisabled();
  });

  it('adds a header server with the derived identifier and never echoes the secret', async () => {
    vi.spyOn(api, 'mcpServers').mockResolvedValue({ servers: [], encryptionReady: true, canManage: true });
    const create = vi.spyOn(api, 'createMcpServer').mockResolvedValue({ server: SERVER });
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByRole('button', { name: /Add an MCP server/ }));
    const form = screen.getByRole('form', { name: 'Add an MCP server' });
    await user.type(within(form).getByLabelText('Name'), 'Notes App');
    expect(within(form).getByLabelText('Identifier')).toHaveValue('notes-app');
    await user.type(within(form).getByLabelText('Server URL'), 'https://notes.example/mcp');
    await user.click(within(form).getByLabelText('Secret header'));
    const submit = within(form).getByRole('button', { name: /Add server/ });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText('Header value'), 'Bearer s3cret');
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      key: 'notes-app', name: 'Notes App', url: 'https://notes.example/mcp', authKind: 'header',
      headerName: 'Authorization', headerValue: 'Bearer s3cret',
    }));
  });

  it('switches a tool off with the revision it was shown', async () => {
    vi.spyOn(api, 'mcpServers').mockResolvedValue({ servers: [SERVER], encryptionReady: true, canManage: true });
    const update = vi.spyOn(api, 'updateMcpServer').mockResolvedValue({ server: { ...SERVER, disabledTools: ['delete_note'] } });
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByText('Tools: 2 of 2 enabled'));
    await user.click(screen.getByRole('checkbox', { name: /delete_note/ }));
    await user.click(screen.getByRole('button', { name: /Save tools/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(SERVER.id, { expectedRevision: 3, disabledTools: ['delete_note'] }));
  });
});

describe('Project settings → MCP servers', () => {
  const view: ConnectorSettingsView = {
    loading: false, loadFailed: false, canEdit: true, busy: false, status: 'idle', saved: [], selected: [SERVER.id],
    servers: [
      { id: SERVER.id, key: 'notes', name: 'Notes', host: 'notes.example', status: 'ready', enabledTools: 1, totalTools: 2 },
      { id: 'b', key: 'crm', name: 'CRM', host: 'crm.example', status: 'authorization_required', enabledTools: 0, totalTools: 0 },
    ],
  };

  it('is one choice model for both renderers, and saves only a change', () => {
    const copy = connectorsCopy(view);
    expect(copy.rows.map(row => [row.name, row.checked])).toEqual([['Notes', true], ['CRM', false]]);
    expect(copy.showSave).toBe(true);
    expect(copy.saveDisabled).toBe(false);
    expect(connectorsCopy({ ...view, selected: [] }).saveDisabled).toBe(true);
    expect(connectorsCopy({ ...view, canEdit: false }).rows.every(row => row.disabled)).toBe(true);
    expect(connectorsCopy({ ...view, servers: [] }).empty).toBe('connectors.empty');
    expect(buttonIconKind('connectors.save')).toBe('check');
  });

  it('renders the accessible twin as checkboxes that activate the same ids', async () => {
    const onActivate = vi.fn();
    const user = userEvent.setup();
    render(createElement(ProjectSettingsAccessible, {
      view: { destination: 'none', saved: 'none', canEdit: true, busy: false, status: 'idle' }, t, onActivate, connectors: view,
    }));
    const section = screen.getByRole('region', { name: 'MCP servers' });
    expect(within(section).getByText(/runs cannot use it until it is fixed/)).toBeInTheDocument();
    await user.click(within(section).getByRole('checkbox', { name: 'CRM' }));
    expect(onActivate).toHaveBeenCalledWith('connectors.toggle.b');
    await user.click(within(section).getByRole('button', { name: /Save MCP servers/ }));
    expect(onActivate).toHaveBeenCalledWith('connectors.save');
  });
});
