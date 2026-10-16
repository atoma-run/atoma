import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiHttpError } from '../client/data-api.js';
import type { ConnectorView } from '../../contracts/mcpConnectors.js';

/**
 * PROJECT SETTINGS → MCP SERVERS: which of the organisation's connections this
 * project's runs may use (src/connectors). One choice model for the GPU card
 * and its accessible twin, as the deployment preference has: a draft, an
 * explicit save with the set the editor saw as its stale-write guard.
 */

export interface ConnectorSettingsServer {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly host: string;
  readonly status: ConnectorView['status'];
  readonly enabledTools: number;
  readonly totalTools: number;
}

export interface ConnectorSettingsView {
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly servers: readonly ConnectorSettingsServer[];
  readonly selected: readonly string[];
  readonly saved: readonly string[];
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly status: 'idle' | 'saved' | 'failed' | 'conflict';
}

export const CONNECTOR_TOGGLE_PREFIX = 'connectors.toggle.';

export interface ConnectorRow {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly detailVars: Record<string, unknown>;
  readonly checked: boolean;
  readonly disabled: boolean;
}

/** The pure copy model both renderers draw. */
export function connectorsCopy(view: ConnectorSettingsView): {
  rows: ConnectorRow[];
  empty: string | null;
  status: string | null;
  showSave: boolean;
  saveDisabled: boolean;
  showOpenSettings: boolean;
} {
  const changed = [...view.selected].sort().join(',') !== [...view.saved].sort().join(',');
  return {
    rows: view.servers.map(server => ({
      id: `${CONNECTOR_TOGGLE_PREFIX}${server.id}`,
      name: server.name,
      detail: server.status === 'ready' ? 'connectors.serverDetail' : 'connectors.serverDetailAttention',
      detailVars: { host: server.host, enabled: server.enabledTools, total: server.totalTools, status: `settings.mcpServers.status.${server.status}` },
      checked: view.selected.includes(server.id),
      disabled: !view.canEdit || view.busy,
    })),
    empty: view.loading ? 'connectors.loading' : view.loadFailed ? 'connectors.loadFailed' : view.servers.length === 0 ? 'connectors.empty' : null,
    status: view.status === 'idle' ? null : `connectors.status.${view.status}`,
    showSave: view.canEdit && (changed || view.status === 'failed' || view.status === 'conflict'),
    saveDisabled: view.busy || !changed,
    showOpenSettings: view.canEdit && !view.loading && !view.loadFailed,
  };
}

export function useProjectConnectors(projectId: string | null, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['viz', 'projectMcpServers', projectId],
    enabled: enabled && projectId !== null,
    retry: false,
    queryFn: () => api.projectMcpServers(projectId!),
  });
  const saved = useMemo(() => query.data?.enabled ?? [], [query.data]);
  const savedKey = `${projectId}:${[...saved].sort().join(',')}`;
  // A draft belongs to the saved set it was made from; a refreshed server set discards it.
  const [edit, setEdit] = useState<{ key: string; selected: string[] }>();
  // The outcome outlives the draft: a conflict stays visible after the reload it causes.
  const [notice, setNotice] = useState<{ projectId: string; status: Exclude<ConnectorSettingsView['status'], 'idle'> }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const view = useMemo<ConnectorSettingsView | null>(() => {
    if (!enabled || projectId === null) return null;
    const draft = edit?.key === savedKey ? edit : undefined;
    return {
      loading: query.isLoading,
      loadFailed: query.isError,
      servers: (query.data?.servers ?? []).map(server => ({
        id: server.id, key: server.key, name: server.name, host: server.host, status: server.status,
        enabledTools: server.tools.filter(tool => !server.disabledTools.includes(tool.name)).length, totalTools: server.tools.length,
      })),
      selected: draft?.selected ?? saved,
      saved,
      canEdit: query.data?.canEdit === true,
      busy,
      status: notice?.projectId === projectId ? notice.status : 'idle',
    };
  }, [enabled, projectId, edit, savedKey, query.isLoading, query.isError, query.data, saved, busy, notice]);

  const activate = useCallback((id: string) => {
    if (!view || !projectId || !view.canEdit || inFlight.current) return;
    if (id.startsWith(CONNECTOR_TOGGLE_PREFIX)) {
      const serverId = id.slice(CONNECTOR_TOGGLE_PREFIX.length);
      if (!view.servers.some(server => server.id === serverId)) return;
      const selected = view.selected.includes(serverId) ? view.selected.filter(entry => entry !== serverId) : [...view.selected, serverId];
      setEdit({ key: savedKey, selected });
      setNotice(undefined);
      return;
    }
    if (id !== 'connectors.save') return;
    const selected = [...view.selected];
    inFlight.current = true; setBusy(true);
    void (async () => {
      try {
        const result = await api.saveProjectMcpServers(projectId, selected, [...saved]);
        client.setQueryData(['viz', 'projectMcpServers', projectId], (previous: typeof query.data) =>
          previous ? { ...previous, enabled: result.enabled } : previous);
        setEdit(undefined);
        setNotice({ projectId, status: 'saved' });
      } catch (error) {
        const conflict = error instanceof ApiHttpError && error.status === 409;
        setNotice({ projectId, status: conflict ? 'conflict' : 'failed' });
        // A conflict shows what the project holds now; the editor chooses again from there.
        if (conflict) await client.invalidateQueries({ queryKey: ['viz', 'projectMcpServers', projectId] });
      } finally { inFlight.current = false; setBusy(false); }
    })();
  }, [view, projectId, savedKey, saved, client, query.data]);

  return { view, activate };
}
