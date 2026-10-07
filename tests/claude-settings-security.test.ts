import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ClaudeProjectSettings {
  permissions?: {
    allow?: string[];
  };
}

/**
 * The only shell grants every collaborator inherits (owner decision
 * 2026-10-07): reading and merging pull requests through `gh`. None runs
 * workspace code, and a merge still answers to the collaborator's own
 * GitHub rights and the ruleset's required checks. Exact strings: any other
 * `Bash(` rule, however narrow it looks, stays local.
 */
const SHARED_SHELL_GRANTS = ['Bash(gh pr view *)', 'Bash(gh pr checks *)', 'Bash(gh pr merge *)'];

describe('Claude Code project permissions', () => {
  it('pre-authorizes no shell execution for every collaborator beyond the gh pull request grants', () => {
    const settings = JSON.parse(
      readFileSync(resolve('.claude/settings.json'), 'utf8')
    ) as ClaudeProjectSettings;
    const shellGrants = (settings.permissions?.allow ?? []).filter((rule) =>
      rule.startsWith('Bash(') && !SHARED_SHELL_GRANTS.includes(rule)
    );

    expect(
      shellGrants,
      'move shell approvals to ignored .claude/settings.local.json; project settings cross the trust boundary'
    ).toEqual([]);
  });

  it('keeps local permission preferences out of version control', () => {
    const ignore = readFileSync(resolve('.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.claude\/settings\.local\.json$/m);
  });

  it('keeps local Codex MCP commands out of version control', () => {
    const ignore = readFileSync(resolve('.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.codex\/config\.toml$/m);
  });
});
