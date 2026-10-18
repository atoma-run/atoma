import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeMain } from '../launcher/computeApplication.js';
export { computeMain };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  computeMain(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Compute failed'); process.exitCode = 1; });
}
