import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve from this script so invocation from another directory is safe.
const root = fileURLToPath(new URL('../', import.meta.url));
const settingsPath = path.join(root, '.claude', 'settings.local.json');
const memoryPath = path.join(root, 'memory');
readFileSync(path.join(memoryPath, 'MEMORY.md'), 'utf8');
let settings = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
  throw new Error('Claude local settings must be a JSON object');
}
settings.autoMemoryDirectory = memoryPath;
settings.autoMemoryEnabled = true;
mkdirSync(path.dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Claude project memory: ${memoryPath}`);
console.log('Restart Claude Code, then use /memory to verify the directory.');
