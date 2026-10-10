/**
 * Shared prompt blocks that multiple layers consume. Extracted from
 * L2Atom (P7 slice): build-app.ts and the canonical seeders needed
 * SMOKE_DESIGN_GUIDANCE and had to import it FROM the supervisor class —
 * an examples→atoms→L2Atom dependency inversion that also dragged the
 * whole 2,800-line module into anything wanting one prompt constant.
 */
import type { Plan } from '../core/types.js';
import type { Atom } from '../core/atom.js';
import { SMOKE_TWO_CALL_LINES } from '../contracts/probeManifest.js';

/** Recovery must preserve the deliverable and verify its actual runtime. */
export const FALLBACK_VERIFICATION_GUIDANCE = [
  'Read existing files and previous phase evidence before changing anything. A verification task starts with read-only probes; preserve already verified behaviour.',
  'Verify the actual deliverable with the tools you hold. A page backed by a Node API must be checked against that Node server, not a replacement static server. Never fabricate static API responses to make a browser probe pass.',
  'If your tools cannot run or verify the existing artefact, preserve it and report the missing capability and unverified behaviour in the final JSON. Do not rewrite it into a different kind of artefact to fit your tools.',
  'When browser validation is available and required, validate the actual served URL and report its observed result. Repair an observed defect only when you can re-run the relevant checks.',
].join('\n');

/**
 * Shared smoke-test design guidance. Appended to every L1 system
 * prompt that the supervisor controls — both the one `createSubtaskL1`
 * emits on fresh-L1 creation and the one `buildNarrowL1Prompt` emits
 * on escalation branches. Keeping this block identical in both paths
 * means a new L1 starts with the same smoke discipline as a branched
 * one: IIFE-only, `window.__test` hooks for state-heavy apps, no
 * simulated-input cargo-culting.
 *
 * Earlier runs ran into two persistent pain points that this block
 * addresses:
 *   (1) smokes written as top-level statements (`const x = ...; x > 0`)
 *       which don't parse inside the tool's `(${smoke})` wrapper and
 *       cost a full Puppeteer round-trip per mistake;
 *   (2) smokes that try to reproduce domain-specific winning paths via
 *       simulated clicks — observed burning 15+ rounds on a chess
 *       puzzle asserting `statusText.includes('Checkmate')` after
 *       random clicks that could not produce a mate.
 */
/**
 * The "one smoke, all the claims" example.
 *
 * Its `ok` asserts the STYLING it returns, which is not decoration: when a
 * smoke returns a class/style/colour value that the aggregate `ok` does not
 * assert, `validate_html` forces ok=false with "class/style/color values were
 * returned but the aggregate ok expression does not assert them"
 * (builtin.ts), and `tests/contracts.test.ts` pins that shape as
 * non-compliant. The previous version of this example returned
 * `colour: getComputedStyle(...).color` beside an `ok` asserting only
 * counters — the exact refused shape — so a model following the block's
 * flagship template was rejected on a page that was correct. Measured
 * 2026-08-21: that refusal fired in all four burn-in batches.
 *
 * Exported and pinned by `tests/smoke-guidance.test.ts` against the real
 * pre-flight guards and against `smokeOkIncludesStyling`.
 */
export const SMOKE_MULTI_CLAIM_EXAMPLE = [
  `(() => {`,
  `  const bar = document.querySelector('#bar');`,
  `  const checks = {`,
  `    pctReached:  window.__test.percentage === 75,`,
  `    cellCount:   document.querySelectorAll('.cell').length === 64,`,
  `    firstCell:   !!document.getElementById('cell-0'),`,
  `    barClassSet: bar.classList.contains('filled'),`,
  `  };`,
  `  return { ok: Object.values(checks).every(Boolean), checks,`,
  `           pct: window.__test.percentage,`,
  `           cells: document.querySelectorAll('.cell').length,`,
  `           barClass: bar.className };`,
  `})()`,
].join('\n');

/**
 * The canonical state-driving smoke: drive the widget's own API, snapshot
 * each milestone, return one aggregate verdict.
 *
 * ASYNC BY DEFAULT since 2026-08-21, and that is the whole point. A
 * synchronous smoke holds the JS task, so NOTHING the page updates
 * asynchronously can be observed by it: CSS transitions have not advanced,
 * and `setInterval` / `requestAnimationFrame` repaints have not run. Two
 * burn-in tasks lost real money to that on 2026-08-21 (see
 * SMOKE_DESIGN_GUIDANCE for both measurements), each asserting a claim that
 * could not become true inside one task. The `settle()` await is what makes
 * the copied template correct instead of subtly unobservable.
 *
 * Exported and pinned by `tests/smoke-guidance.test.ts` against the real
 * validate_html pre-flight guards, like SMOKE_ASYNC_TRANSITION_EXAMPLE.
 */
export const SMOKE_CANONICAL_STATE_SHAPE = [
  `interactions: []`,
  `smoke: (async () => {`,
  `  const settle = () => new Promise((r) => setTimeout(r, 400));`,
  `  const w = window.__testOrWidget;`,
  `  w.reset(); await settle();`,
  `  const initial = { value: w.value, className: exactElement.className,`,
  `                    text: exactElement.textContent };`,
  `  for (let i = 0; i < thresholdFromContract; i++) w.increment();`,
  `  await settle();  // let the timer/rAF repaint AND any transition finish`,
  `  const milestone = { value: w.value, className: exactElement.className,`,
  `                      text: exactElement.textContent };`,
  `  w.reset(); await settle();`,
  `  const reset = { value: w.value, className: exactElement.className };`,
  `  const checks = {`,
  `    milestoneValueMatches: milestone.value === thresholdFromContract,`,
  `    milestoneStyleMatches: milestone.className === classFromSource,`,
  `    milestoneTextRepainted: milestone.text !== initial.text,`,
  `    resetMatches: reset.value === initial.value &&`,
  `                  reset.className === initial.className,`,
  `  };`,
  `  return { ok: Object.values(checks).every(Boolean), checks,`,
  `           initial, milestone, reset };`,
  `})()`,
].join('\n');

/**
 * The canonical async smoke for reading a TRANSITIONED computed value.
 *
 * Exported as a CONSTANT rather than left as prose inside the guidance
 * because guidance that teaches a smoke the tool would refuse is worse than
 * no guidance: `tests/smoke-guidance.test.ts` feeds this exact string to the
 * real validate_html pre-flight guards, so a future edit to either side
 * cannot silently start advertising a rejected shape.
 */
export const SMOKE_ASYNC_TRANSITION_EXAMPLE = [
  `(async () => {`,
  `  const before = getComputedStyle(el).color;`,
  `  el.click();`,
  `  await new Promise((r) => setTimeout(r, transitionMsFromSource + 100));`,
  `  const after = getComputedStyle(el).color;`,
  `  const checks = { colourChanged: after !== before };`,
  `  return { ok: Object.values(checks).every(Boolean), checks, before, after };`,
  `})()`,
].join('\n');

export const SMOKE_DESIGN_GUIDANCE = [
  `== SMOKE-TEST DESIGN (read carefully — this is where runs go wrong) ==`,
  `The \`smoke\` arg of validate_html is evaluated inside`,
  `  (() => { const __r = (YOUR_CODE); return __r; })()`,
  `so YOUR_CODE must be a pure EXPRESSION. These ALL break parsing:`,
  `    const x = 1; x > 0         // top-level \`const\``,
  `    return x > 0               // top-level \`return\``,
  `    if (cond) { return true }  // top-level \`if\``,
  `Wrap any logic in an IIFE when you need locals or statements:`,
  `    (() => { const x = compute(); return x > 0 })()`,
  `    (function(){ /* ... */ return result })()`,
  ``,
  `== ONE SMOKE, ALL THE CLAIMS — validate_html is your MOST EXPENSIVE tool ==`,
  `Every call re-launches the page, waits for network idle and replays`,
  `your interactions: SECONDS per call. So a smoke must not check ONE`,
  `thing. Return a structured OBJECT that answers EVERY question you`,
  `have about the page, in a single call, with an explicit aggregate \`ok\`:`,
  ...SMOKE_MULTI_CLAIM_EXAMPLE.split('\n').map((line) => `    ${line}`),
  `The whole object comes back in \`smokeResult\`, and explicit \`ok === true\``,
  `is authoritative. Fold EVERY required task claim into that expression.`,
  `ANY class, style or colour value you RETURN must also be asserted by \`ok\`:`,
  `returning one as a bare diagnostic forces ok=false with "class/style/color`,
  `values were returned but the aggregate ok expression does not assert them",`,
  `on a page that may be perfectly correct. Put it in \`checks\`, not beside it.`,
  `Raw state fields may legitimately be false (for example`,
  `initial.thresholdReached=false); they are diagnostics, not assertions.`,
  `Keep smokeResult replay-stable: never return raw timestamps, generated ids,`,
  `ephemeral ports or locale-formatted dates. Return deterministic booleans,`,
  `counts and source-defined labels; expected records the whole result exactly.`,
  `If you omit \`ok\`, the structured object fails validation.`,
  `Two reasons this is strictly better than one assertion per call:`,
  `  1. COST — one page load`,
  `     tells you everything; twenty tell you the same thing twenty`,
  `     times. Measured: a habit-tracker run made 66 validate_html calls`,
  `     with 64 different smokes, 45 of them PASSING — one element`,
  `     verified per browser round-trip, ~9 minutes of pure page loads`,
  `     for what two calls would have answered.`,
  `  2. DIAGNOSIS — when a bare boolean fails you are told only`,
  `     "smoke check failed: false", which cannot tell you whether YOUR`,
  `     ASSERTION was wrong or the PAGE is broken. A failing object`,
  `     comes back with its values, so you can see it yourself.`,
  `Budget: a healthy web run needs a HANDFUL of validations — build,`,
  `validate, fix what the values revealed, re-validate. If you are past`,
  `five, you are enumerating instead of asserting: collapse your`,
  `remaining checks into ONE object smoke and read the result.`,
  `If previousStepSummary supplies a live loopback URL from a Node server,`,
  `validate that URL directly. Do NOT start_static_server on server.js or the`,
  `workspace root: it serves a directory listing, not the embedded dynamic UI.`,
  `For every interaction selector, READ the current HTML and copy the exact`,
  `id/class byte-for-byte. Never infer kebab-case from a camelCase property`,
  `or invent a plausible selector: "#increment-btn" does not match`,
  `id="incrementBtn", and one guessed selector invalidates the whole replay.`,
  `For form text, use interaction {type:"type", selector:"#field", text:"..."}.`,
  `For a file input, write the file first, then {type:"upload", selector:"#file",`,
  `file:"sample.csv"}: clicking a file input opens a chooser nobody can answer.`,
  `keypress accepts ONE key name (Enter, ArrowRight, "a"), never a full string`,
  `such as "Test User"; submit only after typing every required field.`,
  `Derive expected labels and state thresholds from the TASK CONTRACT.`,
  `Read source for selectors and implementation details the task leaves open.`,
  `Never copy an implementation value into the expectation when the task`,
  `specifies a different value: that would test the bug against itself.`,
  `Do not invent plausible states ("On Fire", "Keep Going") when the artefact`,
  `actually defines different values ("Beginner", "Building").`,
  `When exposing state through a getter, keep one writable backing field`,
  `(\`this._streak\`) and mutate that field everywhere. Never assign to a`,
  `getter-only property (\`this.streak = 0\` beside \`get streak()\`) — the`,
  `page throws before the smoke can run. Before serving, enumerate EVERY`,
  `\`get name()\` in the source and verify there is no \`this.name =\`,`,
  `\`this.name++\` or \`this.name--\`; derived labels such as statusText are`,
  `getter results, not writable state. Also scan for duplicate method/getter`,
  `names introduced during a fix; keep one definition.`,
  `Interaction arrays run COMPLETELY before smoke, and supplying them beside a`,
  `smoke that drives state ITSELF discards every one of them — the two are`,
  `MUTUALLY EXCLUSIVE, so choose per call. A sequence that increments, toggles`,
  `twice, or resets exposes only the final state, so it proves nothing about`,
  `the intermediate styling. To verify both in one call, drive inside a smoke`,
  `IIFE with \`interactions: []\`, snapshot the milestone state, reset,`,
  `snapshot again,`,
  `and return both objects. When the task names styling, each snapshot MUST`,
  `include the actual class/style/color value and \`ok\` must compare the`,
  `milestone and reset styling — counters or status labels alone are insufficient.`,
  `If the control has NO exposed method, click the element itself inside the`,
  `same IIFE (\`document.getElementById(idFromSource).click()\`) — that still`,
  `counts as driving your own state, so the interaction array must be empty.`,
  `A self-driving smoke executes NO real interaction: with \`interactions: []\``,
  `nothing is clicked or typed, and beside it every listed interaction is`,
  `DISCARDED, so the transport record reads executed=0. A phase that declares`,
  `the "dom-interaction" proof obligation therefore stays UNCOVERED on that`,
  `shape however complete its snapshots, and the method earns no credit. Under`,
  `that obligation use REAL selector-based interactions and a READ-ONLY smoke,`,
  `in TWO calls, because one list that repeats a control and then resets is`,
  `refused pre-flight: call 1 replays the state-changing control up to the`,
  `milestone and asserts it; call 2 changes state ONCE, resets, and asserts the`,
  `initial state. Both calls are accepted and both execute their interactions:`,
  ...SMOKE_TWO_CALL_LINES.map((line) => `  ${line}`),
  `The shape below is the SELF-DRIVING call, for state logic no real input has to prove.`,
  `Use this canonical shape instead of inventing a new sequence each time:`,
  ...SMOKE_CANONICAL_STATE_SHAPE.split('\n').map((line) => `  ${line}`),
  `Read CURRENT source for exactElement id and class names; derive thresholds`,
  `and required labels from the task. Check the rendered effect when the task`,
  `requires appearance: a toggled class alone does not prove its CSS works.`,
  `THE settle() AWAIT IS BOUNDED: it exists to let ONE repaint or transition`,
  `land — hundreds of milliseconds. It is NOT a way to wait for real time to`,
  `pass. The browser runs in REAL TIME and cannot fast-forward, and a smoke`,
  `still running after 30s is KILLED and returns NOTHING at all.`,
  `MEASURED 2026-08-21: a 30-second countdown task awaited 33s and 35s inside`,
  `two smokes; both were killed, each having burned ~45s of wall clock, and the`,
  `run then failed on its whole budget. If your claim needs the clock to move,`,
  `do NOT wait for it — expose window.__test.advance(ms) from the app (move its`,
  `internal time AND repaint), drive that from the smoke, and assert the state`,
  `it produces. Same rule as keypress holdMs: real time is never the tool.`,
  ``,
  `== A SYNCHRONOUS SMOKE SEES ONLY WHAT THE PAGE ALREADY COMMITTED ==`,
  `THE LAW: your smoke holds the JS task while it runs. Anything the page`,
  `updates ASYNCHRONOUSLY therefore cannot be observed by it — CSS transitions`,
  `have not advanced, and \`setInterval\` / \`requestAnimationFrame\` repaints`,
  `have not run. Internal state read from a hook advances (it is computed on`,
  `demand); the DOM the user would see does not. Assert one against the other`,
  `and you have written a claim that CANNOT become true, however many times`,
  `you retry it.`,
  `Both halves were measured on 2026-08-21, in two different batches:`,
  `  CSS TRANSITION. \`#count{transition:all .3s ease}\` +`,
  `  \`#count.negative{color:red}\`, VERIFIED in Chrome:`,
  `      synchronous read -> { cls:true, computed:"rgb(51, 51, 51)" }   STALE`,
  `      after await 400ms -> { cls:true, computed:"rgb(255, 0, 0)" }   settled`,
  `  The click-counter run spent 19 validate_html calls and $0.52 of execute`,
  `  tokens here: five consecutive smokes asserted the computed colour, each`,
  `  received the stale value, and the model "repaired" its already correct CSS`,
  `  by adding \`!important\` — which does nothing to an animation.`,
  `  TIMER REPAINT. A stopwatch smoke returned`,
  `      { elapsed: 988, running: true, display: "00:00.00",`,
  `        innerHTML: "00:00.00", textContent: "00:00.00" }`,
  `  — the clock advanced because getElapsedMs() reads Date.now(), while the`,
  `  display stayed at zero because the setInterval tick that writes it never`,
  `  got to run. That run cost 18 validate_html calls and 404s.`,
  `So: if the claim involves a repaint, an animation or a timer, the smoke MUST`,
  `await. The canonical shape above already does; keep its \`settle()\`.`,
  `For a STYLING claim specifically, in order of preference:`,
  `  1. ASSERT THE MARKER THE SOURCE TOGGLES — \`classList.contains('negative')\``,
  `     or the inline \`el.style.color\` the script assigns. Deterministic, no`,
  `     timing, and it is what the pre-flight guard means by "the exact`,
  `     source-defined class/style marker".`,
  `  2. Only if the COMPUTED value is itself the claim, make the smoke async and`,
  `     wait past the declared duration — the tool awaits your promise. The`,
  `     example below proves ONLY a change, not a task-specified target colour:`,
  ...SMOKE_ASYNC_TRANSITION_EXAMPLE.split('\n').map((line) => `         ${line}`),
  `Never compare a computed value to an rgb()/rgba() LITERAL: that smoke is`,
  `refused pre-flight, before the page is even loaded. Compare milestone`,
  `against the captured initial value only for a CHANGE claim. For a named`,
  `target colour, compare against a browser-normalized reference styled with`,
  `the task-specified colour; do not weaken the requirement to "different".`,
  ``,
  ``,
  `== STATE-HEAVY APPS: deterministic setup, then prove the required path ==`,
  `For games with rules (chess, minesweeper, roguelikes), for`,
  `multi-step flows (wizards, forms with validation), or for any app`,
  `whose success criterion needs domain-specific knowledge, prepare a known`,
  `scenario rather than searching blindly through clicks or keypresses.`,
  `Random clicks on a chess board will never produce a checkmate, and`,
  `the smoke loop will grind for many rounds with the same false`,
  `assertion (observed in production: 15+ wasted Puppeteer rounds`,
  `asserting \`statusText.includes('Checkmate')\` after arbitrary`,
  `clicks).`,
  `Instead, EXPOSE a deterministic test hook from the app code:`,
  `    window.__test = {`,
  `      forceState(scenario) { /* seed the exact position */ },`,
  `      checkInvariant() { /* return bool for the claim you verify */ },`,
  `    };`,
  `This is an INTERNAL invariant check, not proof that user input works:`,
  `    (() => { window.__test.forceState('mate-in-1-back-rank');`,
  `             return window.__test.checkInvariant(); })()`,
  `When the task requires a user action, also prove that action via real`,
  `selector-based interactions and a read-only smoke on the resulting DOM.`,
  `Set up the scenario before that call (for example in test-mode startup);`,
  `a self-driving smoke would discard the external interactions.`,
  `Keep state-changing test hooks behind an explicit test-only flag. Their`,
  `size does not establish safety or prove real user input. Validate_html will echo`,
  `coaching hints back to you when it rejects a smoke pre-flight or`,
  `detects the same smoke failing repeatedly; read and act on them.`,
  ``,
  `== SMOKE-LOOP DISCIPLINE ==`,
  `If the SAME smoke assertion fails more than twice, STOP retrying`,
  `it unchanged. Re-read the contract, source and observed failure before`,
  `choosing a test hook to prepare state (not to bypass user input), or a`,
  `different probe of the SAME required behaviour. Never replace the required`,
  `assertion with element existence or declare it verified without evidence.`,
  `Repeated failure may be a real defect OR a faulty test; diagnose which.`,
  `If the budget or tools cannot establish the requirement, return final JSON`,
  `that explicitly reports the failed or unverified requirement, not success.`,
  `Interleaving a trivially-passing sanity smoke between real-retry`,
  `smokes does NOT reset the stuck detector — it is cumulative over`,
  `a sliding window.`,
].join('\n');

/**
 * Shared plan-time rule for file-mutating phases.
 *
 * A trusted script can return before any validator runs. Its match-time guard
 * can refuse a read-only verifier only when the subtask names the file it is
 * supposed to change. "Harden the existing CLI" carries no such witness;
 * "Harden index.js" does. The expense-splitter burn-in demonstrated the
 * consequence: a verifier replayed old probes, skipped the requested --help
 * and input-validation work, and the trusted path credited success.
 */
export const MUTATING_SUBTASK_FILE_GUIDANCE = [
  `== FILE-MUTATING SUBTASKS NAME THEIR TARGETS ==`,
  `Whenever a subtask asks to create, update, harden, fix, rewrite or document`,
  `a file, name the exact intended output path in that subtask description`,
  `(for example "harden index.js" or "write README.md from package.json").`,
  `A phrase like "harden the existing CLI" is UNDERSPECIFIED: a downstream`,
  `read-only verifier can look applicable and replay old probes while changing`,
  `nothing. File paths are OUTCOMES, not tool invocations, so this does not`,
  `conflict with the rule against hard-naming tools. The plan owns stable`,
  `filenames; choose them in the first build phase and repeat them in every`,
  `later phase that must mutate those files.`,
  `For a CLI that a later phase will package or name, choose a SEMANTIC entry`,
  `filename derived from its behavior (for example "csv2json.js"), never a`,
  `generic launcher such as "index.js", "main.js", "cli.js" or "app.js".`,
  `A generic path leaves deterministic packaging no honest product/bin name`,
  `and forces the full LLM fallback even when every invocation is verified.`,
  `MUST declare the same intent STRUCTURALLY: every file-mutating subtask`,
  `carries "outputs": [<exact workspace-relative paths it creates or`,
  `modifies>]. List OUTPUTS only — never inputs it merely reads ("update`,
  `README.md from package.json" declares outputs ["README.md"]). Omit the`,
  `field entirely on read-only subtasks (verification, re-running recorded`,
  `probes). Omitting "outputs" on a mutating phase is a plan defect. The`,
  `runtime treats a declared list as authoritative for its dispatch gates.`,
].join('\n');

/**
 * DECLARED PROOF OBLIGATIONS. Deliberately terse, and deliberately part of
 * the planning prompt rather than a detector over the phase description: a
 * mechanical "the word click implies a DOM obligation" rule is the
 * vocabulary-frozen detector class the 2026-08-14 review measured as a
 * primary source of drift. The vocabulary is closed with one member, so this
 * costs a handful of output tokens on the phases that need it and nothing
 * anywhere else.
 */
export const PROOF_OBLIGATION_GUIDANCE = [
  `PROVING USER INPUT WORKS. When a phase's verification depends on REAL user`,
  `input reaching the page — a button that must actually respond to a click,`,
  `a field that must accept typing — declare it structurally on that subtask:`,
  `"proofObligations": ["dom-interaction"]. It is the ONLY accepted value;`,
  `omit the field everywhere else.`,
  `What it changes: the supervisor checks that the browser tool actually`,
  `EXECUTED an interaction, from the tool's own transport record. A smoke`,
  `expression that drives the page through its own \`window.*\` hooks proves`,
  `the internal path and NOT the input path, and the runtime discards every`,
  `external interaction when the smoke drives its own state — so a phase that`,
  `declares this obligation must reach the affordance through selector-based`,
  `interactions, not through a test hook.`,
  `A key that must be ignored in a control the page never renders (a text field,`,
  `a textarea) is proven by a smoke that creates that control: say so in the`,
  `subtask, never "real input" into such a control or adding it to the page.`,
  `Declaring it separates artifact approval from method credit; leaving it out`,
  `when the task names user input leaves that method`,
  `unproven WITHOUT activating this credit guard. Only a DECLARED but`,
  `uncovered obligation withholds method credit. Declare it whenever required.`,
].join('\n');

/**
 * RECORDED PROOF IS STANDING PROOF, at plan grain. Run `cc894dad`
 * (2026-09-21, docs/incidents/progressive-runs-2026-09-21.md) planned
 * implement → comprehensive re-audit → README as three sequential phases: the
 * re-audit re-proved what the build phase had already recorded (~$2.51 and
 * ~1573 s of an 1800 s deadline across three executions of one molecule) and
 * the README phase timed out before its first tool call, so three credited
 * phases delivered nothing. The within-phase half of this rule is the
 * validation ledger (docs/incidents/verification-replay-2026-09-15.md); this
 * is the between-phases half. Landed on the operator's 2026-09-21 decision
 * against the collected backlog set, not against a single run.
 */
/**
 * WHAT A LANDED RESULT IS, said to the judge that decides its fate.
 *
 * A run that reaches its budget with phases already accepted reports those
 * instead of discarding them (`markLanded`, `src/atoms/dispatch.ts`), and its
 * summary opens with INCOMPLETE. Root acceptance then judges it — always
 * through a validation call, because a landed run stopped before it could
 * prove the delivery floor, so `floorCoverage` is uncovered by construction.
 *
 * Until 2026-09-24 that judge was told nothing about landings. Everything it
 * knew came from the executor's own summary, while the only statement the host
 * made about incompleteness was "a visually-incomplete artefact is a failed
 * deliverable" — scoped to visual artefacts, but the only hint there was, and
 * it pointed at rejection. Characterised in `tests/depth-routing.test.ts`.
 *
 * The wording follows the analyst's, deliberately: one definition of a landing,
 * served to both judges rather than restated differently in each.
 */
export const LANDED_RESULT_GUIDANCE: string = [
  '== THIS RESULT LANDED ON THE RUN BUDGET ==',
  'The run reached its wall-clock budget with phases already accepted, and',
  'reported those instead of discarding them. Its deliverable is REAL and',
  'INCOMPLETE, it names the phases that never ran, and it is NOT a failure.',
  'Judge the phases it DID complete on the same terms as a delivery: do not',
  'reject it for being incomplete, and do not approve it for having landed.',
  'Reject it only if the work it DOES claim fails on its own evidence, or if',
  'the phases it reports as accepted were not in fact accepted.',
].join('\n');

export const STANDING_PROOF_PLANNING_GUIDANCE = [
  `== RECORDED PROOF IS STANDING PROOF ==`,
  `Verification belongs INSIDE the phase that builds or changes an artefact,`,
  `and the probes that phase records stay valid until a later phase mutates`,
  `that artefact. Do NOT plan a phase whose only purpose is re-running or`,
  `broadly re-auditing evidence an earlier phase already recorded: it buys no`,
  `new proof and spends the run's fixed deadline that the remaining phases`,
  `(documentation, packaging) still need. A later read-only phase may cite the`,
  `recorded probes instead of re-running them; re-verify ONLY what a mutation`,
  `since the record invalidated.`,
].join('\n');

/**
 * What a delivered document leaves out: what a verification observed. Owner
 * decision 2026-09-30, after run cdc34023's README closed on a "Verification
 * evidence" section — smoke values, a SHA-256, line numbers and quotes of the
 * source — and earlier READMEs of the same project listed "`1499` seconds
 * remaining" beside each button. The evidence is real; its reader is the
 * validator, through the result's summary, not the person who opens the
 * README.
 *
 * It covers what an earlier check left in a document too (owner decision
 * 2026-10-01). Runs 1ed071e3 and 9854553c wrote clean sections and kept, as
 * "unrelated content", the evidence sections earlier runs had written: one
 * cited the SHA-256 and line numbers of a page that no longer existed, the
 * other listed the probes of every flag but the new one, and was the only
 * place stating the CLI's error messages.
 *
 * RUNTIME TEXT, not a stored prompt: every molecule with a file-writing tool
 * reads it when it plans and when it executes (`L1Atom`), as it reads the
 * scratch rule, and so do a cell or tissue executing their own plan with
 * tools. The stored prompts of molecules created before the rule never
 * carried it, trusted ones included (review 2026-10-01). No planner does.
 */
export const READER_FACING_DOC_GUIDANCE = [
  `A DOCUMENT IS FOR ITS READER. README and docs say what the artefact does and`,
  `how to use it. What a verification OBSERVED — measured values, smoke or probe`,
  `results, digests, line numbers, quotes of the artefact's code, "verified" or`,
  `"confirmed" notes — is run evidence: report it in your summary, never in a`,
  `document you deliver, unless the task asks that document to record it. Usage`,
  `examples, example output, exit codes, statuses and the versions or platforms`,
  `it supports are behaviour: state them as what the artefact does, never as what`,
  `a check observed. An example output you add is copied from a tool result of`,
  `this run (a command or request you ran, or an entry this run recorded), never`,
  `composed; a port, time or path that changes between runs shows as a`,
  `placeholder, and an example nothing in this run printed shows its command`,
  `alone.`,
  `When the task has you write or update a README or other doc (never a page,`,
  `code or data file), remove what an earlier check left in it, wherever it sits:`,
  `a verification or probe evidence section, a digest or line numbers cited as`,
  `proof of a check, a single "verified" or "observed" line. Remove it even where`,
  `it still holds, and do not copy it into your summary. Restate, from the`,
  `current source code or this run's`,
  `recorded probes (never by re-running them), any exit code or error message`,
  `documented only there. Keep such a record only when the task asks that`,
  `document to keep or record it; an instruction to preserve unrelated or`,
  `existing content does not. A document or section that exists to record`,
  `results (a test report, a benchmark or verification log, a changelog) keeps`,
  `its entries. .atoma-probes.json is a record, not a document: none of this`,
  `touches it.`,
].join('\n');

/**
 * THE rule for a file that exists, one definition: read at RUNTIME by every
 * molecule with edit_file when it plans and executes and by the fallback
 * executors (`EXISTING_FILE_GUIDANCE`), and carried by the recipe blocks'
 * limits (src/skills/events.ts). Stored prompts of molecules created before a
 * canonical prompt changed never carried it: in run 495c20ef (2026-10-01) a
 * trusted web molecule, in a correction phase, wrote the restored page again
 * whole and changed its tab title and its controls; in 5dff35b0 a recipe's
 * "write_file the complete source" lost a countdown.
 */
export const EXISTING_FILE_RULE: readonly string[] = [
  `Never write_file over a file the workspace already holds, even where your instructions or a recipe step say to:`,
  `change it with edit_file, only where it must change. Restoring a behaviour is an edit. Two exceptions, each after`,
  `reading the file: the subtask says to replace, rebuild or redesign that file as a whole, and you keep every id, hook,`,
  `label and behaviour it does not ask to change; or you put back what your own checks changed. .atoma-probes.json is`,
  `outside this rule.`,
];
export const EXISTING_FILE_GUIDANCE = EXISTING_FILE_RULE.join('\n');

/**
 * A control the page does not have, needed only to test a behaviour, lives
 * in the smoke, and the call's interactions set up what the key would change.
 * Run 81375f01 (2026-10-01): a plan asked to prove a shortcut is ignored in a
 * text field and a textarea the page has none of, and the web molecule added
 * hidden ones to the page, undoing the run before it. Run ff102525: told to
 * create them in the smoke, and also that a self-driving smoke never counts
 * as dom-interaction proof, it oscillated for 999 s between the two and left
 * them in. A smoke that only creates, focuses, keys and removes its own
 * element calls no state-changing method (`smokeDrivesOwnState`), so the
 * interactions run and the one call is real interaction; the validator
 * prompt and the obligation lines say the same, and
 * tests/smoke-two-call-coverage.test.ts feeds the call through the guards
 * and the coverage check.
 */
export const TEST_ONLY_ELEMENT_GUIDANCE = [
  `- A page element you need ONLY to exercise the page (a text field or textarea to prove a shortcut is`,
  `  ignored there) never goes into a file you deliver: the page never renders it, so no interaction`,
  `  reaches it. Prove it in one validate_html call, once the page's other checks pass. Its interactions set`,
  `  up the state the key would change; the page's own controls, a select included, are driven only by`,
  `  interactions. Its smoke creates the element, styles it inline off-screen (never display:none, hidden`,
  `  or disabled), appends it, focuses it with .focus(), dispatches the key ON it with bubbles: true, and`,
  `  removes it before returning. Its ok needs the element focused when the key goes, the state before`,
  `  the key to be the one the interactions made, and the key to leave it so. Never .click() it or add a`,
  `  class to it: the runtime then drops the interactions. A false self-check means fix the smoke, never`,
  `  the page.`,
].join('\n');

/** The one rule, for any server this run starts: its port dies with it. */
const PORT_PLACEHOLDER_LINES = [
  `HTTP DOCUMENTATION USES A PORT PLACEHOLDER. In README/docs and durable`,
  `example commands, write \`http://localhost:<port>\`, never the numeric port`,
  `assigned to the current server process. That number dies with the process.`,
];

/**
 * The same rule for a page `start_static_server` serves. The root acceptor
 * refuses a README holding this run's loopback port (`groundTruth.ts`,
 * `DURABLE_HTTP_PORT_LITERAL_RE`) whichever molecule wrote it, and until
 * 2026-09-26 only the HTTP and full-stack molecules were told: the static-web
 * one wrote its measured URL into the README twice in production (runs
 * cc922a60 and 5a5f1e27), the second time after being handed the first
 * refusal.
 */
export const STATIC_PORTABLE_DOC_GUIDANCE = [
  ...PORT_PLACEHOLDER_LINES,
  `The URL start_static_server returned belongs in run evidence/results only,`,
  `never in README or docs: a README the task asks to record measurements names`,
  `the page and the widths, not the port it was served on. The review flags ANY`,
  `numeric loopback port in docs, a conventional one such as \`localhost:8000\``,
  `too, unless the task itself requires that fixed port: write \`localhost:<port>\`.`,
].join('\n');

/**
 * The same rule for the file scribe, which writes a documentation phase. It
 * starts no server, but its inputs carry the URL the previous phase served:
 * run 8606cf38 (2026-09-30) wrote `http://localhost:43977/` into README.md as
 * "the static page entry point used for verification", the review refused
 * it, and the phase ran a second time.
 */
export const SCRIBE_PORTABLE_DOC_GUIDANCE = [
  ...PORT_PLACEHOLDER_LINES,
  `A URL or port an earlier phase reports ("served at", a bound URL,`,
  `LISTENING_ON_PORT=<N>) is run evidence: cite it in your summary, never in`,
  `README or docs, where it reads \`http://localhost:<port>\` and`,
  `\`LISTENING_ON_PORT=<port>\`. The review flags ANY numeric loopback port in`,
  `docs, unless the task itself requires that fixed port.`,
].join('\n');

/** Runtime guidance also reaches agents whose stored prompt predates CLI support. */
export const HTTP_STARTUP_GUIDANCE = 'Preserve a task-defined server CLI and readiness format. start_node_server accepts literal args and, from a CLI started with them, a JSON {"port":N} readiness line as well as LISTENING_ON_PORT=<N>. If reusable instructions mandate the latter or require a no-argument entry, the current tool declaration supersedes that convention; do not add unwanted stdout or application defaults merely to fit the tool.';

/** Durable HTTP docs must not capture the one port assigned to this run. */
export const HTTP_PORTABLE_DOC_GUIDANCE = [
  ...PORT_PLACEHOLDER_LINES,
  `The stdout marker is portable the same way: document`,
  `\`LISTENING_ON_PORT=<port>\`, never a captured value such as`,
  `\`LISTENING_ON_PORT=59420\`.`,
  `The live bound URL belongs in run evidence/results only, not documentation.`,
].join('\n');

export const LITERAL_CONTRACT_PRESERVATION_GUIDANCE = [
  `== PRESERVE LITERAL CONTRACTS ACROSS DECOMPOSITION ==`,
  `A subtask may narrow SCOPE but must never rename, replace or summarise away`,
  `the user's exact routes, JSON field names, types, formats, status codes or`,
  `fixed literals. "Implement proper validation" is not a substitute for`,
  `\`POST /labels {"name":string,"color":"#RRGGBB"}; reject blank/wrong/malformed`,
  `with 400\`. Repeat the exact contract in BOTH the build and verification`,
  `subtasks that consume it. Never fill an omitted schema from a familiar recipe.`,
].join('\n');

const LITERAL_CONTRACT_MARKER = '== LITERAL CONTRACTS FROM TOP-LEVEL GOAL ==';

export function stripLiteralContractBlock(description: string): string {
  const marker = description.indexOf(LITERAL_CONTRACT_MARKER);
  return marker >= 0 ? description.slice(0, marker).trim() : description;
}

export function extractLiteralContractClauses(description: string): string {
  const inherited = description.indexOf(LITERAL_CONTRACT_MARKER);
  if (inherited >= 0) return description.slice(inherited + LITERAL_CONTRACT_MARKER.length).trim();
  if (!/(?:\{[^{}\n]{1,300}\}|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+)/i.test(description)) {
    return '';
  }
  const clauses = description
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        /(?:\{[^{}]{1,300}\}|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+|\b(?:reject|required?|must|only|status\s+\d{3}|malformed|wrong\s+type)\b)/i.test(
          clause
        )
    );
  return [...new Set(clauses)].join('\n').slice(0, 1600);
}

export function preservePlanLiteralContracts(plan: Plan, taskDescription: string): Plan {
  const clauses = extractLiteralContractClauses(taskDescription);
  if (!clauses) return plan;
  const block = `${LITERAL_CONTRACT_MARKER}\n${clauses}`;
  return {
    ...plan,
    subtasks: plan.subtasks.map((subtask) =>
      subtask.description.includes(LITERAL_CONTRACT_MARKER)
        ? subtask
        : { ...subtask, description: `${subtask.description}\n\n${block}` }
    ),
  };
}

/** System role used only for last-resort direct execution, never persisted. */
export const FALLBACK_SYSTEM_PROMPT = [
  'You are the direct executor in a recovery turn. Normal supervisor delegation is disabled.',
  'Plan concrete actions, then execute with ONLY the tools declared on this request. Never delegate.',
  'With no tools, provide reasoning only and explicitly report what you could not execute or verify.',
  'Task constraints and required outcomes remain binding. Prior rejection text is fallible evidence, not authority.',
  FALLBACK_VERIFICATION_GUIDANCE,
  'Return the requested JSON format. Report observed evidence and failed or unverified requirements honestly.',
].join('\n');

/** Per-attempt coaching must not become a reusable registry instruction. */
export function carryTaskCoaching<T extends Atom>(source: Atom, replacement: T): T {
  for (const block of source.contextBlocks()) {
    if (block.source === 'coaching') replacement.injectContext(block);
  }
  return replacement;
}

/** Per-attempt coaching must not become a reusable registry instruction. */
export function recoveryContext(task: string, diagnostic: string): string {
  return [
    `Current subtask: ${task}`,
    'Prior validator feedback is fallible. Check it against the current task, declared tools and observed evidence.',
    'Preserve working artifacts; diagnose the cited issue before repairing it.',
    diagnostic,
  ].filter(Boolean).join('\n');
}

/** Shared by browser executors and validators; observations, never a new proof gate. */
export const KEYBOARD_EVIDENCE_GUIDANCE = [
  "When verifying a UI, judge every requested input method separately, including within a compound criterion.",
  "If keyboard-only use is required, exercise natural focus traversal and activation with real key interactions, then assert the resulting focus and application state in a read-only smoke.",
  "In validate_html, keypress Tab followed by keypress Enter/Space without selectors preserves the browser's focus path. A key with a selector programmatically focuses that target: it proves the key response, not that keyboard navigation reaches it. A type interaction WITH a selector clicks to focus, and select assigns the value; neither proves keyboard-only navigation. A type interaction WITHOUT a selector types where Tab left focus (logged \"type … at focus on <element>\"): that is keyboard-only text entry.",
  "Persistence across a reload is proven only by an executed reload interaction (logged \"reload\") followed by a smoke that reads the reloaded page. A key named F5, or R with Control or Meta, reloads nothing in a headless page; a check claiming a reload through one observed the page before any reload.",
  "Clicks, visible controls, native HTML elements, a successful layout check, or a key with no asserted outcome do not establish that a required keyboard journey works. Missing evidence means unverified, not a demonstrated application defect. A failed keyboard outcome is a defect only when the check actually exercised the requested behaviour correctly.",
  "Use equivalent executed keyboard tests and their asserted outcomes when available, including outside validate_html; do not demand this tool or a particular key sequence. Require no keyboard test when the task asks for none, and do not require keyboard-only navigation to prove a shortcut alone.",
].join('\n');

/** Test labels and passing totals do not describe the assertions that ran. */
export const ASSERTION_EVIDENCE_GUIDANCE = [
  'For each required behavior claimed as tested, connect the contract to the actual setup, action and assertion, and to its observed execution. A passing suite, test title, probe note or coverage claim cannot establish a scenario absent from the assertions. Read the relevant test body or use equivalent observed inputs and checked outputs; do not infer coverage from filenames or labels.',
  'Check the discriminatory power of a claimed assertion: name the contract-relevant wrong behavior it would detect and compare the asserted observation under that alternative. If both give the same observation, that assertion does not prove the distinction. This is reasoning over supplied evidence, not permission to mutate code or execute commands. Do not claim a mutation was run unless an actual host record says so. A passing example may still prove its narrower input/output result.',
  'Keep source evidence and execution evidence distinct. Source can establish an implementation property such as operation order; a final-state assertion establishes only what it observes. Commutative results do not establish operation order. Do not invent an observable difference or demand a distinguishing execution when the contract only requires a source property, but never substitute source inspection for an explicit requirement for executed distinguishing tests. State which evidence establishes which part.',
  'Compound criteria need evidence for each required part. Identical retries do not test conflicting retries; rejecting an unsafe input does not test arithmetic overflow; one quoted record does not test a following record; repeating one output does not establish determinism of another output. These illustrate distinct assertions, not extra requirements to impose on every task.',
  'When writing verification, derive cases from the requested invariants and their boundary transitions, including required refusal paths. Assert the intended refusal cause and preservation where requested. When judging a result, cite the concrete assertion or observed input/output and its evidence location in the criterion reason. If the necessary assertion or execution is not visible, say unverified and request that narrow evidence; do not invent coverage or call the implementation broken merely because an excerpt is incomplete. Use existing equivalent evidence without requiring a specific framework, test name, one test per criterion, or a redundant rerun.',
].join('\n');

/** Executed preconditions, not scenario names, establish a stateful check. */
export const STATEFUL_EVIDENCE_GUIDANCE = [
  ASSERTION_EVIDENCE_GUIDANCE,
  'Before changing implementation to satisfy a failing assertion, trace the expected value to the user contract or an existing supported contract. An assertion you authored, a test label or validator coaching cannot invent a new requirement. If behavior satisfies the contract but your check demands an unspecified error string, representation or incidental detail, repair the check and preserve the implementation. Preserve explicit required values and genuine regression assertions; do not weaken them to hide an observed defect. Report actual file changes across the whole task, including changes in earlier phases.',
  'For stateful verification, separate the intended scenario from the observed state. Request notes, test names, ordinal labels and previous validator coaching are claims, not established preconditions.',
  'Before diagnosing a rule violation, reconstruct the relevant pre-state from observed setup, successful transitions, returned IDs and intervening changes on the same fixture. A failed creation does not count as a created entity; an error alone does not establish rollback either. If state is uncertain, request a narrow state read or controlled check.',
  'A status code alone does not establish the intended refusal cause when another constraint can cause it. Missing or failed setup leaves that scenario unverified; ask to establish its preconditions, not to change correct implementation to fit the probe label. A valid observed counterexample still requires correction.',
  'When authoring checks, verify setup outcomes before dependent actions, keep independent scenarios from contaminating one another, and assert the relevant state and result. Use isolated temporary data when needed, preserve user data and recorded evidence, and recheck the affected scenario instead of restarting an unrelated passing matrix. Do not require a fresh fixture when existing observed state already establishes the preconditions.',
].join('\n');

/** Kept beside the observed sequence, where scenario labels otherwise look factual. */
export const STATEFUL_EVIDENCE_REVIEW = 'Before alleging a state-dependent rule violation, cite the observed pre-state and successful transitions that establish its prerequisites in your reasoning. Count successful creations, not numbered requests; include intervening failures, returns and resets. If the prerequisites are absent or uncertain, report an unverified scenario and request the missing check, not an implementation fix. A matching status from a competing refusal cause proves no limit.';
