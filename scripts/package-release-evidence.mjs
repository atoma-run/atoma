import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Copy only committed Markdown evidence directly linked by shipped contracts. */
export function packageReleaseEvidence(sourceRoot, destinationRoot) {
  const root = resolve(sourceRoot);
  const contracts = [join(root, 'AGENTS.md')];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'AGENTS.md') contracts.push(path);
    }
  }
  visit(join(root, 'src'));
  const paths = new Set();
  for (const contract of contracts) {
    for (const match of readFileSync(contract, 'utf8').matchAll(/\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
      if (match[1].includes('://')) continue;
      const path = relative(root, resolve(dirname(contract), match[1])).replaceAll('\\', '/');
      if (path.startsWith('records/') || path.startsWith('memory/') || path.startsWith('benchmark/')) paths.add(path);
    }
  }
  for (const path of [...paths].sort()) {
    // HEAD is the public release source. Never export untracked or local edits.
    const content = execFileSync('git', ['show', `HEAD:${path}`], { cwd: root });
    const destination = join(destinationRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return [...paths].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/package-release-evidence.mjs <release-root>');
  console.log(`Packaged ${packageReleaseEvidence(process.cwd(), process.argv[2]).length} linked Markdown evidence files`);
}
