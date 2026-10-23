/** Default run cycle and project ceiling; explicit shorter budgets still win. */
export const RUN_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/** Leave room for preparation, finalization and result retrieval around a full run. */
export const RUN_REQUEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 60 * 60 * 1000;
