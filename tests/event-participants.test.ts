import { describe, expect, it } from 'vitest';
import { eventDetailPayload, eventParticipants } from '../src/viz/client/event-participants.js';
import { buildAtomMap } from '../src/viz/client/run-utils.js';
import type { VizEvent, VizRun } from '../src/viz/client/types.js';

const registry: VizEvent = {
  id: 'credit', ts: 1, kind: 'registry', op: 'recordSuccess',
  by: 'Protoplast', name: 'RNA', tier: 1,
  actor: { name: 'Protoplast', tier: 2 }, child: { name: 'RNA', tier: 1 }, attempt: 1,
};

describe('event participant controls', () => {
  it('separates initiator and target tiers and removes their raw aliases', () => {
    expect(eventParticipants(registry)).toEqual([
      { role: 'actor', name: 'Protoplast', tier: 2 },
      { role: 'child', name: 'RNA', tier: 1 },
    ]);
    expect(eventDetailPayload(registry)).toEqual({ id: 'credit', ts: 1, kind: 'registry', op: 'recordSuccess', attempt: 1 });
  });
  it('never borrows the target tier for an unknown initiator', () => {
    expect(eventParticipants({ ...registry, actor: undefined, child: undefined })[0])
      .toEqual({ role: 'actor', name: 'Protoplast', tier: undefined });
  });
  it('makes donor, executor and registry source navigable even without snapshots', () => {
    const event: VizEvent = { id: 'skill', ts: 2, kind: 'skill', l1Name: 'RNA', executorName: 'Sucrose' };
    const run = { events: [event, { ...registry, from: 'CellSource' }] } as VizRun;
    const atoms = buildAtomMap(run);
    expect(atoms.get('Sucrose')?.snapshot.tier).toBe(1);
    expect(atoms.has('CellSource')).toBe(true);
    expect(eventDetailPayload(event)).not.toHaveProperty('executorName');
  });
  it('preserves arbitrary tool arguments and result identities', () => {
    const event: VizEvent = { id: 'tool', ts: 1, kind: 'tool', name: 'read_file', args: { name: 'RNA', tier: 3 } };
    expect(eventDetailPayload(event)).toEqual(event);
  });
});
