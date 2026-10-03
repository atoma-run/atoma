# Compiled scripts: no forced compilation, no browser — owner decision 2026-10-03

Status: decided, nothing built. Two proposals were examined against the
production catalogue and traces on 2026-10-03, and the owner closed both.
Neither is proposed again without new evidence that answers the reasons below.

## The question

Production held one compiled skill, while every other recipe stayed
`kind: llm`. The owner asked whether every recipe should be compiled into a
script after its first success, instead of waiting for it to accumulate
trust. One compiler refusal named browser tooling as its only obstacle, which
raised a second question: should compiled scripts get a browser?

## Production on 2026-10-03

Read through the MCP readers (`atoma_skills_list`, `atoma_skills_stats`,
`atoma_skills_show`, `atoma_ledger_tail`, `atoma_run_trace`):

- `thresholdsInForce.promote` is 0. There is no trust wait to remove:
  compilation already happens at learn time
  ([compile-at-learn record](compile-at-learn-2026-09-26.md)).
- The catalogue holds 50 recipes. 20 are event recoveries, which are never
  compiled. Of the 30 task recipes:
  - 1 is a script, `recheck-recorded-command-probes` (Ammonia). It was saved
    and compiled 46 s apart in the same run on 2026-10-01, before any credited
    success. Since then it has 9 matches, 3 successes and 1 direct failure.
  - 24 carry a compiler refusal stamp. 17 of the stamps come from an older
    compiler generation, so each of those recipes gets one more compile at its
    next credited success.
  - 5 carry no stamp. A revised body clears its stamp, and until 2026-10-01
    historical failures vetoed compilation. Each is assessed at its next
    credited success.
- The refusals fall into two families. Most say the recipe has to interpret
  the task: page content and design, tokenization and ranking rules, schemas,
  transition relations, where and how to edit a document. One,
  `serve-and-validate-static-page`, names browser tooling alone.

## Forcing compilation past a refusal: rejected

Compilation cannot happen earlier, and waiting longer would not change the
outcome: the 2026-08-07 threshold experiment found that the success count
never changed the compiler's verdict (the comment on
`TRUST_PROMOTE_THRESHOLD_SUCCESSES` in `src/atoms/cost.ts`). The only change
left would be to override the refusal, and that removes the one step that
judges content:

- A script receives the subtask as JSON-encoded text and can read it only
  with string matching. Each match of `build-self-contained-static-page` asks
  for a different page. A forced script would replay the first one or guess.
- A trusted script runs with no model call and no validator
  (`L2Atom.runSubtask`). It is credited at dispatch
  (`commitScriptSkillDirect`), and an upstream content rejection only keeps
  it from being dispatched again in the same run. Demotion needs two
  consecutive contract failures (a non-zero exit or a missing envelope) or an
  escalation while it is the active recipe. A script that exits 0 with a
  well-formed envelope and changes the named files is accepted unvalidated
  (`shouldTrustSkill`).
- The compile prompt records what forcing would bring back. A documentation
  script kept the invocation of the task it was learned on; a later
  Caesar-cipher CLI shipped a README whose examples printed the usage
  message, and every validator approved it.
- Matching is probabilistic. In run 822bb4fe (2026-10-02), Jev picked the one
  script at confidence 0.50 for a phase that then made nine file writes. The
  script failed its contract after about 2 s and the model loop took over.

The [hybrid skills record](archive/experiments/hybrid-skills-design.md)
(2026-08-11) was already the fifth attempt to make the compiled path pay.

## A browser for compiled scripts: rejected

A script has no browser. A compiled script is a Node program the host writes
with `write_file` and runs with `run_shell`, and it can call no element. The
browser is the Puppeteer instance that `validate_html` launches inside the
tool layer (`src/tools/builtin.ts`). `puppeteer` is the package's dependency,
not the workspace's, and the compiler forbids installing anything at runtime.
The static-web molecules that own these recipes have neither `fetch_url` nor
`start_node_server`, so the static scan refuses `fetch`, `node:http` and
sockets in their scripts (`src/skills/scriptScan.ts`). Such a script cannot
even request the page.

The refusal named tooling alone, but the recipe's "rendering smoke checks"
depend on the task when the page is new. With a browser, a script could only
run generic checks or replay recorded ones. Neither would help:

- **Its evidence would not count.** Only a `validate_html` call through the
  attesting executor produces a browser observation (`src/core/attestation.ts`).
  That observation is what covers a `dom-interaction` obligation
  (`checkProofCoverage`) and the root proof floor. What a script's own
  browser reports is self-report by model-authored code. Having the script
  call the element instead would mean tool calls with substituted arguments:
  the plan templating that [src/atoms](../src/atoms/AGENTS.md) rejects until a
  typed instantiation layer exists.
- **The generic checks cannot decide a pass.** The
  [inherited-checks replay](inherited-checks-replay-2026-10-01.md) does not
  let console errors and failed requests decide a check, because a font a
  network-none container cannot fetch, or one new `console.error`, would fail
  every check at once. Recorded checks also go stale as a page evolves: most
  of the pomodoro project's recorded checks targeted ids and test hooks the
  page no longer had. A replay needs a baseline taken when the run starts and
  a judge, which root acceptance already provides.
- **The gain is small.** `serve-and-validate-static-page` served six phases:
  fd64b07e, 5dff35b0, 04ea696f, 0a989a58, cc922a60 and fd557ba9. None
  re-checked an unchanged page. Three were build tasks the recipe does not
  fit, two were verification phases that opened by rewriting `index.html`
  whole, and one fixed a real bug its own validation found. The browser took
  about 2% of phase time: 4.8 s of a 243 s model loop in fd64b07e, and 35
  `validate_html` calls totalling 49 s over 39.7 min of phases in the other
  five. The model loop took the rest.

## Observed along the way, nothing opened

- `serve-and-validate-static-page` was credited in all six phases, including
  two whose output root acceptance refused (5dff35b0, cc922a60). Skill credit
  is recorded when the phase ends, before root acceptance, so the recipe's 6
  successes in 7 matches do not show that it did what it describes.
- The whole-file rewrites predate the existing-file rule (c2ed5921,
  2026-10-01). The read-only phase restoration now covers the case of
  04ea696f, whose verification phase declared no outputs.

## What would reopen this

- For compilation: a task decomposition whose phases do deterministic work,
  the condition [src/skills](../src/skills/AGENTS.md) already sets for new
  compiler work.
- For the browser: a typed instantiation layer for tool sequences, and
  evidence that phases re-checking an unchanged page are frequent enough to
  pay for it.
