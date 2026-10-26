import { expect, it } from 'vitest';
import { activityLines, activitySettled, activityWho, deploymentLines, deploymentWhat, mcpClientLabel, type AssistantActivity, type DeploymentEntry } from '../src/viz/client-gl/assistant-activity.js';
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

it('tells each deployment at its place in time: which version went online and where it stands (2026-10-26)', () => {
  const entry = (overrides: Partial<DeploymentEntry>): DeploymentEntry => ({ deploymentId: '2d8f4b6a-3c4d-4e5f-8a0b-2c3d4e5f6a70',
    runId: '0b6d2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', title: 'Repair the control page', traceId: 'trace-1', createdAt: '2026-10-26T10:23:00.000Z',
    replaced: true, outcome: 'online', keptOnline: false, ...overrides });
  const first = entry({ deploymentId: '3e9a5c7b-4d5e-4f60-9b1c-3d4e5f6a7b80', title: null, outcome: 'ended', createdAt: '2026-10-25T19:10:00.000Z', replaced: false });
  const history = [entry({}), first];
  const lines = deploymentLines({ history, messages: [], olderUnloaded: false });
  expect(lines.map(line => line.deployment.deploymentId)).toEqual([first.deploymentId, entry({}).deploymentId]);
  expect(deploymentWhat(lines[0]!, t)).toEqual({ what: 'Put online: an accepted version', state: 'No longer online.' });
  expect(deploymentWhat(lines[1]!, t)).toEqual({ what: 'Online application switched to: Repair the control page', state: 'Online now.' });
  // Nothing older than the first loaded message while older messages remain unloaded.
  const page = deploymentLines({ history, messages: [{ at: '2026-10-26T09:00:00.000Z' }], olderUnloaded: true });
  expect(page.map(line => line.deployment.deploymentId)).toEqual([entry({}).deploymentId]);
});

it('never says a deployment served when it did not, nor that it did not start when it served', () => {
  const told = (overrides: Partial<DeploymentEntry>) => deploymentWhat({ key: 'k', at: '2026-10-26T10:23:00.000Z', deployment: {
    deploymentId: '2d8f4b6a-3c4d-4e5f-8a0b-2c3d4e5f6a70', runId: '0b6d2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', title: 'v2', traceId: null,
    createdAt: '2026-10-26T10:23:00.000Z', replaced: false, outcome: 'online', keptOnline: false, ...overrides } }, t);
  expect(told({ outcome: 'starting' })).toEqual({ what: 'Putting online: v2', state: 'Starting…' });
  expect(told({ outcome: 'starting', replaced: true })).toEqual({ what: 'Switching the online application to: v2', state: 'Starting…' });
  expect(told({ outcome: 'not-started' })).toEqual({ what: 'Tried to put online: v2', state: 'It did not start.' });
  expect(told({ outcome: 'not-started', replaced: true, keptOnline: true })).toEqual({ what: 'Tried to switch the online application to: v2',
    state: 'It did not start. The version already online stayed online.' });
  expect(told({ outcome: 'unavailable' })).toEqual({ what: 'Put online: v2', state: 'Not answering right now.' });
  // A row from before these facts proves neither that it served nor that it switched anything.
  expect(told({ outcome: 'stopped', replaced: true })).toEqual({ what: 'Deployment of: v2', state: 'Stopped.' });
});

it('says a delivery was not accepted once a later version was, and nothing while none is (2026-10-26)', () => {
  const at = (hour: number) => `2026-10-26T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const settledOf = (activity: AssistantActivity[], runId: string) => {
    const line = activityLines({ activity, messages: [], carded: new Set(), olderUnloaded: false })
      .find(item => item.kind === 'ended' && item.run.runId === runId)!;
    return activitySettled(line, t);
  };
  const older = run({ runId: '1b0c9a3e-2d4f-4a6b-8c7d-9e0f1a2b3c4d', status: 'delivered', createdAt: at(8), endedAt: at(9) });
  const failed = run({ runId: '2c1d0b4f-3e5a-4b7c-9d8e-0f1a2b3c4d5e', status: 'failed', createdAt: at(9), endedAt: at(10) });
  const accepted = run({ runId: '3d2e1c5a-4f6b-4c8d-8e9f-1a2b3c4d5e6f', status: 'delivered', createdAt: at(10), endedAt: at(11),
    acceptedAt: at(12), publicationStatus: 'published' });
  const after = run({ runId: '4e3f2d6b-5a7c-4d9e-9f0a-2b3c4d5e6f70', status: 'delivered', createdAt: at(13), endedAt: at(14) });
  const activity = [after, accepted, failed, older];
  expect(settledOf(activity, older.runId)).toBe('Not accepted; a later version replaced it.');
  expect(settledOf(activity, accepted.runId)).toBe('This result was accepted and sent to GitHub.');
  // Only a delivery is "not accepted"; a newer delivery than the accepted one is not replaced by it.
  expect(settledOf(activity, failed.runId)).toBeNull();
  expect(settledOf(activity, after.runId)).toBeNull();
  expect(settledOf([after, older], older.runId)).toBeNull();
});
