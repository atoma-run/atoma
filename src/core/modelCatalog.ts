import rawCatalog from './modelCatalog.json' with { type: 'json' };
import {
  modelCatalogSchema,
  modelIsOffered,
  type CatalogModel,
  type ModelCatalog,
} from '../contracts/modelCatalog.js';
import type { ModelSelectorVendor } from '../contracts/modelSelector.js';

/**
 * The checked-in model catalogue, validated ONCE at load. An invalid file is
 * a boot failure, never a degraded catalogue: every price and every picker in
 * the product reads it, and a half-read price list is a silent billing error.
 * The one writer is `npm run models` (`src/cli/models.ts`), which validates
 * with the same schema before it writes.
 */
export const MODEL_CATALOG: ModelCatalog = modelCatalogSchema.parse(rawCatalog);

/** Every model the catalogue knows for a vendor, retired ones included. */
export function catalogModels(
  vendor: ModelSelectorVendor,
  catalog: ModelCatalog = MODEL_CATALOG
): readonly CatalogModel[] {
  return catalog.vendors[vendor].models;
}

/** The models a vendor offers for NEW selections on `at`. */
export function offeredCatalogModels(
  vendor: ModelSelectorVendor,
  at: Date = new Date(),
  catalog: ModelCatalog = MODEL_CATALOG
): readonly CatalogModel[] {
  return catalogModels(vendor, catalog).filter((model) => modelIsOffered(model, at));
}
