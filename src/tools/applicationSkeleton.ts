import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolSandbox } from './sandbox.js';
import lockfile from './applicationSkeleton.lock.json' with { type: 'json' };

/** Versioned application source, independent of control-plane services. */
export const APPLICATION_SKELETON_VERSION = 1;
export type ApplicationSkeletonKind = 'web' | 'node' | 'fullstack';
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function applicationSkeletonFiles(kind: ApplicationSkeletonKind): Record<string, string> {
  const browser = kind !== 'node';
  const scripts = {
    dev: browser ? 'vite --host 0.0.0.0' : 'tsx watch src/server.ts',
    typecheck: 'tsc --noEmit',
    lint: 'eslint . --max-warnings 0',
    test: 'vitest run',
    build: `tsc -p tsconfig.build.json${browser ? ' && vite build' : ''}`,
    start: 'node dist/server/server.js',
    check: 'npm run typecheck && npm run lint && npm test',
  };
  const files: Record<string, string> = {
    'package.json': json({ ...lockfile.packages[''], private: true, type: 'module', scripts }),
    'package-lock.json': json(lockfile),
    '.gitignore': 'node_modules/\ndist/\ncoverage/\n',
    '.nvmrc': '24.20.0\n',
    'tsconfig.json': json({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      lib: browser ? ['ES2022', 'DOM', 'DOM.Iterable'] : ['ES2022'],
      strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
      noFallthroughCasesInSwitch: true, forceConsistentCasingInFileNames: true,
      skipLibCheck: true, noEmit: true, types: ['node'],
    }, include: ['src/**/*', 'tests/**/*', '*.config.ts'], exclude: ['node_modules', 'dist'] }),
    'tsconfig.build.json': json({ extends: './tsconfig.json', compilerOptions: {
      noEmit: false, rootDir: 'src', outDir: 'dist/server', sourceMap: true,
    }, include: ['src/**/*'], exclude: ['node_modules', 'dist', 'src/client'] }),
    'eslint.config.js': String.raw`import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  { ...js.configs.recommended, files: ['**/*.js'], languageOptions: { globals: globals.node } },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': true }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
`,
    'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } });\n",
    'src/message.ts': "export function greeting(name: string): string {\n  return `Hello, ${name.trim() || 'world'}!`;\n}\n",
    'tests/message.test.ts': "import { expect, test } from 'vitest';\nimport { greeting } from '../src/message.js';\ntest('greets a name and handles blank input', () => {\n  expect(greeting(' Ada ')).toBe('Hello, Ada!');\n  expect(greeting(' ')).toBe('Hello, world!');\n});\n",
    'src/server.ts': serverSource(browser),
    'README.md': `# Application\n\nAtoma application skeleton v${APPLICATION_SKELETON_VERSION} (${kind}).\n\nUse Node 24.20.0 or later. Run \`npm ci --include=dev\`, \`npm run check\`, and \`npm run build\`.\n\n\`npm start\` serves the built application on HOST (default 0.0.0.0) and PORT (default 3000, 0 supported).\n${browser ? '\n`npm run dev` starts the browser development server. For fullstack development, start the built Node server separately; Vite proxies /api to port 3000.\n' : '\n`npm run dev` watches the TypeScript server; type stripping does not replace `npm run typecheck`.\n'}\nAdd application code under src/ and behavioral tests under tests/. Keep all source and tests covered by strict typechecking and lint. Replace the example greeting and test with the requested application behavior. Never treat the example test as proof of product requirements.\n`,
  };
  if (browser) {
    files['index.html'] = '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Application</title></head><body><main id="app"></main><script type="module" src="/src/client/main.ts"></script></body></html>\n';
    files['src/client/main.ts'] = "import { greeting } from '../message.js';\nconst app = document.querySelector('#app');\nif (app) app.textContent = greeting('world');\n";
    files['vite.config.ts'] = "import { defineConfig } from 'vite';\nexport default defineConfig({ build: { outDir: 'dist/client', emptyOutDir: true }, server: { proxy: { '/api': 'http://127.0.0.1:3000' } } });\n";
  }
  return files;
}

function serverSource(browser: boolean): string {
  return `import { createServer } from 'node:http';
${browser ? "import { readFile } from 'node:fs/promises';\nimport { resolve, extname, sep } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst assets = fileURLToPath(new URL('../client/', import.meta.url));\nconst mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };" : ''}
import { greeting } from './message.js';

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (req.url === '/api/health'${browser ? '' : " || req.url === '/'"}) {
    res.setHeader('Content-Type', 'application/json');
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ message: greeting('world') }));
    return;
  }
${browser ? `  let path: string;
  try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  const file = resolve(assets, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(resolve(assets) + sep)) { res.writeHead(403); res.end(); return; }
  void readFile(file).then(bytes => {
    res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }, () => { res.writeHead(404); res.end(); });` : '  res.writeHead(404); res.end();'}
});
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '0.0.0.0', () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log('LISTENING_ON_PORT=' + address.port);
});
`;
}

/** A run_shell builtin utility; no new element or host-side execution path. */
export function scaffoldApplication(sandbox: ToolSandbox, argv: readonly string[]): string {
  const [kind, target = '.'] = argv;
  if (argv.length > 2 || (kind !== 'web' && kind !== 'node' && kind !== 'fullstack')) {
    throw new Error('Usage: atoma-scaffold <web|node|fullstack> [empty-directory]');
  }
  const root = sandbox.resolve(target);
  try {
    if (readdirSync(root).length > 0) throw new Error('Scaffold target must be empty. For an existing app, generate in .atoma-skeleton and adapt its configuration without replacing application code or tests.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files = applicationSkeletonFiles(kind);
  for (const [path, content] of Object.entries(files)) {
    const destination = sandbox.resolve(join(target, path));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: 'wx' });
  }
  return json({ version: APPLICATION_SKELETON_VERSION, kind, target, files: Object.keys(files), next: 'npm ci --include=dev && npm run check && npm run build; then implement and verify the requested behavior.' });
}
