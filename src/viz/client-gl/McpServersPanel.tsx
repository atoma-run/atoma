import { useCallback, useEffect, useState } from 'react';
import { ButtonIcon } from './ButtonIcon.js';
import { api, type VizMcpServers } from '../client/data-api.js';
import { formatDateTime } from '../client/date-format.js';
import type { ConnectorAuthKind, ConnectorView } from '../../contracts/mcpConnectors.js';

/**
 * SETTINGS → YOUR MCP SERVERS (src/connectors). An organisation connects its
 * own MCP servers here; Project settings chooses which a project's runs may
 * use. Secrets are write-only: the server never sends one back, so an empty
 * secret field on an edit means "keep the stored one".
 *
 * Owners and admins manage; every other member reads names, hosts, status
 * and tools, never a URL's path (it may itself be a credential).
 */

type Translate = (key: string, vars?: Record<string, unknown>) => string;

interface Draft {
  name: string;
  key: string;
  keyEdited: boolean;
  url: string;
  authKind: ConnectorAuthKind;
  headerName: string;
  headerValue: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
}

const EMPTY_DRAFT: Draft = {
  name: '', key: '', keyEdited: false, url: '', authKind: 'none', headerName: 'Authorization', headerValue: '',
  oauthClientId: '', oauthClientSecret: '', oauthScope: '',
};

/** The identifier a run names the server by, proposed from its name. */
export function connectorKeyFromName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!slug) return '';
  const lettered = /^[a-z]/.test(slug) ? slug : `mcp-${slug}`.slice(0, 32);
  return lettered.replace(/-+$/, '').length >= 2 ? lettered.replace(/-+$/, '') : '';
}

/** Read and clear the OAuth return marker (`?mcpServer=connected|error:<text>`). */
function takeReturnNotice(): { ok: boolean; message: string } | null {
  try {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('mcpServer');
    if (value === null) return null;
    url.searchParams.delete('mcpServer');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return value === 'connected' ? { ok: true, message: '' } : { ok: false, message: value.replace(/^error:/, '') };
  } catch { return null; }
}

export function McpServersPanel({ t, locale, enabled, onError }: {
  t: Translate; locale: string; enabled: boolean; onError: (message: string | null) => void;
}) {
  const [data, setData] = useState<VizMcpServers | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [toolDrafts, setToolDrafts] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const refresh = useCallback(async () => {
    try { setData(await api.mcpServers()); }
    catch (error) { onError(error instanceof Error ? error.message : t('settings.actionFailed')); }
  }, [onError, t]);

  useEffect(() => { setNotice(takeReturnNotice()); }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  const run = async (work: () => Promise<unknown>, successKey: string | null): Promise<boolean> => {
    setBusy(true); setStatus(null); onError(null);
    try {
      await work();
      await refresh();
      if (successKey) setStatus(t(successKey));
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
      return false;
    } finally { setBusy(false); }
  };

  /** Leaves Atoma for the server's own consent page; it comes back to this tab. */
  const authorize = async (id: string): Promise<void> => {
    setBusy(true); onError(null);
    try {
      const { authorizationUrl } = await api.authorizeMcpServer(id);
      window.location.assign(authorizationUrl);
    } catch (error) {
      onError(error instanceof Error ? error.message : t('settings.actionFailed'));
      setBusy(false);
    }
  };

  if (!enabled || !data) return null;
  const manage = data.canManage;

  const add = async (): Promise<void> => {
    let created: ConnectorView | null = null;
    const ok = await run(async () => {
      created = (await api.createMcpServer({
        key: draft.key, name: draft.name.trim(), url: draft.url.trim(), authKind: draft.authKind,
        ...(draft.authKind === 'header' ? { headerName: draft.headerName.trim() || 'Authorization', headerValue: draft.headerValue.trim() } : {}),
        ...(draft.authKind === 'oauth' && draft.oauthClientId.trim() ? { oauthClientId: draft.oauthClientId.trim() } : {}),
        ...(draft.authKind === 'oauth' && draft.oauthClientSecret.trim() ? { oauthClientSecret: draft.oauthClientSecret.trim() } : {}),
        ...(draft.authKind === 'oauth' && draft.oauthScope.trim() ? { oauthScope: draft.oauthScope.trim() } : {}),
      })).server;
    }, 'settings.mcpServers.added');
    if (!ok || !created) return;
    setDraft(EMPTY_DRAFT); setAdding(false);
    // An OAuth server is only useful once authorized: go there now.
    if ((created as ConnectorView).authKind === 'oauth') await authorize((created as ConnectorView).id);
  };

  const startEdit = (server: ConnectorView): void => {
    setEditing(server.id);
    setEditDraft({ ...EMPTY_DRAFT, name: server.name, key: server.key, keyEdited: true, url: server.url ?? '', authKind: server.authKind,
      headerName: server.headerName ?? 'Authorization', oauthClientId: server.oauthClientId ?? '', oauthScope: server.oauthScope ?? '' });
  };

  const saveEdit = async (server: ConnectorView): Promise<void> => {
    const ok = await run(() => api.updateMcpServer(server.id, {
      expectedRevision: server.revision,
      name: editDraft.name.trim(),
      url: editDraft.url.trim(),
      authKind: editDraft.authKind,
      ...(editDraft.authKind === 'header' ? { headerName: editDraft.headerName.trim() || 'Authorization' } : {}),
      ...(editDraft.authKind === 'header' && editDraft.headerValue.trim() ? { headerValue: editDraft.headerValue.trim() } : {}),
      ...(editDraft.authKind === 'oauth' ? { oauthClientId: editDraft.oauthClientId.trim(), oauthScope: editDraft.oauthScope.trim() } : {}),
      ...(editDraft.authKind === 'oauth' && editDraft.oauthClientSecret.trim() ? { oauthClientSecret: editDraft.oauthClientSecret.trim() } : {}),
    }), 'settings.mcpServers.saved');
    if (ok) setEditing(null);
  };

  const saveTools = async (server: ConnectorView, disabled: string[]): Promise<void> => {
    const ok = await run(() => api.updateMcpServer(server.id, { expectedRevision: server.revision, disabledTools: disabled }), 'settings.mcpServers.toolsSaved');
    if (ok) setToolDrafts(previous => { const next = { ...previous }; delete next[server.id]; return next; });
  };

  return (
    <div className="gpu-mcp-servers">
      <p className="gpu-org-models-title">{t('settings.mcpServers.title')}</p>
      <p className="gpu-org-models-hint">{t('settings.mcpServers.intro')}</p>
      {!manage ? <p className="gpu-org-models-hint" role="note">{t('settings.mcpServers.readOnly')}</p> : null}
      {manage && !data.encryptionReady ? <p className="gpu-org-models-hint" role="note">{t('settings.mcpServers.encryptionUnavailable')}</p> : null}
      {notice ? (
        <p className="gpu-org-models-hint" role={notice.ok ? 'status' : 'alert'}>
          {notice.ok ? t('settings.mcpServers.authorized') : t('settings.mcpServers.authorizationFailed', { reason: notice.message })}
        </p>
      ) : null}
      {status ? <p role="status" className="gpu-org-models-status">{status}</p> : null}

      {data.servers.length === 0 ? <p className="gpu-org-models-hint">{t('settings.mcpServers.empty')}</p> : null}
      <ul className="gpu-mcp-server-list">
        {data.servers.map(server => {
          const disabledDraft = toolDrafts[server.id] ?? server.disabledTools;
          const toolsChanged = [...disabledDraft].sort().join('\n') !== [...server.disabledTools].sort().join('\n');
          const enabledCount = server.tools.filter(tool => !disabledDraft.includes(tool.name)).length;
          return (
            <li key={server.id} className="gpu-mcp-server">
              <p className="gpu-mcp-server-name">{server.name} <code>{server.key}</code></p>
              <p className="gpu-org-models-hint">
                {server.host} · {t(`settings.mcpServers.auth.${server.authKind}`)} · <span role="status">{t(`settings.mcpServers.status.${server.status}`)}</span>
              </p>
              {server.toolsError ? <p className="gpu-org-models-hint" role="alert">{server.toolsError}</p> : null}
              {server.tools.length > 0 ? (
                <details>
                  <summary>{t('settings.mcpServers.toolsSummary', { enabled: enabledCount, total: server.tools.length })}</summary>
                  <fieldset disabled={!manage || busy} className="gpu-mcp-server-tools">
                    <legend>{t('settings.mcpServers.toolsLegend')}</legend>
                    {server.tools.map(tool => (
                      <label key={tool.name} title={tool.description}>
                        <input type="checkbox" checked={!disabledDraft.includes(tool.name)}
                          onChange={event => setToolDrafts(previous => ({ ...previous, [server.id]: event.target.checked
                            ? disabledDraft.filter(name => name !== tool.name)
                            : [...disabledDraft, tool.name] }))} />
                        <code>{tool.name}</code>
                        {tool.readOnly === true ? ` · ${t('settings.mcpServers.readOnlyTool')}` : ''}
                        {tool.destructive === true ? ` · ${t('settings.mcpServers.destructiveTool')}` : ''}
                      </label>
                    ))}
                  </fieldset>
                  {manage && toolsChanged ? (
                    <div className="gpu-settings-actions">
                      <button type="button" disabled={busy} onClick={() => { void saveTools(server, disabledDraft); }}>
                        <ButtonIcon kind="check" />{t('settings.mcpServers.saveTools')}
                      </button>
                    </div>
                  ) : null}
                </details>
              ) : null}
              {server.toolsRefreshedAt ? (
                <p className="gpu-org-models-hint">{t('settings.mcpServers.refreshedAt', { date: formatDateTime(server.toolsRefreshedAt, locale) })}</p>
              ) : null}
              {manage ? (
                <div className="gpu-settings-actions">
                  {server.authKind === 'oauth' ? (
                    <button type="button" disabled={busy || !data.encryptionReady} onClick={() => { void authorize(server.id); }}>
                      <ButtonIcon kind="link" />{t(server.oauthConnected ? 'settings.mcpServers.reconnect' : 'settings.mcpServers.connect')}
                    </button>
                  ) : null}
                  <button type="button" disabled={busy} onClick={() => { void run(() => api.refreshMcpServer(server.id), 'settings.mcpServers.refreshed'); }}>
                    <ButtonIcon kind="refresh" />{t('settings.mcpServers.refresh')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => startEdit(server)}>
                    <ButtonIcon kind="edit" />{t('settings.mcpServers.edit')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => {
                    if (window.confirm(t('settings.mcpServers.removeConfirm', { name: server.name }))) {
                      void run(() => api.removeMcpServer(server.id), 'settings.mcpServers.removed');
                    }
                  }}>
                    <ButtonIcon kind="trash" />{t('settings.mcpServers.remove')}
                  </button>
                </div>
              ) : null}
              {editing === server.id ? (
                <ServerForm t={t} draft={editDraft} onChange={setEditDraft} busy={busy} encryptionReady={data.encryptionReady}
                  editing={server} onSubmit={() => { void saveEdit(server); }} onCancel={() => setEditing(null)} />
              ) : null}
            </li>
          );
        })}
      </ul>

      {manage && !adding ? (
        <div className="gpu-settings-actions">
          <button type="button" disabled={busy} onClick={() => { setDraft(EMPTY_DRAFT); setAdding(true); }}>
            <ButtonIcon kind="plus" />{t('settings.mcpServers.add')}
          </button>
        </div>
      ) : null}
      {manage && adding ? (
        <ServerForm t={t} draft={draft} onChange={setDraft} busy={busy} encryptionReady={data.encryptionReady}
          onSubmit={() => { void add(); }} onCancel={() => setAdding(false)} />
      ) : null}
    </div>
  );
}

function ServerForm({ t, draft, onChange, busy, encryptionReady, editing, onSubmit, onCancel }: {
  t: Translate; draft: Draft; onChange: (draft: Draft) => void; busy: boolean; encryptionReady: boolean;
  editing?: ConnectorView; onSubmit: () => void; onCancel: () => void;
}) {
  const id = editing ? `mcp-edit-${editing.id}` : 'mcp-new';
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const needsSecret = draft.authKind === 'header' && !(editing?.authKind === 'header' && editing.hasHeaderSecret);
  const secretBlocked = !encryptionReady && (draft.authKind !== 'none');
  const incomplete = !draft.name.trim() || !draft.url.trim() || draft.key.length < 2 || (needsSecret && !draft.headerValue.trim());
  const secretInput = { autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
    'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-form-type': 'other' } as const;
  return (
    <form className="gpu-mcp-server-form" autoComplete="off" aria-label={t(editing ? 'settings.mcpServers.editTitle' : 'settings.mcpServers.addTitle')}
      onSubmit={event => { event.preventDefault(); if (!incomplete && !busy) onSubmit(); }}>
      <div className="gpu-org-models-row">
        <label htmlFor={`${id}-name`}>{t('settings.mcpServers.name')}</label>
        <input id={`${id}-name`} className="gpu-dom-input" type="text" maxLength={60} value={draft.name} disabled={busy}
          onChange={event => set({ name: event.target.value, ...(!draft.keyEdited && !editing ? { key: connectorKeyFromName(event.target.value) } : {}) })} />
      </div>
      <div className="gpu-org-models-row">
        <label htmlFor={`${id}-key`}>{t('settings.mcpServers.key')}</label>
        <input id={`${id}-key`} className="gpu-dom-input" type="text" maxLength={32} value={draft.key} disabled={busy || editing !== undefined}
          aria-describedby={`${id}-key-hint`} onChange={event => set({ key: event.target.value.toLowerCase(), keyEdited: true })} />
      </div>
      <p id={`${id}-key-hint`} className="gpu-org-models-hint">{t('settings.mcpServers.keyHint')}</p>
      <div className="gpu-org-models-row">
        <label htmlFor={`${id}-url`}>{t('settings.mcpServers.url')}</label>
        <input id={`${id}-url`} className="gpu-dom-input" type="url" placeholder="https://" value={draft.url} disabled={busy}
          {...secretInput} onChange={event => set({ url: event.target.value })} />
      </div>
      <fieldset disabled={busy}>
        <legend>{t('settings.mcpServers.authLegend')}</legend>
        {(['none', 'header', 'oauth'] as const).map(kind => (
          <label key={kind}>
            <input type="radio" name={`${id}-auth`} checked={draft.authKind === kind} onChange={() => set({ authKind: kind })} />
            {t(`settings.mcpServers.auth.${kind}`)}
          </label>
        ))}
      </fieldset>
      {editing && (draft.url.trim() !== (editing.url ?? '') || draft.authKind !== editing.authKind) ? (
        <p className="gpu-org-models-hint" role="note">{t('settings.mcpServers.resetWarning')}</p>
      ) : null}
      {draft.authKind === 'header' ? (
        <>
          <div className="gpu-org-models-row">
            <label htmlFor={`${id}-header`}>{t('settings.mcpServers.headerName')}</label>
            <input id={`${id}-header`} className="gpu-dom-input" type="text" value={draft.headerName} disabled={busy} {...secretInput}
              onChange={event => set({ headerName: event.target.value })} />
          </div>
          <div className="gpu-org-models-row">
            <label htmlFor={`${id}-secret`}>{t('settings.mcpServers.headerValue')}</label>
            <input id={`${id}-secret`} className="gpu-dom-input" type="password" value={draft.headerValue} disabled={busy} {...secretInput}
              placeholder={editing?.hasHeaderSecret ? t('settings.mcpServers.secretKept') : 'Bearer …'}
              onChange={event => set({ headerValue: event.target.value })} />
          </div>
        </>
      ) : null}
      {draft.authKind === 'oauth' ? (
        <details>
          <summary>{t('settings.mcpServers.oauthAdvanced')}</summary>
          <p className="gpu-org-models-hint">{t('settings.mcpServers.oauthAdvancedHint')}</p>
          <div className="gpu-org-models-row">
            <label htmlFor={`${id}-client`}>{t('settings.mcpServers.oauthClientId')}</label>
            <input id={`${id}-client`} className="gpu-dom-input" type="text" value={draft.oauthClientId} disabled={busy} {...secretInput}
              onChange={event => set({ oauthClientId: event.target.value })} />
          </div>
          <div className="gpu-org-models-row">
            <label htmlFor={`${id}-client-secret`}>{t('settings.mcpServers.oauthClientSecret')}</label>
            <input id={`${id}-client-secret`} className="gpu-dom-input" type="password" value={draft.oauthClientSecret} disabled={busy} {...secretInput}
              placeholder={editing?.hasOauthClientSecret ? t('settings.mcpServers.secretKept') : ''}
              onChange={event => set({ oauthClientSecret: event.target.value })} />
          </div>
          <div className="gpu-org-models-row">
            <label htmlFor={`${id}-scope`}>{t('settings.mcpServers.oauthScope')}</label>
            <input id={`${id}-scope`} className="gpu-dom-input" type="text" value={draft.oauthScope} disabled={busy} {...secretInput}
              onChange={event => set({ oauthScope: event.target.value })} />
          </div>
        </details>
      ) : null}
      {secretBlocked ? <p className="gpu-org-models-hint" role="note">{t('settings.mcpServers.encryptionUnavailable')}</p> : null}
      <div className="gpu-settings-actions">
        <button type="submit" disabled={busy || incomplete || secretBlocked}>
          <ButtonIcon kind={editing ? 'save' : 'plus'} />{t(editing ? 'settings.mcpServers.save' : draft.authKind === 'oauth' ? 'settings.mcpServers.addAndConnect' : 'settings.mcpServers.addSubmit')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}><ButtonIcon kind="close" />{t('settings.mcpServers.cancel')}</button>
      </div>
    </form>
  );
}
