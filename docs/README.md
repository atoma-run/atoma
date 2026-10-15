# Documentation

Start with the guides below for the current product. Dated decisions explain
why a mechanism exists; archived reports describe the code and evidence at the
time they were written, not the state of today's release.

## Start here

| I want to… | Read |
| --- | --- |
| Discover the product and use cases | [Project README](../README.md) |
| Understand the architecture and Decision | [How it works](how-it-works.md) |
| Develop locally | [Development setup](development-setup.md) · [Contributing](../CONTRIBUTING.md) |
| Understand what organisations share | [Service terms](platform-commons-terms.md) · [Hosted architecture boundary](saas-architecture.md) |
| Connect an agent | [MCP authorization and diagnostics](mcp-oauth.md) |
| Use a personal ChatGPT subscription | [Personal model discovery](personal-model-discovery.md) |

## Deploy and operate

| Task | Guide |
| --- | --- |
| Run the reference container stack | [Packaged stack](packaged-stack.md) · [Launcher service](launcher-service.md) |
| Deploy from CI and configure Decision or run limits | [Automatic deployment](automatic-deployment.md) · [Environment reference](../.env.example) |
| Import repositories and publish results | [GitHub App setup](github-app-setup.md) |
| Enable result previews | [Preview deployment](preview-deployment.md) |
| Configure project-document search | [Haystack setup](project-retrieval-haystack-only-2026-09-09.md) |
| Maintain project data and admission | [Project maintenance](project-maintenance.md) |
| Operate the analyst and mender | [Supervisor production setup](supervisor-codex-production.md) |
| Run registered retrieval benchmarks | [Benchmark MCP and console guide](benchmark-mcp-viz-2026-09-09.md) |
| Review the interface visually | [Screenshot tooling](viz-screenshot.md) |

## Decisions and implementation context

These records, kept under [`decisions/`](decisions/), explain accepted
choices, proposals and their implementation limits. Read each record's status; a proposal is not a shipped capability.
The [root engineering contract](../AGENTS.md) routes contributors to the
current subsystem rules.

| Area | Records |
| --- | --- |
| Decision | [Decision and calibration](decisions/jev-decisions-2026-09-28.md) · [Policy corrections](decisions/jev-policy-2026-10-01.md) |
| Acceptance and continuation | [Acceptance proposal](decisions/acceptance-contract-2026-09-14.md) · [Checklist](decisions/acceptance-checklist-2026-09-25.md) · [Continuation](decisions/run-continuation-design-2026-09-24.md) |
| Existing projects | [Seed inheritance](decisions/seed-inheritance-2026-09-25.md) · [Browser regression checks](decisions/inherited-checks-replay-2026-10-01.md) · [Comparison reruns](decisions/comparison-reruns-2026-09-25.md) |
| Learning and trust | [Platform commons](decisions/platform-trust-2026-09-15.md) · [Recoverable trust](decisions/recoverable-trust-2026-09-15.md) · [Compile at learn](decisions/compile-at-learn-2026-09-26.md) · [Registry ownership history](decisions/project-registry-ownership-2026-09-09.md) |
| Control plane | [Platform events](platform-events-design.md) · [Cross-organisation read audit](decisions/cross-org-read-audit.md) · [Subscription delegation](decisions/subscription-delegation-2026-09-22.md) |
| MCP | [One endpoint](decisions/mcp-one-surface-2026-09-05.md) · [Two protocol generations](decisions/mcp-two-eras-2026-09-30.md) |
| Preview and supervision | [In-flight preview](decisions/in-flight-preview-2026-09-02.md) · [Supervisor design](supervisor-design.md) |

## History and evidence

Internal records live outside `docs/`, under [`records/`](../records/README.md):
incident investigations, measurements, code reviews, older designs and
experiments, and release acceptance receipts.

- [Changelog](../CHANGELOG.md): product changes by release.
- [Benchmark protocol and results](../benchmark/PROTOCOL.md): controlled
  measurements with their scope and historical limits.

Keep here only what a developer or a user of Atoma reads: setup and operating
guides, architecture, and the accepted decisions under `decisions/`. Run
evidence, measurements, reviews and release receipts go under `records/`,
retaining their dates and updating inbound links when moving a file.
