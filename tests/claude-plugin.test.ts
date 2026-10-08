import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOAL_GUIDANCE } from '../src/run/guidance.js';
import { GOAL_PROMPT } from '../src/mcp/prompts.js';
import { packageVersion } from '../src/mcp/server.js';
import { MCP_TOOLS } from '../src/mcp/tools.js';

/**
 * The Claude Code plugin (`plugins/atoma`) is a second distribution of the ONE
 * MCP, plus text that teaches a host to drive it. Nothing reads it at runtime
 * here, so this suite is what notices when it drifts from the server: the
 * URL, the version, the tool names it cites and the guidance it quotes.
 */

const root = 'plugins/atoma';
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const marketplace = json<{ name: string; plugins: Array<{ name: string; source: string }> }>('.claude-plugin/marketplace.json');
const manifest = json<{ name: string; version: string; homepage: string; license: string }>(join(root, '.claude-plugin/plugin.json'));
const mcp = json<{ mcpServers: Record<string, { type: string; url: string }> }>(join(root, '.mcp.json'));
const serverJson = json<{ remotes: Array<{ url: string }> }>('server.json');
const pkg = json<{ homepage: string; license: string }>('package.json');
const skill = readFileSync(join(root, 'skills/runs/SKILL.md'), 'utf8');
const agent = readFileSync(join(root, 'agents/trace-reader.md'), 'utf8');

/** Each tool's `readOnlyHint`, read from what its row registers; a row that cannot register without a live context is a start, never read-only. */
function readOnlyTools(): Set<string> {
  const readOnly = new Set<string>();
  const recorder = {
    registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }) => {
      if (config.annotations?.readOnlyHint === true) readOnly.add(name);
    },
  };
  for (const tool of MCP_TOOLS) {
    try {
      tool.register(recorder as never, {} as never);
    } catch {
      // Start tools reach the session's task table at registration.
    }
  }
  return readOnly;
}

describe('the Claude Code plugin', () => {
  it('is listed by the repository marketplace under its own name', () => {
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: `./${root}` })]);
    expect(existsSync(join(root, '.claude-plugin/plugin.json'))).toBe(true);
  });

  it('carries the version and licence of the package', () => {
    expect(manifest.version).toBe(packageVersion());
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.homepage).toBe(pkg.homepage);
  });

  it('connects the one route server.json names, and nothing else', () => {
    expect(Object.values(mcp.mcpServers)).toEqual([{ type: 'http', url: serverJson.remotes[0]!.url }]);
  });

  it('quotes the goal guidance verbatim rather than restating it', () => {
    expect(skill).toContain(GOAL_GUIDANCE.help);
  });

  it('names only tools and prompts the server has', () => {
    const known = new Set([...MCP_TOOLS.map(tool => tool.name), GOAL_PROMPT]);
    const cited = [...`${skill}\n${agent}`.matchAll(/\batoma_[a-z_]+/g)].map(match => match[0]);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter(name => !known.has(name))).toEqual([]);
  });

  it('gives the trace reader read-only viewer tools of the plugin server, and nothing else', () => {
    const tools = /^tools: (.+)$/m.exec(agent)?.[1]?.split(',').map(tool => tool.trim()) ?? [];
    const [server] = Object.keys(mcp.mcpServers);
    const prefix = `mcp__plugin_${manifest.name}_${server}__`;
    const readOnly = readOnlyTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.startsWith(prefix), tool).toBe(true);
      const name = tool.slice(prefix.length);
      expect(readOnly.has(name), name).toBe(true);
      expect(MCP_TOOLS.find(row => row.name === name)?.tier, name).toBe('viewer');
    }
  });
});
