import { randomBytes, randomUUID } from 'node:crypto';
import type { Viewer } from './store.js';

/** Server-only, short-lived delegation of a live browser session to the existing HTTP MCP. */
export class AssistantGrants {
  private readonly grants = new Map<string, { id: string; principalId: string; orgId: string;
    expires: number; resolve: () => Viewer | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(resolve: () => Viewer | null): { token: string; release: () => void } {
    const viewer = resolve();
    if (!viewer || viewer.role === 'org:viewer') throw new Error('Assistant membership required');
    for (const [key, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(key);
    if (this.grants.size >= 128) throw new Error('Assistant connection capacity reached');
    const token = `atoma_assistant_${randomBytes(32).toString('base64url')}`;
    this.grants.set(token, { id: randomUUID(), principalId: viewer.principalId, orgId: viewer.orgId,
      expires: this.now() + 90_000, resolve });
    return { token, release: () => { this.grants.delete(token); } };
  }

  resolve(token: string): { viewer: Viewer; tokenId: string } | null {
    const grant = this.grants.get(token);
    if (!grant || grant.expires <= this.now()) { this.grants.delete(token); return null; }
    const viewer = grant.resolve();
    if (!viewer || viewer.principalId !== grant.principalId || viewer.orgId !== grant.orgId || viewer.role === 'org:viewer') return null;
    // Even a platform administrator's assistant stays within the active organisation.
    return { viewer: { ...viewer, platformAdmin: false, role: 'org:member' }, tokenId: grant.id };
  }
}
