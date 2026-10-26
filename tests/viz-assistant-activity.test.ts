import { expect, it } from 'vitest';
import { activityLines, activityWho, mcpClientLabel, type AssistantActivity } from '../src/viz/client-gl/assistant-activity.js';
import { translate } from '../src/viz/client/i18n-catalog.js';

const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const run = (overrides: Partial<AssistantActivity>): AssistantActivity => ({
  runId: '0b6d2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', projectId: 'a660aa4f-4b75-49a8-9454-449b77c06f9d', title: null, goalExcerpt: 'Add a contact form',
  status: 'delivered', createdAt: '2026-10-20T08:00:00.000Z', endedAt: '2026-10-20T09:00:00.000Z', costUsd: 0.4, requestedByName: 'Sam',
  mine: false, continuation: false, comparison: false, acceptedAt: null, publicationStatus: null, ...overrides,
});

it('tells nothing older than the first loaded message while older messages remain unloaded', () => {
  const messages = [{ role: 'user' as const, at: '2026-10-20T08:30:00.000Z' }];
  const lines = (olderUnloaded: boolean) => activityLines({ activity: [run({})], messages, carded: new Set(), olderUnloaded }).map(line => line.kind);
  // Its request predates the loaded page; its end does not.
  expect(lines(true)).toEqual(['ended']);
  expect(lines(false)).toEqual(['started', 'ended']);
});

it('ends a run on its result card, not on a line, and orders lines in time', () => {
  const later = run({ runId: '1c7e3a5f-2b3c-4d4e-9f0a-1b2c3d4e5f60', createdAt: '2026-10-21T08:00:00.000Z', status: 'running', endedAt: null });
  const lines = activityLines({ activity: [later, run({})], messages: [], carded: new Set([run({}).runId]), olderUnloaded: false });
  expect(lines.map(line => line.key)).toEqual([`started:${run({}).runId}`, `started:${later.runId}`]);
});

it('names known MCP clients as people know them and shows any other claim as sent', () => {
  expect(mcpClientLabel('claude-code')).toBe('Claude Code');
  expect(mcpClientLabel('codex-mcp-client')).toBe('Codex');
  expect(mcpClientLabel('my-own-agent')).toBe('my-own-agent');
  expect(activityWho(run({ mine: true, requestedVia: { door: 'mcp', client: 'claude-code' } }), t)).toBe('You, from Claude Code');
  expect(activityWho(run({ requestedVia: { door: 'mcp' } }), t)).toBe('Sam, from a connected agent');
  expect(activityWho(run({ requestedByName: null }), t)).toBe('Someone in your organisation');
});
