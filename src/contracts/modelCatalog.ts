import { z } from 'zod';
import { MODEL_SELECTOR_VENDORS, TIERS, type ModelSelectorVendor } from './modelSelector.js';

/**
 * THE MODEL CATALOGUE — WHICH MODELS EACH VENDOR OFFERS, AND WHAT THEY COST.
 * =========================================================================
 *
 * One DATA file (`src/core/modelCatalog.json`), one schema (this one). Code
 * states what a vendor IS — its credential, endpoint and wire protocol, in
 * `core/providerCatalog.ts` — and this file states what changes on the
 * vendor's calendar rather than ours: the models it serves and their prices.
 * Both change without a code change, so both are data, and `npm run models`
 * is the one writer (`src/cli/models.ts`).
 *
 * PRICES ARE A HISTORY, NEVER AN OVERWRITE. Each model carries its price
 * points in ascending `since` order, and a change APPENDS a point. `since` is
 * the day atoma started pricing that way — the day the change was observed
 * and reviewed, which is not always the day the vendor made it. Recorded
 * traces already carry the cost computed at call time; the history exists so
 * anything that re-prices old usage (`priceAt`) prices it with the numbers
 * that applied then, and so a reviewer can see what moved.
 *
 * RETIRED IS NOT DELETED. A model the vendor stopped serving keeps its entry
 * with a `retired` date: new selections refuse it, a stored pin that names it
 * degrades the way every retired choice already does, and its prices keep
 * pricing the calls made before.
 *
 * All prices are USD per MILLION tokens, list price, standard tier (no batch,
 * flex or priority), and the BASE context band where a vendor charges more
 * above a context threshold. That is an approximation stated once, here.
 */

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'not a calendar date');

const usdPerMillionSchema = z.number().finite().nonnegative();

export const modelPricePointSchema = z
  .object({
    /** First day atoma prices this model this way (YYYY-MM-DD, UTC). */
    since: isoDateSchema,
    input: usdPerMillionSchema,
    output: usdPerMillionSchema,
    /** Cache-read input. Equal to `input` for a vendor that has no cache discount. */
    cachedInput: usdPerMillionSchema,
    /** Cache-write input, when the vendor bills it apart; absent means 1.25 × input. */
    cacheWrite: usdPerMillionSchema.optional(),
    /** Where the numbers were read, for the reviewer of the next change. */
    source: z.string().url().optional(),
  })
  .strict();
export type ModelPricePoint = z.infer<typeof modelPricePointSchema>;

export const catalogModelSchema = z
  .object({
    /** The vendor's own model id — the third selector segment. */
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(120),
    /** Tiers this model may serve; absent means every tier. */
    tiers: z
      .array(z.union([z.literal(TIERS[0]), z.literal(TIERS[1]), z.literal(TIERS[2])]))
      .nonempty()
      .optional(),
    /** Other ids the vendor serves the same model under, priced alike (`-latest`, dated). */
    aliases: z.array(z.string().min(1).max(160)).optional(),
    /** Day the model stopped being offered for new selections. */
    retired: isoDateSchema.optional(),
    /**
     * The prices were read from the vendor's own page (`npm run models --
     * price`) because the reference source disagrees with it. A refresh still
     * SHOWS the source's number beside ours, and never proposes it.
     */
    manualPrice: z.literal(true).optional(),
    /** Price history, ascending `since`. Empty only for a self-hosted vendor. */
    prices: z.array(modelPricePointSchema),
  })
  .strict()
  .superRefine((model, ctx) => {
    for (let index = 1; index < model.prices.length; index++) {
      if (model.prices[index]!.since <= model.prices[index - 1]!.since) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prices', index, 'since'],
          message: `${model.id}: price points must be in strictly ascending \`since\` order`,
        });
      }
    }
  });
export type CatalogModel = z.infer<typeof catalogModelSchema>;

/**
 * A family pattern for ids no entry names exactly: a subscription alias
 * (`sonnet`), a dated id the catalogue has not caught up with, a self-hosted
 * tag of a vendor's weights. It prices like the model it points at, so a
 * price change never has to be made twice.
 */
export const catalogFallbackSchema = z
  .object({
    /** Case-insensitive regular expression tested against the priced model id. */
    pattern: z.string().min(1).max(200),
    /** The id of a model of the SAME vendor whose current price applies. */
    priceOf: z.string().min(1).max(160),
  })
  .strict();

export const vendorCatalogSchema = z
  .object({
    models: z.array(catalogModelSchema),
    fallbacks: z.array(catalogFallbackSchema).optional(),
  })
  .strict();
export type VendorCatalog = z.infer<typeof vendorCatalogSchema>;

export const modelCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Day the catalogue was last compared against its price source. */
    reviewedAt: isoDateSchema,
    vendors: z.object(
      Object.fromEntries(MODEL_SELECTOR_VENDORS.map((vendor) => [vendor, vendorCatalogSchema])) as {
        [V in ModelSelectorVendor]: typeof vendorCatalogSchema;
      }
    ).strict(),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    for (const vendor of MODEL_SELECTOR_VENDORS) {
      const entry = catalog.vendors[vendor];
      const seen = new Set<string>();
      for (const model of entry.models) {
        for (const id of [model.id, ...(model.aliases ?? [])]) {
          const key = id.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['vendors', vendor],
              message: `${vendor}: model id or alias "${id}" is listed twice`,
            });
          }
          seen.add(key);
        }
        // A billed vendor's model with no price reads as FREE in every cost
        // table, which flatters whatever tier it serves. Refused at load.
        if (vendor !== 'ollama' && model.prices.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendors', vendor, 'models'],
            message: `${vendor}:${model.id} has no price; a billed model must carry one`,
          });
        }
      }
      for (const fallback of entry.fallbacks ?? []) {
        try {
          new RegExp(fallback.pattern, 'i');
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendors', vendor, 'fallbacks'],
            message: `${vendor}: fallback pattern "${fallback.pattern}" is not a regular expression`,
          });
        }
        const target = entry.models.find((model) => model.id === fallback.priceOf);
        if (!target || target.prices.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vendors', vendor, 'fallbacks'],
            message: `${vendor}: fallback "${fallback.pattern}" prices of "${fallback.priceOf}", which has no price in this vendor`,
          });
        }
      }
    }
  });
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

/** YYYY-MM-DD of an instant, in UTC — the only calendar `since` is read in. */
export function catalogDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The price point in force on `at`: the latest one whose `since` is not after
 * that day. Before the first point, the first point applies — a call older
 * than the catalogue's memory is priced at the oldest numbers it has, never
 * at zero.
 */
export function pricePointAt(model: CatalogModel, at: Date = new Date()): ModelPricePoint | null {
  if (model.prices.length === 0) return null;
  const day = catalogDay(at);
  let chosen = model.prices[0]!;
  for (const point of model.prices) {
    if (point.since <= day) chosen = point;
  }
  return chosen;
}

/** Offered for new selections on `at`: not retired, or retired later than that day. */
export function modelIsOffered(model: CatalogModel, at: Date = new Date()): boolean {
  return model.retired === undefined || model.retired > catalogDay(at);
}
