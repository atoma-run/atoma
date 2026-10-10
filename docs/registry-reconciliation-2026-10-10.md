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

## Decisions needed

1. Family reuse with template refresh: adopt, and does a refresh reset
   trust as a patch does?
2. Narrowing seeds (intersection) at both creation sites.
3. Labels by signature, the seed honoured for novel signatures only.
4. Dedupe of the present catalogue, with the owner naming winners.
