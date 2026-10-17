// Evaluates the pre-registered rule (PREREGISTRATION.md) on rows.json and labels.json:
//   rows.json   — the structuredContent of `atoma_suite_disputes` view=rows under one fixed
//                 `until`, saved verbatim: one page, or the list of its pages in order;
//   labels.json — [{ key, class, reason, by, at }], one per unit.
// Writes results.json. Refuses (exit 1, nothing written) on a gap or an inconsistent input.
// Usage: node evaluate.mjs [directory]   (default: this directory)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLASSES = ['wrong-suite', 'wrong-implementation', 'undecidable'];
/** The only two points at which the rule is read. */
export const READINGS = [20, 40];
export const REASON_CHARS = 280;
export const OWNER_RELABELS = 5;

/**
 * Entered by hand before any label (PREREGISTRATION.md, "The legacy unit"):
 * counted on 2026-10-17 before the record existed, so no trace entry carries
 * it. Its outcome was read that day from every later run of its project.
 */
export const LEGACY_UNITS = [{
  key: '2ce8fde45b1fc8729932427b115e091d3b25e4c49c1dfa68611a54346a8c20c6',
  cluster: 'legacy:034d176d-3b28-4ef6-9314-3376ab8a84ef',
  firstRunId: '034d176d-3b28-4ef6-9314-3376ab8a84ef',
  outcome: 'never-passed',
  legacy: true,
}];
/** A run whose trace may expire without leaving a gap: its one unit is entered by hand. */
const EXEMPT_UNREADABLE = new Set(LEGACY_UNITS.map((unit) => unit.firstRunId));

export class Refusal extends Error {}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The units of rows.json in order, after checking its pages against each other and its list digest. */
export function unitsOf(rows) {
  const pages = Array.isArray(rows) ? rows : [rows];
  if (pages.length === 0) throw new Refusal('rows.json holds no page');
  const first = pages[0];
  const units = [];
  for (const page of pages) {
    if (!page || page.view !== 'rows') throw new Refusal('rows.json holds a page that is not view=rows, saved verbatim');
    if (page.listDigest !== first.listDigest || page.total !== first.total || page.window?.since !== first.window?.since
      || page.window?.until !== first.window?.until) throw new Refusal('rows.json mixes pages of different lists');
    if (typeof first.window?.until !== 'string') throw new Refusal('rows.json was read without a fixed until');
    if (page.offset !== units.length) throw new Refusal(`a gap between pages: one starts at ${page.offset}, ${units.length} units read before it`);
    units.push(...page.units);
  }
  if (units.length !== first.total) throw new Refusal(`rows.json holds ${units.length} of the list's ${first.total} units`);
  if (sha256(units.map((unit) => unit.key).join('\n')) !== first.listDigest) throw new Refusal('the units do not hash to listDigest');
  for (let index = 1; index < units.length; index += 1) {
    const before = units[index - 1];
    const unit = units[index];
    if (before.firstCountAt > unit.firstCountAt || (before.firstCountAt === unit.firstCountAt && before.key >= unit.key)) {
      throw new Refusal(`units out of first-count order at ${index + 1}`);
    }
  }
  const unreadable = pages.flatMap((page) => page.unreadable ?? []).filter((run) => !EXEMPT_UNREADABLE.has(run.runId));
  if (unreadable.length > 0) throw new Refusal(`${unreadable.length} run(s) the report could not read may hold units: a gap`);
  return { units, listDigest: first.listDigest, horizon: first.horizon, until: first.window.until, legacy: first.legacy ?? [] };
}

/** The labels, checked, and how many units from the first are labelled without a gap. */
export function checkLabels(labels, sequence) {
  if (!Array.isArray(labels)) throw new Refusal('labels.json must be a list');
  const known = new Set(sequence.map((unit) => unit.key));
  const byKey = new Map();
  for (const label of labels) {
    const key = label?.key;
    if (typeof key !== 'string' || !known.has(key)) throw new Refusal(`a label for a unit the list does not hold: ${String(key)}`);
    if (byKey.has(key)) throw new Refusal(`two labels for ${key}`);
    if (!CLASSES.includes(label.class)) throw new Refusal(`${key}: class must be one of ${CLASSES.join(', ')}`);
    if (typeof label.reason !== 'string' || label.reason.trim() === '' || label.reason.length > REASON_CHARS) {
      throw new Refusal(`${key}: a reason of 1 to ${REASON_CHARS} characters is required`);
    }
    if (typeof label.by !== 'string' || label.by.trim() === '') throw new Refusal(`${key}: by is required`);
    if (typeof label.at !== 'string' || !Number.isFinite(Date.parse(label.at))) throw new Refusal(`${key}: at must be an ISO date-time`);
    byKey.set(key, label);
  }
  let labelled = 0;
  while (labelled < sequence.length && byKey.has(sequence[labelled].key)) labelled += 1;
  if (byKey.size !== labelled) {
    throw new Refusal(`a gap: unit ${labelled + 1} (${sequence[labelled]?.key}) has no label while a later unit has one`);
  }
  return { byKey, labelled };
}

/** The mechanical override: a suite that passed after its count is not a wrong suite. */
export function effectiveClass(unit, label) {
  return unit.outcome === 'passed-later' ? 'wrong-implementation' : label.class;
}

const tally = (classes) => Object.fromEntries(CLASSES.map((name) => [name, classes.filter((value) => value === name).length]));
/** The rule: wrong suites are at least half, undecidable counted in the total. */
const passes = (counts, total) => total > 0 && counts['wrong-suite'] * 2 >= total;

/** The rule read on the first `n` units, on units and on clusters. */
export function reading(sequence, byKey, n) {
  const units = sequence.slice(0, n).map((unit) => {
    const label = byKey.get(unit.key);
    const effective = effectiveClass(unit, label);
    return { key: unit.key, cluster: unit.cluster, outcome: unit.outcome, label: label.class, class: effective, overridden: effective !== label.class };
  });
  const clusters = new Map();
  for (const unit of units) clusters.set(unit.cluster, [...(clusters.get(unit.cluster) ?? []), unit.class]);
  // A cluster is a wrong suite only when all its units are, a wrong implementation
  // only when all its units are, and undecidable otherwise.
  const clusterClasses = [...clusters.values()].map((classes) =>
    classes.every((value) => value === 'wrong-suite') ? 'wrong-suite'
      : classes.every((value) => value === 'wrong-implementation') ? 'wrong-implementation' : 'undecidable');
  const unitCounts = tally(units.map((unit) => unit.class));
  const clusterCounts = tally(clusterClasses);
  const onUnits = passes(unitCounts, units.length);
  const onClusters = passes(clusterCounts, clusterClasses.length);
  return {
    n,
    units: { total: units.length, ...unitCounts, pass: onUnits },
    clusters: { total: clusterClasses.length, ...clusterCounts, pass: onClusters },
    overridden: units.filter((unit) => unit.overridden).map((unit) => unit.key),
    pass: onUnits && onClusters,
  };
}

/** The units the owner re-labels blind, drawn from the list digest, so the draw is fixed before any label. */
export function ownerDraw(sequence, listDigest, n) {
  const drawn = [];
  for (let i = 0; drawn.length < Math.min(OWNER_RELABELS, n) && i < 1_000; i += 1) {
    const index = Number.parseInt(sha256(`${listDigest}:${i}`).slice(0, 8), 16) % n;
    const key = sequence[index].key;
    if (!drawn.includes(key)) drawn.push(key);
  }
  return drawn;
}

export function evaluate({ rows, labels, ownerLabels = null }) {
  const list = unitsOf(rows);
  const listed = new Set(list.units.map((unit) => unit.key));
  for (const unit of LEGACY_UNITS) if (listed.has(unit.key)) throw new Refusal(`the hand-entered unit ${unit.key} is also in rows.json`);
  const sequence = [...LEGACY_UNITS, ...list.units];
  const { byKey, labelled } = checkLabels(labels, sequence);
  const pending = sequence.slice(0, labelled).filter((unit) => unit.pending);
  if (pending.length > 0) throw new Refusal(`${pending.length} labelled unit(s) still have a run in flight: read rows.json again once they end`);
  /** @type {Record<string, ReturnType<typeof reading>>} */
  const readings = {};
  let status;
  let decision;
  if (labelled < READINGS[0]) {
    status = 'pending';
    decision = `${labelled} of ${READINGS[0]} consecutive units labelled; nothing is read before ${READINGS[0]}`;
  } else {
    readings[READINGS[0]] = reading(sequence, byKey, READINGS[0]);
    if (readings[READINGS[0]].pass) {
      status = 'pass';
      decision = `pass at ${READINGS[0]}`;
    } else if (labelled < READINGS[1]) {
      status = 'continue';
      decision = `fail at ${READINGS[0]}; read again at ${READINGS[1]} (${labelled} labelled)`;
    } else {
      readings[READINGS[1]] = reading(sequence, byKey, READINGS[1]);
      status = readings[READINGS[1]].pass ? 'pass' : 'fail';
      decision = readings[READINGS[1]].pass ? `pass at ${READINGS[1]}` : `fail at ${READINGS[1]}: the measurement is closed`;
    }
  }
  const decisive = readings[READINGS[1]] ? READINGS[1] : readings[READINGS[0]] ? READINGS[0] : null;
  const drawn = decisive ? ownerDraw(sequence, list.listDigest, decisive) : [];
  const owner = Array.isArray(ownerLabels) ? new Map(ownerLabels.map((label) => [label?.key, label?.class])) : null;
  return {
    status,
    decision,
    listDigest: list.listDigest,
    until: list.until,
    horizon: list.horizon,
    units: sequence.length,
    labelled,
    readings,
    ownerRelabel: {
      units: drawn,
      agreed: owner ? drawn.filter((key) => owner.has(key) && owner.get(key) === byKey.get(key)?.class).length : null,
      relabelled: owner ? drawn.filter((key) => owner.has(key)).length : null,
    },
    evidenceUnreadable: sequence.slice(0, labelled).filter((unit) => (unit.evidenceUnreadable ?? 0) > 0).map((unit) => unit.key),
    legacyRunsExcluded: list.legacy.filter((run) => !LEGACY_UNITS.some((unit) => unit.firstRunId === run.runId)).length,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(fileURLToPath(import.meta.url));
  const rowsFile = path.join(dir, 'rows.json');
  const rows = fs.existsSync(rowsFile) ? readJson(rowsFile) : null;
  if (rows === null || (Array.isArray(rows) && rows.length === 0)) {
    console.log('no rows.json yet: read atoma_suite_disputes view=rows after the record is deployed');
    return;
  }
  const ownerFile = path.join(dir, 'owner-labels.json');
  try {
    const result = evaluate({ rows, labels: readJson(path.join(dir, 'labels.json')), ownerLabels: fs.existsSync(ownerFile) ? readJson(ownerFile) : null });
    fs.writeFileSync(path.join(dir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${result.decision} (${result.labelled} of ${result.units} units labelled; list ${result.listDigest.slice(0, 16)})`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`refused: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
