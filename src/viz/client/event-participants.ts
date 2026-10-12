import type { VizEvent } from './types.js';

/** Recorded identities only. A registry event's bare tier belongs to its target. */
export function eventParticipants(event: VizEvent) {
  const refs: { role: string; name: string; tier?: number }[] = [];
  const add = (role: string, name: unknown, tier?: unknown) => {
    if (typeof name === 'string' && name.trim()) {
      refs.push({ role, name, tier: typeof tier === 'number' ? tier : undefined });
    }
  };
  add('actor', event.actor?.name ?? (event.kind === 'registry' ? event.by : undefined), event.actor?.tier);
  add('child', event.child?.name ?? (event.kind === 'registry' ? event.name : undefined),
    event.child?.tier ?? (event.kind === 'registry' ? event.tier ?? event.snapshot?.tier : undefined));
  if (event.kind === 'registry') add('from', event.from);
  add('l1Name', event.l1Name, 1);
  add('executorName', event.executorName, 1);
  return refs;
}

/** Remove only identity aliases already presented by the participant controls. */
export function eventDetailPayload(event: VizEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...event };
  for (const { role } of eventParticipants(event)) delete payload[role];
  if (event.kind === 'registry') {
    delete payload.by;
    delete payload.name;
    delete payload.tier;
    if (event.snapshot) {
      const { name: _name, tier: _tier, ...snapshot } = event.snapshot;
      payload.snapshot = snapshot;
    }
  }
  return payload;
}
