import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../client/data-api.js';
import { isIndexEntryLive, isRunLive, projectRunUpdate } from '../client/run-utils.js';
import type { RunIndexEntry, RunIndexPage, SkillSummary, VizApiTokens, VizRun } from '../client/types.js';
import { compareRunIndex } from '../runIndexOrder.js';

/** Rows per page of the platform-wide list, and the most one project shows. */
export const RUN_INDEX_PAGE = 50;
export const RUN_INDEX_PROJECT_MAX = 200;

/**
 * Live work is followed at 2s. Otherwise the list only has to DISCOVER a run
 * started elsewhere (MCP, another browser), at the project runs' idle cadence.
 */
function runsCadence(active: boolean, runs: readonly RunIndexEntry[]): number | false {
  if (!active) return false;
  return runs.some((entry) => isIndexEntryLive(entry)) ? 2_000 : 5_000;
}

/**
 * The project's own list and the platform-wide pages, one row per id, in the
 * server's order. The project list wins a duplicate: it is the complete one.
 */
export function mergeRunIndex(
  project: readonly RunIndexEntry[] | undefined,
  pages: readonly RunIndexPage[] | undefined
): RunIndexEntry[] | undefined {
  if (!pages && !project) return undefined;
  const byId = new Map<string, RunIndexEntry>();
  for (const page of pages ?? []) for (const entry of page.runs) byId.set(entry.id, entry);
  for (const entry of project ?? []) byId.set(entry.id, entry);
  return [...byId.values()].sort(compareRunIndex);
}

/**
 * THE RUNS INDEX, paged. The platform-wide list arrives 50 rows at a time,
 * older pages on request (`fetchNextPage`, the picker's bottom); the project
 * of the selected run is read WHOLE, because the picker shows that project
 * with its totals and search, and a page boundary would cut both.
 *
 * Every loaded page is re-polled: a refetch walks the pages from the first,
 * re-deriving each cursor from the page before, so a run arriving at the top
 * neither repeats nor hides a row. Unchanged pages answer 304.
 */
export function useRunsIndex(
  active: boolean,
  selectedRunId: string | null = null,
  selectedProjectId: string | null = null
) {
  const pages = useInfiniteQuery({
    queryKey: ['viz', 'runs', 'pages'],
    queryFn: ({ pageParam }) => api.runsPage({ limit: RUN_INDEX_PAGE, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: active,
    staleTime: 750,
    refetchInterval: (query) =>
      runsCadence(active, query.state.data?.pages.flatMap((page) => page.runs) ?? []),
  });
  // The scope follows the SELECTED RUN's project, as the picker does; the
  // first render knows only the pages, the next one may know the project.
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const project = useQuery({
    queryKey: ['viz', 'runs', 'project', scopeProjectId],
    queryFn: () => api.runsPage({ limit: RUN_INDEX_PROJECT_MAX, projectId: scopeProjectId }),
    enabled: active && scopeProjectId !== null,
    staleTime: 750,
    refetchInterval: (query) => runsCadence(active, query.state.data?.runs ?? []),
  });
  const data = useMemo(
    () => mergeRunIndex(scopeProjectId === null ? undefined : project.data?.runs, pages.data?.pages),
    [pages.data, project.data, scopeProjectId]
  );
  useEffect(() => {
    const selected = selectedRunId ? data?.find((entry) => entry.id === selectedRunId) : undefined;
    setScopeProjectId(selected ? selected.projectId ?? null : selectedProjectId);
  }, [data, selectedProjectId, selectedRunId]);
  return {
    data,
    isLoading: pages.isLoading,
    error: active ? pages.error ?? project.error : null,
    hasNextPage: pages.hasNextPage,
    isFetchingNextPage: pages.isFetchingNextPage,
    fetchNextPage: pages.fetchNextPage,
  };
}

export function useRunTrace(runId: string | null, active: boolean, indexEntry?: RunIndexEntry) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['viz', 'run', runId],
    enabled: active && !!runId,
    queryFn: async () => {
      if (!runId) throw new Error('run id is required');
      const current = queryClient.getQueryData<VizRun>(['viz', 'run', runId]);
      const incoming = await api.run(runId, current?.events.length);
      return projectRunUpdate(current, incoming);
    },
    refetchInterval: (query) => {
      const run = query.state.data;
      // The index can precede the first trace flush. Keep the existing live
      // poll until that trace arrives, using the same liveness contract.
      const live = run ? isRunLive(run) : indexEntry?.id === runId && isIndexEntryLive(indexEntry);
      return active && live ? 1000 : false;
    },
    staleTime: 750,
  });
  // Cached errors belong to the selected view, not every later destination.
  return { ...query, error: active ? query.error : null };
}

export function useRegistries(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'registries'],
    queryFn: api.registries,
    enabled: active,
  });
}

export function useRegistry(registryId: string | null, active: boolean) {
  return useQuery({
    queryKey: ['viz', 'registry', registryId],
    queryFn: () => {
      if (!registryId) throw new Error('registry id is required');
      return api.registry(registryId);
    },
    enabled: active && !!registryId,
  });
}

export function useSkillNamespaces(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'skills', 'namespaces'],
    queryFn: api.skillNamespaces,
    enabled: active,
  });
}

export function useSkillLists(names: string[], active: boolean) {
  const results = useQueries({
    queries: names.map((l1Name) => ({
      queryKey: ['viz', 'skills', l1Name],
      queryFn: () => api.skills(l1Name),
      enabled: active,
    })),
  });
  // Reference-stable across renders whose inputs did not change. This object
  // sits in the deps of the `data` memo the GPU snapshot is built from, and a
  // fresh `{}` per render meant every React render — every poll notification
  // included — produced a "new" snapshot and rebuilt the entire GPU scene.
  // A ref-compare cache instead of useMemo because the dependency list
  // (one data ref per namespace) has variable length.
  const cache = useRef<{
    names: readonly string[];
    datas: readonly (SkillSummary[] | undefined)[];
    value: Record<string, SkillSummary[]>;
  } | null>(null);
  const datas = results.map((result) => result.data);
  const cached = cache.current;
  if (
    !cached ||
    cached.names.length !== names.length ||
    names.some((name, index) => name !== cached.names[index]) ||
    datas.some((data, index) => data !== cached.datas[index])
  ) {
    const value: Record<string, SkillSummary[]> = {};
    names.forEach((name, index) => {
      value[name] = datas[index] ?? [];
    });
    cache.current = { names: [...names], datas, value };
  }
  return { results, byNamespace: cache.current!.value };
}

export function useSkillDetail(
  selection: { l1Name: string; id: string } | null,
  active: boolean
) {
  return useQuery({
    queryKey: ['viz', 'skill', selection?.l1Name, selection?.id],
    queryFn: () => {
      if (!selection) throw new Error('skill selection is required');
      return api.skill(selection.l1Name, selection.id);
    },
    enabled: active && !!selection,
  });
}

export function useBurnin(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'burnin'],
    queryFn: api.burnin,
    enabled: active,
  });
}

export function useGoalGuidance(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'goal-guidance'],
    queryFn: api.goalGuidance,
    enabled: active,
    staleTime: Infinity,
  });
}

export function useProjects(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'projects'],
    queryFn: api.projects,
    enabled: active,
    refetchInterval: active ? 5_000 : false,
    staleTime: 2_000,
  });
}

/** The viewer's authorized MCP clients, scoped in the caller to the active organisation. */
export function useMcpAccess(active: boolean, principalId: string | null) {
  return useQuery({
    queryKey: ['viz', 'mcp', 'access', principalId],
    queryFn: api.apiTokens,
    enabled: active && principalId !== null,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function projectMcpAccessState(
  data: VizApiTokens | undefined,
  orgId: string | null
): 'connected' | 'authorized' | 'unconnected' | 'unknown' {
  if (!data || !orgId) return 'unknown';
  const active = data.tokens.filter((token) => token.orgId === orgId && token.revokedAt === null);
  if (active.some((token) => token.lastUsedAt !== null)) return 'connected';
  return active.length > 0 ? 'authorized' : 'unconnected';
}

/**
 * One run's preview state.
 *
 * TWO CADENCES, for two questions. While a generation is BUILDING the member
 * is watching a spinner, so 1.5s is what makes it feel answered. While one is
 * READY the question is the opposite — has it stopped underneath me? — and a
 * slow poll is what takes a dead iframe down instead of leaving it looking
 * like the app. Neither can spend an organisation's quota: the server refuses
 * to allocate on a GET, by contract.
 */
export function usePreviewStatus(
  projectId: string | null,
  runId: string | null,
  active: boolean
) {
  return useQuery({
    queryKey: ['viz', 'preview', projectId, runId],
    enabled: active && !!projectId && !!runId,
    queryFn: () => {
      if (!projectId || !runId) throw new Error('project and run ids are required');
      return api.previewStatus(projectId, runId);
    },
    // TWO cadences, for two questions. While a generation is BUILDING the
    // member is watching a spinner and 1.5s is what makes it feel answered.
    // While one is READY the question is the opposite — has it stopped
    // underneath me? — and a slow poll is what takes a dead iframe down
    // instead of leaving it looking like the app. A GET allocates nothing, so
    // neither cadence can spend an organisation's quota.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === 'starting' || state === 'stopping') return 1_500;
      return state === 'ready' ? 15_000 : false;
    },
    staleTime: 1_000,
  });
}

export function useProjectRuns(projectId: string | null, active: boolean) {
  return useQuery({
    queryKey: ['viz', 'project', projectId, 'runs'],
    enabled: active && !!projectId,
    queryFn: () => {
      if (!projectId) throw new Error('project id is required');
      return api.projectRuns(projectId);
    },
    refetchInterval: (query) => {
      const runs = query.state.data;
      const live = runs?.some((run) => run.status === 'queued' || run.status === 'running');
      // An idle project can receive a run from MCP or another browser. Keep
      // discovering runs while this query is enabled, then follow live work faster.
      return live ? 2_000 : 5_000;
    },
    staleTime: 1_000,
  });
}

export function useGithubInstallations(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'github', 'installations'],
    queryFn: api.githubInstallations,
    enabled: active,
    staleTime: 30_000,
  });
}

export function useAdminStats(active: boolean, days: import('../../contracts/platformStats.js').PlatformStatsDays) {
  const query = useQuery({
    queryKey: ['viz', 'admin', 'stats', days], queryFn: () => api.adminStats(days),
    enabled: active, staleTime: 15_000, refetchInterval: active ? 30_000 : false,
  });
  return { ...query, error: active ? query.error : null };
}

export function useAdminOrganisations(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'admin', 'organisations'],
    queryFn: api.adminOrganisations,
    enabled: active,
    staleTime: 5_000,
  });
}

/**
 * THE AUDIT JOURNAL, paged. One page per scroll to the bottom, newest first,
 * with the server's `nextBefore` as the cursor — so a page boundary can
 * neither repeat nor skip a row the way an offset over a growing table would.
 *
 * Filters live in the QUERY KEY, not in a client-side filter over loaded
 * pages: filtering after paging would thin each page instead of finding more
 * matching rows, and a viewer would see three matches where the journal holds
 * three hundred.
 *
 * Polling stops once the viewer has paged. React Query refetches EVERY loaded
 * page on an interval, so tailing a ten-page history would re-fetch ten pages
 * every ten seconds to learn about one new row. Page one tails; deeper
 * history is history.
 */
export function useAdminEventsPages(
  active: boolean,
  filters: { severity: string; family: string }
) {
  return useInfiniteQuery({
    queryKey: ['viz', 'admin', 'events', filters.severity, filters.family],
    queryFn: ({ pageParam }) =>
      api.adminEvents({
        limit: 60,
        before: pageParam,
        severity: filters.severity,
        family: filters.family,
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: active,
    staleTime: 10_000,
    refetchInterval: (query) =>
      active && (query.state.data?.pages.length ?? 1) === 1 ? 10_000 : false,
  });
}

/**
 * The viewer's notification tray, paged like the journal. Fetched only while
 * the menu is open; the first page re-polls on the journal's cadence so a tray
 * left open tails new arrivals. The locale rides the query key because the
 * server renders the copy — switching language is a different query, not a
 * client-side re-render.
 */
export function useNotificationsPages(active: boolean, locale: string) {
  return useInfiniteQuery({
    queryKey: ['viz', 'notifications', locale],
    queryFn: ({ pageParam }) =>
      api.notifications({ limit: 30, before: pageParam, locale }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: active,
    staleTime: 10_000,
    refetchInterval: (query) =>
      active && (query.state.data?.pages.length ?? 1) === 1 ? 10_000 : false,
  });
}

/** The platform-wide running set, refreshed only while its admin view is open. */
export function useAdminLiveRuns(active: boolean) {
  const query = useQuery({
    queryKey: ['viz', 'admin', 'live-runs'],
    queryFn: api.adminLiveRuns,
    enabled: active,
    staleTime: 750,
    refetchInterval: active ? 2_000 : false,
  });
  return { ...query, error: active ? query.error : null };
}

/**
 * The sentinel's own screen: rule table, live coverage, findings. Polled at
 * the runs cadence rather than the journal's, because half of it IS live
 * state — which runs are in flight right now.
 */
export function useAdminSentinel(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'admin', 'sentinel'],
    queryFn: api.adminSentinel,
    enabled: active,
    staleTime: 2_000,
    refetchInterval: active ? 5_000 : false,
  });
}

/** The product ledger's tail. Static enough to fetch once per visit. */
export function useAdminLedger(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'admin', 'ledger'],
    queryFn: () => api.adminLedger(),
    enabled: active,
    staleTime: 30_000,
  });
}

/** The viewer's own organisation. Gated deployments only — 404 otherwise. */
export function useOrganisation(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'org'],
    queryFn: api.organisation,
    enabled: active,
    staleTime: 15_000,
  });
}

export function useAccountModels(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'account', 'models'],
    queryFn: () => api.accountModels(),
    enabled: active,
    staleTime: 30_000,
  });
}

/**
 * Personal provider state is account self-care, separate from model pins.
 * Only an active Codex device flow needs polling; a settled connection is
 * refreshed explicitly after each mutation.
 */
export function useAccountSubscriptions(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'account', 'subscriptions'],
    queryFn: api.accountSubscriptions,
    enabled: active,
    staleTime: 1_000,
    // A device code is transient login material. Once Settings unmounts it
    // leaves the browser query cache immediately rather than waiting for the
    // ordinary five-minute garbage-collection window.
    gcTime: 0,
    refetchInterval: (query) =>
      active &&
      (query.state.data?.codex.state === 'connecting' ||
        query.state.data?.codexAttempt?.state === 'connecting')
        ? 1_000
        : false,
  });
}

export function useOrgModels(active: boolean) {
  return useQuery({
    queryKey: ['viz', 'org', 'models'],
    queryFn: api.orgModels,
    enabled: active,
    staleTime: 30_000,
  });
}

/** Only poll the newest page while the monitoring view is visible. */
export function useAdminAssayer(active: boolean) {
  return useInfiniteQuery({
    queryKey: ['viz', 'admin', 'assayer'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.adminAssayer(pageParam),
    getNextPageParam: page => page.nextBefore ?? undefined,
    enabled: active, staleTime: 5000,
    refetchInterval: query => active && (query.state.data?.pages.length ?? 0) <= 1 ? 5000 : false,
  });
}
export function useAdminAssay(active: boolean, id: string | null) {
  return useQuery({ queryKey: ['viz', 'admin', 'assay', id], queryFn: () => api.adminAssay(id!), enabled: active && id !== null });
}

export function useAdminAssayerHealth(active: boolean) {
  return useQuery({ queryKey: ['viz', 'admin', 'assayer-health'], queryFn: api.adminAssayerHealth,
    enabled: active, staleTime: 2000, refetchInterval: active ? 5000 : false });
}
