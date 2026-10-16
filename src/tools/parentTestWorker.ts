/** Runs only in the sandboxed child process, never in the control plane. */
import { startVitest } from 'vitest/node';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResolverFactory } from 'rolldown/experimental';
import type { Plugin } from 'vite';

/**
 * Stylesheets never reach Vite's CSS pipeline: that pipeline loads the
 * project's PostCSS config and preprocessors (`postcss.config.js`, the
 * `package.json#postcss` plugins, `sass-embedded`) INTO THIS COORDINATOR, the
 * process that holds `--allow-addons` and writes the report, and
 * `config: false` does not stop it (review 2026-10-16: a forging
 * `postcss.config.js` turned a wrong implementation into `passed`). A
 * stylesheet that resolves loads as an empty stub; one that does not stays
 * Vite's own resolution failure, so a missing file never passes. The virtual
 * id carries no stylesheet extension, or `vite:css` would claim it anyway.
 * The stub is decided on the RESOLVED id, never the specifier: a tsconfig
 * `paths` alias or a package `main` naming a `.scss` file has no stylesheet
 * extension to read, and both loaded a forging `sass` (second review).
 */
const STYLESHEET = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const RAW_OR_URL = /[?&](?:raw|url)\b/;
const STUB = '\0atoma-css-stub:';
const cssStub: Plugin = {
  name: 'atoma:css-stub',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (source.startsWith('\0') || RAW_OR_URL.test(source)) return null;
    const resolved = await this.resolve(source, importer, { skipSelf: true });
    if (!resolved || !STYLESHEET.test(resolved.id) || RAW_OR_URL.test(resolved.id)) return null;
    const kind = /\.module\.[a-z]+(?:$|\?)/.test(resolved.id) ? 'module' : 'plain';
    return `${STUB}${kind}:${Buffer.from(resolved.id).toString('hex')}`;
  },
  load(id) {
    if (!id.startsWith(STUB)) return null;
    // Class names are not validated: each key maps to itself.
    return id.startsWith(`${STUB}module:`)
      ? 'export default new Proxy(Object.create(null), { get: (_, key) => typeof key === "string" ? key : undefined });'
      : 'export default "";';
  },
};

/**
 * What the host writes on stdin, one JSON line, never argv or env: neither
 * nonce appears in `/proc/<pid>/cmdline` or `ps`. The pipe stays open; its end
 * means the runner died, and this coordinator follows it.
 */
interface Header { setupNonce: string; guardNonce: string; windowMs: number; setupFile?: string }

/** Never a `for await` over stdin: leaving that loop destroys the stream the coordinator keeps. */
function readHeader(): Promise<Header> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const finish = (error?: Error): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      if (error) { reject(error); return; }
      try {
        const header = JSON.parse(buffered.slice(0, buffered.indexOf('\n'))) as Partial<Header>;
        const nonce = /^[0-9a-f]{32}$/;
        if (typeof header.setupNonce !== 'string' || !nonce.test(header.setupNonce) || typeof header.guardNonce !== 'string' ||
            !nonce.test(header.guardNonce) || typeof header.windowMs !== 'number' || !(header.windowMs > 0) ||
            (header.setupFile !== undefined && typeof header.setupFile !== 'string')) {
          throw new Error('atoma-verify: invalid runner header');
        }
        resolve(header as Header);
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    };
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString();
      if (buffered.includes('\n')) finish();
      else if (buffered.length > 4096) finish(new Error('atoma-verify: the runner header is too long'));
    };
    const onEnd = (): void => finish(new Error('atoma-verify: no runner header on stdin'));
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

const root = process.argv[2]!;
const header = await readHeader();
// The runner's SIGKILL timer lives in the runner. A runner that died hard
// leaves this process behind: the pipe's end and its own window end it.
process.stdin.on('end', () => process.exit(70));
process.stdin.on('error', () => process.exit(70));
process.stdin.resume();
process.stdin.unref?.();
setTimeout(() => process.exit(70), header.windowMs + 5000).unref();

/**
 * A bare specifier the SUITE imports resolves as the application modules it
 * imports do: tsconfig `paths` are read as data, and project source beats a
 * package of the same name, which is TypeScript's own rule. Until 2026-10-16
 * the suite alone missed aliases, and stayed red with "did not load". Every
 * candidate must lie inside the copy.
 */
const suiteFile = path.join(root, 'atoma.acceptance.test.ts');
// The one containment check. Imported by computed path: from source, Node
// strips types and maps no `.js` specifier to its `.ts` file.
const { containedIn } = await import(import.meta.url.endsWith('.ts') ? './containment.ts' : './containment.js') as typeof import('./containment.js');
const realRoot = Buffer.from(realpathSync.native(root));
const BARE = /^(?![./\\]|[a-zA-Z]:|\0|node:|data:|https?:|virtual:)/;
const stripQuery = (id: string): string => id.split('?')[0]!;
const inside = (file: string): boolean => {
  try {
    return containedIn(Buffer.from(realpathSync.native(stripQuery(file))), realRoot);
  } catch {
    return false;
  }
};
const projectSource = (file: string): boolean => inside(file) && !stripQuery(file).split(/[\\/]/).includes('node_modules');
let proxies: string[] = [];
const factories = new Map<string, ResolverFactory>();
const configs = (): string[] => readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name))
  // tsconfig.json first, then the others in code-unit order.
  .sort((a, b) => a === 'tsconfig.json' ? -1 : b === 'tsconfig.json' ? 1 : a < b ? -1 : a > b ? 1 : 0).slice(0, 16);
const suiteAliases: Plugin = {
  name: 'atoma:suite-aliases',
  enforce: 'pre',
  async transform(code, id) {
    if (stripQuery(id) !== suiteFile) return null;
    const found: string[] = [];
    const program = this.parse(code, { lang: 'ts' }) as unknown as { body: Array<{ type: string; source?: { value?: unknown } | null }> };
    for (const node of program.body) {
      const specifier = /^(?:Import|ExportNamed|ExportAll)Declaration$/.test(node.type) ? node.source?.value : undefined;
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue;
      const resolved = await this.resolve(specifier, suiteFile, { skipSelf: true });
      if (resolved && !resolved.external && projectSource(resolved.id)) found.push(stripQuery(resolved.id));
    }
    proxies = found;
    return null;
  },
  async resolveId(source, importer) {
    if (!importer || stripQuery(importer) !== suiteFile || !BARE.test(source) || source === 'vitest' || source.startsWith('vitest/')) return null;
    const direct = await this.resolve(source, importer, { skipSelf: true });
    let viaProxy: string | undefined;
    for (const proxy of proxies) {
      const resolved = await this.resolve(source, proxy, { skipSelf: true });
      if (resolved && !resolved.external) { viaProxy = resolved.id; break; }
    }
    // tsconfig `paths` beat packages, for the suite as for the subject.
    if (viaProxy && projectSource(viaProxy) && viaProxy !== direct?.id) return this.resolve(viaProxy, importer, { skipSelf: true });
    if (direct) return direct;
    if (viaProxy) return inside(viaProxy) ? this.resolve(viaProxy, importer, { skipSelf: true }) : null;
    let chosen: { file: string; config: string } | undefined;
    let disagreed = false;
    for (const name of configs()) {
      const configFile = path.join(root, name);
      let factory = factories.get(configFile);
      if (!factory) {
        factory = new ResolverFactory({ tsconfig: { configFile, references: 'auto' },
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] });
        factories.set(configFile, factory);
      }
      const result = factory.resolveFileSync(suiteFile, source);
      if (!result.path || !inside(result.path)) continue;
      if (!chosen) chosen = { file: result.path, config: name };
      else if (result.path !== chosen.file) disagreed = true;
    }
    if (!chosen) return null;
    // Read back by the host into the details: which tsconfig decided stays visible.
    if (disagreed || chosen.config !== 'tsconfig.json') console.error(`Host: suite alias '${source.slice(0, 200)}' resolved via ${chosen.config}`);
    // Back through Vite, so the stylesheet stub, decided on the resolved id, still applies.
    return this.resolve(chosen.file, importer, { skipSelf: true });
  },
};

const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const setupFile = header.setupFile ?? fileURLToPath(new URL(`./parentTestSetup${extension}`, import.meta.url));
/**
 * The guard and its contract load without their compiled source maps: those
 * name `src/` files the thread may not read (and the image does not hold), and
 * Vitest, mapping a failing assertion's stack through them, left the test
 * `pending` with no failure (measured on the packaged runner, 2026-10-16).
 */
const hostModules = new Set([setupFile, fileURLToPath(new URL(`../contracts/assertionIntegrity${extension}`, import.meta.url))]);
const SOURCE_MAP_COMMENT = /^\/\/# sourceMappingURL=.*$/gm;
const hostModulesWithoutMaps: Plugin = {
  name: 'atoma:host-modules',
  enforce: 'pre',
  load(id) {
    const file = stripQuery(id);
    if (!hostModules.has(file)) return null;
    return { code: readFileSync(file, 'utf8').replace(SOURCE_MAP_COMMENT, ''), map: null };
  },
};
const vitest = await startVitest('test', [], {
  root, config: false, watch: false, include: ['atoma.acceptance.test.ts'],
  reporters: ['json'], outputFile: `${root}/atoma.report.json`,
  pool: 'threads', execArgv: process.execArgv.filter(arg => arg !== '--allow-worker' && arg !== '--allow-addons'), maxWorkers: 1, fileParallelism: false,
  allowOnly: false, passWithNoTests: false, testTimeout: 10_000, hookTimeout: 10_000,
  environment: 'node', isolate: true,
  // The assertion-integrity guard, loaded before the suite and the code it imports.
  setupFiles: [setupFile],
  provide: { atomaSetup: header.setupNonce, atomaGuard: header.guardNonce },
  // A missing snapshot fails; none is ever written.
  update: 'none',
}, {
  // An inline object is never searched for nor executed.
  css: { postcss: {} },
  plugins: [hostModulesWithoutMaps, suiteAliases, cssStub],
  // Vite 8 reads tsconfig `paths` as data, natively; the project's config never runs.
  resolve: { alias: { vitest: fileURLToPath(import.meta.resolve('vitest')) }, tsconfigPaths: true },
});
await vitest.close();
