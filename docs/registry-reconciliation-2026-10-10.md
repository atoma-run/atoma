# The catalogue's clone engine, measured — design record 2026-10-10

The registry record of 2026-09-16 left one question open: the prefilter
routes on descriptions, automatic reuse deduplicates on prompts, and nothing
reconciles them. It asked that the reconciliation be designed in a later
session, under the cooling-off rule the owner removed on 2026-09-27. This
record takes the measurement up again, 24 days later, and names the
mechanisms. Decisions it needs from the owner are listed at the end; nothing
here has changed the registry or its contract yet.

## What the store holds on 2026-10-10

Read through `atoma_registry_list` on the production store. Eighteen
molecules, five cells, ten tissues (nine of them written by the tissue author
since 2026-10-02, one per task domain, all eleven tools).

| Signature | Molecules | Created by |
|---|---|---|
| web artefact (6 tools) | Water, Glucose, Sucrose, Serotonin | bootstrap; Tracheid ×2; Idioblast |
| full-stack (8) | CarbonDioxide, Ethanol, Methanol, Acetone, Caffeine, Dopamine, DNA | bootstrap; Idioblast ×6 |
| node server (7) | Methane, Hemoglobin | bootstrap; Sclereid |
| file scribe (6) / + project docs (7) | Ammonia, Benzene | bootstrap ×2 |
| all eleven tools | Adrenaline, Insulin, Chlorophyll | Protoplast ×2, Trichome |

On 2026-09-16 there were nine molecules in seven behaviour groups. Of the
nine created since, four carry task narratives as descriptions — "Interpret
a stated scheduling model and return an exact textual enumeration without
tools or file changes" (Adrenaline, eleven tools), "Derive and present a
self-contained exact-fraction Bayesian urn analysis" (Insulin), "Build and
verify a dependency-free browser orbital mechanics lab" (Chlorophyll),
"Compose and arithmetically audit a self-contained fictional decision brief"
(DNA) — and three of those are trusted.

What it costs is measured on the Jev reading of the same day
([jev-decisions-2026-09-28.md](jev-decisions-2026-09-28.md), "twin agents"):
of 256 agent picks at L2, 119 were deferred to the model on confidence,
because the catalogue showed Jev several lines it had no reason to tell
apart — the Benzene/Ammonia pair in 44, Chlorophyll against CarbonDioxide,
Ethanol or Water in most of the rest. Every deferral is a model call of
about six seconds.

## Four mechanisms

1. **Every created child has exactly its parent's tools.** `createSubtaskL1`
   and `createSubtaskL2` take `mergeTools(this.tools, seed.tools)`, a union
   in which the parent's declarations win. A planner seed can add a tool it
   hallucinated, never narrow the set. Every molecule above was created with
   its creator's full signature: six full-stack clones under Idioblast, three
   eleven-tool molecules under the eleven-tool cells a tissue created. The
   "narrow specialist" the creation comment promises cannot exist below a
   wide parent.

2. **A prompt revision in the code mints a generation of clones.** Automatic
   reuse (`createOrReuse`) matches `atomBehaviorKey`: tier, the prompt byte
   for byte apart from the persona, the full tool schemas, the parameters. A
   created type's prompt is `buildNarrowL1Prompt('', tools)`, a template
   rendered from code. The bootstrap patches the CANONICAL types to the
   current template at every start (Water is at version 9); a model-created
   type keeps the template of the day it was born. Dopamine (2026-09-27) and
   DNA (2026-10-07) have the same eight tools, the same parameters and the
   same role; DNA's prompt carries the two sentences the 2026-10-05 commit
   `e7d84a57` added ("Preserve a task-defined server CLI and readiness
   format…"). The template file was revised eight times between 2026-10-01
   and 2026-10-09. Each revision makes every existing model-created type
   non-equivalent to the next creation on its signature, so the next
   `create` strategy allocates a clone that differs from its elders by
   sentences the elders will never receive.

3. **The description filter is lexical.** `looksTaskThemed` drops a seed
   description over 200 characters or matching a list of game names, grid
   sizes, UI verbs and two preambles. The four narratives above are 80–110
   characters and name no game. This is the vocabulary-frozen detector class
   the root contract names; it was never going to hold against a planner
   that writes "Derive and present an exact-fraction Bayesian urn analysis".
   Its exception (honour a 150–190 character planner role seed, so that a
   kitchen-sink tool set does not get the lying label "Node HTTP server
   orchestrator") is what lets narratives through on exactly the wide
   signatures mechanism 1 produces.

4. **Tissues are domain-named by design, and their children inherit
   everything.** Tissue routing ([tissue-routing-2026-10-02.md](tissue-routing-2026-10-02.md))
   writes a tissue per kind of work and routes on its method, so a domain
   description is the point there. But a tissue holds every tool, the cell it
   creates holds every tool (mechanism 1), the molecule that cell creates
   holds every tool, and at that depth the only thing that distinguishes the
   molecule from CarbonDioxide is the narrative mechanism 3 let through.
   Protoplast and Trichome, trusted cells at 114/0 and 104/0, are such
   eleven-tool cells.

The 2026-09-16 record's hypothesis — a validator patch splits an equivalent
group — is real but minor beside mechanism 2: it needs a refusal, mechanism
2 needs a commit.

## What reconciles them

The description IS the tool signature's label by construction, and the
prompt IS the signature's template by construction, for every type the
system creates on its own. Reuse should therefore match what the planner
chose — tier, tool names, parameters — and the template should follow the
code, as it does for canonicals. Concretely:

- **Family reuse.** `createOrReuse` for a seed whose prompt is the current
  template reuses the oldest model-created type with the same tier, tool
  names and parameters, and patches its prompt to the current template when
  it differs — the refresh the bootstrap already applies to canonicals, under
  the same rule (a prompt patch resets the streak, keeps the totals). A type
  a validator patched or branched has a prompt that is not the template and
  stays out of the family: that is the repair's identity.
- **Narrowing seeds.** A child's tools are the seed's, intersected with the
  parent's, when the seed names any; the union stays for a seed that names
  none. A planner that asks for `write_file` and `run_shell` under an
  eleven-tool cell gets the file scribe's signature and the file scribe's
  label — and `createOrReuse` then finds Ammonia.
- **Labels by signature.** A seed description is honoured only when no type
  at that tier has the signature yet; on a known signature the canonical
  label applies, so the catalogue shows one line per capability and Jev's
  identical-description fold does the rest. The 150–190 character exception
  survives for novel signatures, which is where it was needed.
- **The existing clones** are an operator arbitration: `registry dedupe`
  and `mergeInto` exist for it, write to the production store, and the
  contract archives the store first. Winners keep history; the four
  narrative molecules and the six full-stack clones are the candidates.

## Adversarial cases, before any of it lands

- A seed that names a tool the parent lacks: intersection drops it, as the
  union's parent-wins rule already did for a collision; a seed naming only
  unknown tools falls back to the parent's set, never to an empty molecule.
- A reasoning-only phase (`executionMode: 'reasoning'`) creates with the
  parent's tools today and declares none at execution; family reuse must key
  on the declared set, not the executed one, or every reasoning phase mints
  a family.
- Family refresh on a trusted type resets its streak (Ethanol 15, Chlorophyll
  19): that is the existing rule for a genuine prompt change, and the
  bootstrap applies it to Water on every template revision. Owner's call
  whether a template refresh is a behaviour change for trust purposes.
- A type the operator prompt-review repaired (`operator:prompt-review`,
  2026-10-01) has a prompt that is neither the template nor a validator's:
  it joins no family until the next refresh rewrites it, which is what the
  repair script would have done anyway.
- Tissue children: narrowing seeds only helps when the tissue's planner
  names tools. The tissue prompt should ask it to, and the measurement is
  whether eleven-tool molecules stop appearing.

## Decisions — owner, 2026-10-10

1. **Family reuse with template refresh: adopted, streak kept.**
   `AtomRegistry.createOrRefresh` reuses an exact behavior match, else the
   oldest type of the same tier, tool names and parameters whose prompt the
   template predicate recognises (`isNarrowL1Template`,
   `isNarrowL2Template`: the template's first line), and patches it to the
   current prompt and tool declarations with `keepStreak` — version
   recorded as `template refresh`, no trust reset. Both creation sites and
   both escalation-branch sites use it; a validator's prompt is never a
   family member.
2. **Narrowing seeds: adopted at both sites.** `scopeTools` keeps the
   parent's declarations for the names the seed lists, the whole set when
   it lists none the parent holds. The strategy schema keeps seed tool
   NAMES (it dropped them before, so a seed could never narrow), and an
   object the model writes contributes its name only: an invented
   declaration never enters the registry.
3. **Labels by signature: adopted.** `resolveCreationDescription` takes
   `signatureKnown`; a seed or validator label on a signature the tier
   already holds becomes the canonical label.
4. **Dedupe of the present catalogue: list first, decide after.** The
   candidates with their histories, trust and skill namespaces are the next
   deliverable; no write to the production registry before the owner names
   the winners.

## Dedupe candidates — for the owner to name winners

Read on 2026-10-10 from `atoma_registry_list` and `atoma_skills_list`.
Counters are ✓successes/✗failures, then the streak; "skills" counts the
molecule's recipes, with the ones that carry matches named. Nothing below
has been written.

**Web artefact, 6 tools** — one signature, three prompts (the 2026-09-16
record's Water/Glucose/Sucrose) plus a branch:

| Type | Created | ✓/✗, streak | Trusted | Skills |
|---|---|---|---|---|
| Water | bootstrap | 32/5, 11 | yes | 9: build-self-contained-static-page 29/26, serve-and-validate-static-page 8/7, harden-scenario-state-validation 4/4, build-responsive-static-multipage-site 3/2 |
| Glucose | Tracheid, 09-07 | 16/6, 1 | no | 7: build-node-network-dashboard 13/11, verify-responsive-static-layout 4/3 |
| Sucrose | Tracheid, 09-07 | 3/1, 0 | no | 1 recover, unmatched |
| Serotonin | Idioblast, 09-26 | 26/1, 0 | no | 2: patch-verified-static-ui 18/16 |

Winner by every reading: Water. The cost is in the skills: Glucose's
dashboard recipe and Serotonin's static-UI patch recipe are matched and
credited, and a merge that drops them loses 31 matches of evidence.

**Full-stack, 8 tools** — six clones of the canonical plus one narrative:

| Type | Created | ✓/✗, streak | Trusted | Skills |
|---|---|---|---|---|
| CarbonDioxide | bootstrap | 59/16, 31 | yes | 13: verify-persistent-operations-dashboard 23/23, build-node-api-web-ui 11/8, harden-persistent-scenario-library 9/9, build-offline-typing-studio 5/5 |
| Ethanol | Idioblast, 09-11 | 18/7, 15 | yes | 3 recovers, unmatched |
| Methanol | Idioblast, 09-12 | 0/0 | no | none |
| Acetone | Idioblast, 09-12 | 1/0 | no | none |
| Caffeine | Idioblast, 09-24 | 0/1 | no | none |
| Dopamine | Idioblast, 09-27 | 1/0 | no | none |
| DNA ("fictional decision brief") | Idioblast, 10-07 | 1/0 | no | none |

Winner: CarbonDioxide. Five of the six losers carry nothing; Ethanol's
fifteen-streak is absorbed as totals (a merge resets the streak by
contract) and its recovers were never matched.

**Node server, 7 tools**:

| Type | Created | ✓/✗, streak | Trusted | Skills |
|---|---|---|---|---|
| Methane | bootstrap | 30/11, 5 | yes | 5: build-persisted-json-api 34/16 (13 failures), build-in-memory-json-api 31/24 |
| Hemoglobin ("coding-theory exercise") | Sclereid, 10-03 | 14/0, 14 | yes | none |

Winner: Methane. Hemoglobin is a narrative label on the node signature and
holds no recipe.

**All eleven tools** — no canonical; three narratives born under the
eleven-tool cells a tissue created:

| Type | Created | ✓/✗, streak | Trusted | Skills |
|---|---|---|---|---|
| Adrenaline ("scheduling model… without tools") | Protoplast, 10-02 | 45/10, 39 | yes | 1 recover, unmatched |
| Insulin ("Bayesian urn analysis") | Trichome, 10-02 | 15/0, 15 | yes | none |
| Chlorophyll ("orbital mechanics lab") | Protoplast, 10-06 | 19/0, 19 | yes | 3: build-persistent-operations-dashboard 17/17, build-offline-assessment-workspace 3/3 |

Winner: Adrenaline as the elder, relabelled with the signature's canonical
label (the honest general-purpose one). Chlorophyll's dashboard recipe is
the one to keep. The same signature has two CELLS, Protoplast (114/0) and
Trichome ("Offline data-file remediation cell", 104/0), both trusted:
candidates on the same terms, Protoplast the elder.

**Benzene and Ammonia** are not a dedupe: different tools, both canonical.
Folding the project-docs canonical into the file scribe (the search tool and
its citation lines added when the host has docs) is the bootstrap change
the owner raised on 2026-10-10; it would merge 53/0 into 176/2 and move
Benzene's seven recipes.

**Tooling.** `registry dedupe` groups by NAME (a fuzzy key over the display
name), so it finds none of the groups above — they are chemistry names;
`AtomRegistry.mergeInto` does the merge and the CLI reached it only through
`dedupe`, which then DROPS the losers' skill namespaces. `registry merge
<winner> <losers…>` and `atoma_registry_merge` (`src/registry/mergeIdentities.ts`,
2026-10-10) do what the record asked: a pure plan, an archive of the store
and every touched namespace under `archives/registry-merge-<stamp>`, then
the losers' recipes MOVED under the winner (`SkillRegistry.moveNamespace`:
a moved recipe keeps its counters, the ledger receives a compensation on
its new entity; an id the winner holds is absorbed as `skills merge`
absorbs), then `mergeInto`, then an optional relabel.

**Winners, named 2026-10-10** (the owner delegated the naming):

| Winner | Absorbs | Relabel |
|---|---|---|
| Water | Glucose, Sucrose, Serotonin | — |
| CarbonDioxide | Ethanol, Methanol, Acetone, Caffeine, Dopamine, DNA | — |
| Methane | Hemoglobin | — |
| Adrenaline | Insulin, Chlorophyll | canonical (the eleven-tool general-purpose label) |
| Protoplast | Trichome | canonical |

Reasoning: the canonical of each signature wins where one exists, since the
bootstrap keeps its prompt current and its label is the signature's; where
none exists the elder wins and takes the canonical label. What it costs,
by contract: a merge resets the winner's streak, so Protoplast (114/0,
streak 100) and Adrenaline (streak 39) re-earn their three successes; the
absorbed recipes of Glucose (dashboard, 13/11), Serotonin (static-UI patch,
18/16) and Chlorophyll (dashboard, 17/17) move with their counters, and no
recipe id collides with its winner's. Ethanol's fifteen-streak and the
narratives' streaks are absorbed as totals.

**Executed 2026-10-10 05:53 UTC** through `atoma_registry_merge`, each
group dry-run first, no refusal, every one journaled (`registry.merged`)
and archived under `/home/atoma/state/archives/registry-merge-<stamp>`:
Water 77/13 (nine recipes moved, one absorbed), CarbonDioxide 80/24 (two
moved, one absorbed), Methane 44/11, Adrenaline 79/10 relabelled (three
moved, the dashboard recipe 17/1 among them), Protoplast 218/0 relabelled.
Tier 1 holds six molecules (Water, Methane, Ammonia, CarbonDioxide,
Benzene, Adrenaline), none trusted but Ammonia and Benzene until the
winners re-earn three successes. `atoma_ledger_check` afterwards: 20 types,
117 recipes, no impossible drift.

**Benzene and Ammonia stay two canonicals** (decided 2026-10-10, delegated).
A fusion at the bootstrap would put the docs-first prompt — consult the
snapshot before editing, cite digests and line spans — on every file write,
including the many without a project snapshot; Benzene searches the docs
twice per task where Ammonia writes at once, and the model itself takes
Ammonia 66 times to Benzene's 12. The Jev fold of the same day removes the
mass-splitting that was the measured cost of the pair, and `createOrRefresh`
keeps both current. Revisit if a reading shows deliveries that needed the
snapshot going to Ammonia.

What a planner writes in a create seed therefore persists nowhere any more:
the label is the signature's, the prompt the template, the tools the
parent's. The privacy tests that documented the opposite sharing now
document this; a validator's patch or branch still persists what it wrote.
