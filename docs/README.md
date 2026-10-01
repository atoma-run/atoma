# Documentation

Start with the guides below for the current product. Dated decisions explain
why a mechanism exists; archived reports describe the code and evidence at the
time they were written, not the state of today's release.

## Start here

| I want to… | Read |
| --- | --- |
| Discover the product and use cases | [Project README](../README.md) |
| Understand the architecture and Jev | [How it works](how-it-works.md) |
| Develop locally | [Development setup](development-setup.md) · [Contributing](../CONTRIBUTING.md) |
| Understand what organisations share | [Service terms](platform-commons-terms.md) · [Hosted architecture boundary](saas-architecture.md) |
| Connect an agent | [MCP authorization and diagnostics](mcp-oauth.md) |
| Use a personal ChatGPT subscription | [Personal model discovery](personal-model-discovery.md) |

## Deploy and operate

| Task | Guide |
| --- | --- |
| Run the reference container stack | [Packaged stack](packaged-stack.md) · [Launcher service](launcher-service.md) |
| Deploy from CI and configure Jev or run limits | [Automatic deployment](automatic-deployment.md) · [Environment reference](../.env.example) |
| Import repositories and publish results | [GitHub App setup](github-app-setup.md) |
| Enable result previews | [Preview deployment](preview-deployment.md) |
| Configure project-document search | [Haystack setup](project-retrieval-haystack-only-2026-09-09.md) |
| Maintain project data and admission | [Project maintenance](project-maintenance.md) |
| Operate the analyst and mender | [Supervisor production setup](supervisor-codex-production.md) |
| Run registered retrieval benchmarks | [Benchmark MCP and console guide](benchmark-mcp-viz-2026-09-09.md) |
| Review the interface visually | [Screenshot tooling](viz-screenshot.md) |

## Decisions and implementation context

These records explain accepted choices, proposals and their implementation
limits. Read each record's status; a proposal is not a shipped capability.
The [root engineering contract](../AGENTS.md) routes contributors to the
current subsystem rules.

| Area | Records |
| --- | --- |
| Jev | [Decision and calibration](jev-decisions-2026-09-28.md) · [Policy corrections](jev-policy-2026-10-01.md) |
| Acceptance and continuation | [Acceptance proposal](acceptance-contract-2026-09-14.md) · [Checklist](acceptance-checklist-2026-09-25.md) · [Continuation](run-continuation-design-2026-09-24.md) |
| Existing projects | [Seed inheritance](seed-inheritance-2026-09-25.md) · [Browser regression checks](inherited-checks-replay-2026-10-01.md) · [Comparison reruns](comparison-reruns-2026-09-25.md) |
| Learning and trust | [Platform commons](platform-trust-2026-09-15.md) · [Recoverable trust](recoverable-trust-2026-09-15.md) · [Compile at learn](compile-at-learn-2026-09-26.md) · [Registry ownership history](project-registry-ownership-2026-09-09.md) |
| Control plane | [Platform events](platform-events-design.md) · [Cross-organisation read audit](cross-org-read-audit.md) · [Subscription delegation](subscription-delegation-2026-09-22.md) |
| MCP | [One endpoint](mcp-one-surface-2026-09-05.md) · [Two protocol generations](mcp-two-eras-2026-09-30.md) |
| Preview and supervision | [In-flight preview](in-flight-preview-2026-09-02.md) · [Supervisor design](supervisor-design.md) |

## History and evidence

- [Archive index](archive/README.md): older designs, experiments, reviews,
  release acceptance reports and their machine-readable receipts.
- [Code review index](code-reviews.md): reviewed revisions and correction
  windows, including reports now in the archive.
- [Incidents](incidents/): dated run evidence and failure investigations.
- [Changelog](../CHANGELOG.md): product changes by release.
- [Benchmark protocol and results](../benchmark/PROTOCOL.md): controlled
  measurements with their scope and historical limits.

Keep setup and operating guides here. Put historical reviews, experiments and
release evidence under `archive/`, retaining their dates and updating inbound
links when moving a file. Incidents keep their existing home. Preserve the
frozen engineering record verbatim; its historical paths can be located by
filename in the archive index. Archiving a record does not revoke an accepted
decision or turn a past successful check into current release evidence.
