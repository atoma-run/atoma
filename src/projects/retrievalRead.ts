import { readHaystackLaunch, type HaystackLaunch } from '../contracts/retrievalHaystack.js';
import { projectRetrievalScopeSchema, type ProjectRetrievalRequest } from '../contracts/projectRetrieval.js';
import type { ProjectRun } from '../contracts/projects.js';
import { selectRetrievalDocuments } from './retrievalSelection.js';
import { prepareProjectRetrievalSources } from './retrievalCorpus.js';
import { createHaystackRetrievalBinding } from './retrievalHaystack.js';
import { createProjectRetrievalTool } from '../tools/projectRetrieval.js';

let active = 0;
/** Read-only ephemeral index; the same ingestion, Haystack ranking and bounded tool adapter as runs. */
export async function searchSavedProjectCode(input: {
  run: ProjectRun; principalId: string; query: ProjectRetrievalRequest;
  read: (path: string) => Buffer; authorize: () => boolean; launch?: HaystackLaunch;
}) {
  if (active >= 2) return { ok: false as const, status: 'unavailable' as const };
  active++;
  let binding: Awaited<ReturnType<typeof createHaystackRetrievalBinding>> | undefined;
  try {
    if (!input.authorize()) return { ok: false as const, status: 'denied' as const };
    const launch = input.launch ?? readHaystackLaunch(process.env);
    const context = { signal: AbortSignal.timeout(120_000), deadlineAt: Date.now() + 120_000 };
    const selected = selectRetrievalDocuments(input.run.artifactManifest!.files);
    const corpus = await prepareProjectRetrievalSources({ version: 1, corpusId: 'project-docs',
      snapshotId: input.run.projectRunId, snapshotSha256: input.run.artifactManifestHash!, ...selected,
    }, context, async document => input.read(document.path));
    const scope = projectRetrievalScopeSchema.parse({ kind: 'tenant', runId: input.run.projectRunId,
      projectId: input.run.projectId, orgId: input.run.orgId, principalId: input.principalId,
      corpusId: corpus.manifest.corpusId, snapshotId: corpus.manifest.snapshotId,
      snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation });
    binding = await createHaystackRetrievalBinding({ corpus, context, ...launch, authority: { scope, service: {
      authorize: async () => input.authorize(), search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {},
    } } });
    return await createProjectRetrievalTool(binding, context).execute(input.query);
  } catch { return { ok: false as const, status: 'unavailable' as const }; }
  finally { try { await binding?.service.dispose(); } finally { active--; } }
}
