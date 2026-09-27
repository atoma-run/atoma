/**
 * The model catalogue's operator CLI — which models each vendor offers and
 * what they cost, kept in `src/core/modelCatalog.json`.
 *
 *   npm run models -- list [--vendor <v>] [--all]
 *   npm run models -- refresh [--live] [--vendor <v>] [--source <url|file>] [--apply]
 *   npm run models -- add <vendor>:<id> --label <label> [--aliases a,b] [--tiers 1,2,3] [--apply]
 *   npm run models -- price <vendor>:<id> --input <usd> --output <usd> --cached <usd> [--apply]
 *   npm run models -- retire <vendor>:<id> [--on YYYY-MM-DD] [--apply]
 *
 * EVERY WRITE IS A DRY RUN UNTIL `--apply`, like `registry migrate-taxonomy`:
 * the command prints what it would change and exits 0. Applied, it rewrites
 * the JSON file in the checkout, and the change ships the way code does — a
 * reviewed commit on main, deployed by CI. There is deliberately no runtime
 * overlay a server reads beside the file: two sources of prices is the drift
 * this catalogue replaced (see `contracts/modelCatalog.ts`).
 *
 * `refresh` is quota-free. It reads the price reference (LiteLLM's public
 * price file, no key) and, with `--live`, each vendor's own model listing with
 * the key already in the environment — a listing is not a billed call. Keys
 * travel in request headers only and appear in no output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './args.js';
import { applyCheckoutDotenvForSourceEntry } from './loadDotenv.js';
import {
  catalogDay,
  modelCatalogSchema,
  modelIsOffered,
  pricePointAt,
  type CatalogModel,
  type ModelCatalog,
  type ModelPricePoint,
} from '../contracts/modelCatalog.js';
import {
  MODEL_SELECTOR_VENDORS,
  TIERS,
  type ModelSelectorVendor,
  type TierNumber,
} from '../contracts/modelSelector.js';
import { LLM_PROVIDER_CATALOG } from '../core/providerCatalog.js';
import {
  LITELLM_PRICE_SOURCE_URL,
  addModel,
  applyPriceChanges,
  diffCatalog,
  diffLiveListing,
  fallbacksPricingOf,
  fetchLiveListing,
  markReviewed,
  parseLiteLlmPrices,
  pricePointFromSource,
  retireModel,
  serializeCatalog,
  setModelPrice,
  type FetchJson,
  type PriceChange,
  type SourceCatalog,
  type SourcePrice,
} from './modelCatalogUpdate.js';

const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../core/modelCatalog.json', import.meta.url));

function printHelp(): void {
  console.log(`models — the model catalogue: offered models and their prices per vendor

usage:
  npm run models -- list [--vendor <v>] [--all]
      the catalogue; --all includes retired models
  npm run models -- refresh [--live] [--vendor <v>] [--source <url|file>] [--apply]
      compare prices with the reference (${LITELLM_PRICE_SOURCE_URL});
      --live also asks each vendor with a key in the environment which models it lists;
      --apply appends every changed price as a new point dated today
  npm run models -- add <vendor>:<id> --label <label> [--aliases a,b] [--tiers 1,2,3]
      [--input <usd> --output <usd> --cached <usd> [--cache-write <usd>] [--source-url <url>]] [--apply]
      offer a new model; without --input the price comes from the reference
  npm run models -- price <vendor>:<id> --input <usd> --output <usd> --cached <usd>
      [--cache-write <usd>] [--since YYYY-MM-DD] [--source-url <url>] [--auto] [--apply]
      record a price read from the vendor's page (marks it manual; --auto hands it back to the reference)
  npm run models -- retire <vendor>:<id> [--on YYYY-MM-DD] [--apply]
      stop offering a model for new selections; its prices keep pricing old calls

prices are USD per million tokens · vendors: ${MODEL_SELECTOR_VENDORS.join(', ')}
common: --catalog <path> (default src/core/modelCatalog.json)`);
}

function fail(message: string): never {
  console.error(`models: ${message}`);
  process.exit(1);
}

function parseVendorModel(raw: string | undefined): { vendor: ModelSelectorVendor; id: string } {
  const value = raw?.trim() ?? '';
  const colon = value.indexOf(':');
  const vendor = value.slice(0, colon);
  const id = value.slice(colon + 1);
  if (colon <= 0 || !id || !(MODEL_SELECTOR_VENDORS as readonly string[]).includes(vendor)) {
    fail(`expected <vendor>:<model-id> with vendor one of ${MODEL_SELECTOR_VENDORS.join(', ')}, got "${value}"`);
  }
  return { vendor: vendor as ModelSelectorVendor, id };
}

function parseVendorFlag(raw: string | undefined): ModelSelectorVendor[] | undefined {
  if (raw === undefined) return undefined;
  if (!(MODEL_SELECTOR_VENDORS as readonly string[]).includes(raw)) {
    fail(`--vendor must be one of ${MODEL_SELECTOR_VENDORS.join(', ')}`);
  }
  return [raw as ModelSelectorVendor];
}

function usd(flags: Record<string, string>, name: string, required: boolean): number | undefined {
  const raw = flags[name];
  if (raw === undefined) {
    if (required) fail(`--${name} <usd per million tokens> is required`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number, got "${raw}"`);
  return value;
}

function day(flags: Record<string, string>, name: string): string {
  const raw = flags[name];
  if (raw === undefined) return catalogDay(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    fail(`--${name} must be YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

function readCatalog(path: string): ModelCatalog {
  try {
    return modelCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (error) {
    fail(`cannot read the catalogue at ${path}: ${(error as Error).message}`);
  }
}

async function readSource(location: string): Promise<SourceCatalog> {
  try {
    if (/^https?:\/\//.test(location)) {
      const response = await fetch(location, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseLiteLlmPrices(await response.json());
    }
    return parseLiteLlmPrices(JSON.parse(readFileSync(location, 'utf8')) as unknown);
  } catch (error) {
    fail(`cannot read the price reference at ${location}: ${(error as Error).message}`);
  }
}

function money(value: number | undefined): string {
  if (value === undefined) return '–';
  return value >= 1 ? value.toFixed(2).replace(/\.?0+$/, '') : String(Number(value.toPrecision(3)));
}

function priceLabel(
  point: { readonly input: number; readonly output: number; readonly cachedInput?: number } | null
): string {
  return point ? `${money(point.input)}/${money(point.output)}/${money(point.cachedInput)}` : 'unpriced';
}

function write(path: string, catalog: ModelCatalog, apply: boolean): void {
  if (!apply) {
    console.log('\ndry run — nothing written. Re-run with --apply to write the catalogue.');
    return;
  }
  writeFileSync(path, serializeCatalog(catalog), 'utf8');
  console.log(`\nwrote ${path} — review the diff and commit it; a push to main deploys it.`);
}

function list(catalog: ModelCatalog, vendors: readonly ModelSelectorVendor[], all: boolean): void {
  const now = new Date();
  console.log(`catalogue reviewed ${catalog.reviewedAt} · prices in USD per million tokens (in/out/cached)`);
  for (const vendor of vendors) {
    const models = catalog.vendors[vendor].models.filter((model) => all || modelIsOffered(model, now));
    if (models.length === 0) continue;
    console.log(`\n${vendor}`);
    for (const model of models) {
      const point = pricePointAt(model, now);
      const upcoming = model.prices.filter((entry) => entry.since > catalogDay(now));
      const notes = [
        model.retired ? `retired ${model.retired}` : '',
        model.manualPrice ? 'manual price' : '',
        point ? `since ${point.since}` : '',
        ...upcoming.map((entry) => `→ ${priceLabel(entry)} from ${entry.since}`),
      ].filter(Boolean);
      console.log(`  ${model.id.padEnd(34)} ${priceLabel(point).padEnd(18)} ${notes.join(' · ')}`);
    }
  }
}

function describeChange(change: PriceChange): string {
  const alias = change.sourceId !== change.id ? ` (as ${change.sourceId})` : '';
  const source = change.proposed.source ? `\n      source: ${change.proposed.source}` : '';
  return `  ${change.vendor}:${change.id}${alias}  ${priceLabel(change.current)} → ${priceLabel(change.proposed)}${source}`;
}

const fetchJson: FetchJson = async (url, init) => {
  const response = await fetch(url, { headers: init.headers, signal: init.signal });
  return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> };
};

async function refresh(
  path: string,
  catalog: ModelCatalog,
  flags: Record<string, string>,
  apply: boolean
): Promise<void> {
  const vendors = parseVendorFlag(flags['vendor']);
  const location = flags['source'] || LITELLM_PRICE_SOURCE_URL;
  const source = await readSource(location);
  const drift = diffCatalog(catalog, source, vendors ? { vendors } : {});

  console.log(`price reference: ${location}`);
  console.log(`\nprice changes (${drift.priceChanges.length})${drift.priceChanges.length ? ' — applied by --apply as points dated today:' : ''}`);
  for (const change of drift.priceChanges) console.log(describeChange(change));
  if (drift.manualDisagreements.length > 0) {
    console.log(`\nmanually priced, reference disagrees (${drift.manualDisagreements.length}) — never applied; check the vendor page:`);
    for (const change of drift.manualDisagreements) console.log(describeChange(change));
  }
  if (drift.unknownToSource.length > 0) {
    console.log(`\nnot in the reference (${drift.unknownToSource.length}) — check these prices by hand:`);
    console.log(`  ${drift.unknownToSource.map((entry) => `${entry.vendor}:${entry.id}`).join(', ')}`);
  }
  if (drift.newAtSource.length > 0) {
    console.log(`\nknown to the reference, not offered here (${drift.newAtSource.length}) — add with \`models add\`:`);
    for (const vendor of MODEL_SELECTOR_VENDORS) {
      const ids = drift.newAtSource.filter((entry) => entry.vendor === vendor).map((entry) => entry.id);
      if (ids.length > 0) console.log(`  ${vendor}: ${ids.join(', ')}`);
    }
  }

  if (flags['live'] === 'true') {
    console.log('\nlive listings (keys from the environment):');
    for (const entry of LLM_PROVIDER_CATALOG) {
      if (vendors && !vendors.includes(entry.id)) continue;
      const listing = await fetchLiveListing(entry, process.env, fetchJson);
      if (listing.kind !== 'listed') {
        console.log(`  ${entry.id}: ${listing.kind} (${listing.reason})`);
        continue;
      }
      const live = diffLiveListing(catalog, entry.id, listing.ids);
      console.log(`  ${entry.id}: ${listing.ids.length} listed`);
      if (live.notListed.length > 0) {
        console.log(`    offered here but not listed by the vendor — retire?: ${live.notListed.join(', ')}`);
      }
      if (live.unknownToCatalogue.length > 0) {
        console.log(`    listed by the vendor, not in the catalogue: ${live.unknownToCatalogue.join(', ')}`);
      }
    }
  }

  const next =
    drift.priceChanges.length > 0 ? applyPriceChanges(catalog, drift.priceChanges) : markReviewed(catalog);
  write(path, next, apply);
}

function parseTiers(raw: string | undefined): TierNumber[] | undefined {
  if (raw === undefined) return undefined;
  const tiers = raw.split(',').map((entry) => Number(entry.trim()));
  if (tiers.length === 0 || tiers.some((tier) => !(TIERS as readonly number[]).includes(tier))) {
    fail(`--tiers must be a comma list of ${TIERS.join(', ')}`);
  }
  return [...new Set(tiers)] as TierNumber[];
}

function manualPoint(flags: Record<string, string>, since: string): ModelPricePoint {
  const cacheWrite = usd(flags, 'cache-write', false);
  const sourceUrl = flags['source-url'];
  return {
    since,
    input: usd(flags, 'input', true)!,
    output: usd(flags, 'output', true)!,
    cachedInput: usd(flags, 'cached', true)!,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(sourceUrl ? { source: sourceUrl } : {}),
  };
}

async function add(path: string, catalog: ModelCatalog, target: string | undefined, flags: Record<string, string>, apply: boolean): Promise<void> {
  const { vendor, id } = parseVendorModel(target);
  const label = flags['label']?.trim();
  if (!label) fail('--label <label shown in Settings> is required');
  const today = catalogDay(new Date());
  let point: ModelPricePoint | null = null;
  let manual = false;
  if (flags['input'] !== undefined) {
    point = manualPoint(flags, today);
    manual = true;
  } else if (vendor !== 'ollama') {
    const location = flags['source'] || LITELLM_PRICE_SOURCE_URL;
    const found: SourcePrice | undefined = (await readSource(location)).get(vendor)?.get(id);
    if (!found) fail(`${vendor}:${id} is not in the price reference; pass --input/--output/--cached from the vendor's page`);
    point = pricePointFromSource(found, today);
  }
  const aliases = flags['aliases']?.split(',').map((entry) => entry.trim()).filter(Boolean);
  const tiers = parseTiers(flags['tiers']);
  const model: CatalogModel = {
    id,
    label,
    ...(tiers ? { tiers: tiers as CatalogModel['tiers'] } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(manual ? { manualPrice: true as const } : {}),
    prices: point ? [point] : [],
  };
  let next: ModelCatalog;
  try {
    next = addModel(catalog, vendor, model);
  } catch (error) {
    fail((error as Error).message);
  }
  console.log(`add ${vendor}:${id} "${label}" at ${priceLabel(point)}${manual ? ' (manual price)' : ''}`);
  write(path, next, apply);
}

function price(path: string, catalog: ModelCatalog, target: string | undefined, flags: Record<string, string>, apply: boolean): void {
  const { vendor, id } = parseVendorModel(target);
  const point = manualPoint(flags, day(flags, 'since'));
  let next: ModelCatalog;
  try {
    next = setModelPrice(catalog, vendor, id, point, { manual: flags['auto'] !== 'true' });
  } catch (error) {
    fail((error as Error).message);
  }
  console.log(`price ${vendor}:${id} ${priceLabel(point)} from ${point.since}${flags['auto'] === 'true' ? '' : ' (manual)'}`);
  write(path, next, apply);
}

function retire(path: string, catalog: ModelCatalog, target: string | undefined, flags: Record<string, string>, apply: boolean): void {
  const { vendor, id } = parseVendorModel(target);
  const on = day(flags, 'on');
  let next: ModelCatalog;
  try {
    next = retireModel(catalog, vendor, id, on);
  } catch (error) {
    fail((error as Error).message);
  }
  console.log(`retire ${vendor}:${id} on ${on}`);
  for (const pattern of fallbacksPricingOf(next, vendor, id)) {
    console.log(`warning: fallback "${pattern}" still prices like ${vendor}:${id}; point it at the successor`);
  }
  write(path, next, apply);
}

async function main(): Promise<void> {
  // Source entry only: `--live` reads vendor keys from the checkout's .env.
  applyCheckoutDotenvForSourceEntry();
  const cli = parseCliArgs(process.argv, {
    booleanFlags: ['apply', 'all', 'live', 'auto', 'help'],
    valueFlags: [
      'catalog', 'vendor', 'source', 'label', 'aliases', 'tiers', 'input', 'output',
      'cached', 'cache-write', 'source-url', 'since', 'on',
    ],
  });
  if (!cli.command || cli.flags['help'] === 'true' || cli.command === 'help') {
    printHelp();
    process.exit(cli.command || cli.flags['help'] === 'true' ? 0 : 2);
  }
  const path = cli.flags['catalog'] || DEFAULT_CATALOG_PATH;
  const catalog = readCatalog(path);
  const apply = cli.flags['apply'] === 'true';
  switch (cli.command) {
    case 'list':
      return list(catalog, parseVendorFlag(cli.flags['vendor']) ?? MODEL_SELECTOR_VENDORS, cli.flags['all'] === 'true');
    case 'refresh':
      return refresh(path, catalog, cli.flags, apply);
    case 'add':
      return add(path, catalog, cli.positional[0], cli.flags, apply);
    case 'price':
      return price(path, catalog, cli.positional[0], cli.flags, apply);
    case 'retire':
      return retire(path, catalog, cli.positional[0], cli.flags, apply);
    default:
      printHelp();
      process.exit(2);
  }
}

main().catch((error: unknown) => fail((error as Error).message));
