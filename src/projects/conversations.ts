import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Viewer } from '../auth/store.js';
import { assistantActionSchema, conversationApprovalSchema, conversationReadSchema, conversationWriteSchema,
  type AssistantAction, type ConversationApproval, type ConversationReceipt } from '../contracts/assistant.js';
import { AssistantConflict, AssistantStore, type AssistantScope } from './conversationStore.js';
import type { ProjectService } from './service.js';

/** Private continuity across clients, independent of whichever model produced a reply. */
export class Conversations {
  constructor(readonly store: AssistantStore, private readonly projects: Pick<ProjectService, 'projectContext' | 'projectReadiness' | 'listInstallations'>) {}

  scope(viewer: Viewer, projectId: string | null, conversationId?: string): AssistantScope {
    if (viewer.role === 'org:viewer') throw new AssistantConflict('A member role is required.');
    const scope = { principalId: viewer.principalId, orgId: viewer.orgId, projectId, ...(conversationId ? { conversationId } : {}) };
    const saved = this.store.read(scope).conversation;
    if (saved.projectId) this.projects.projectContext({ ...viewer, platformAdmin: false }, saved.projectId);
    return scope;
  }

  read(viewer: Viewer, raw: unknown) {
    const input = conversationReadSchema.parse(raw);
    return this.store.page(this.scope(viewer, input.projectId, input.conversationId), input.before, input.limit);
  }

  update(viewer: Viewer, raw: unknown) {
    const input = conversationWriteSchema.parse(raw);
    if (input.messages.reduce((sum, message) => sum + message.text.length, 0) > 12_000 ||
      (!input.messages.length && input.proposal === undefined)) throw new AssistantConflict('Share at most 12,000 characters per update, or one proposal.');
    const scope = this.scope(viewer, input.projectId, input.conversationId);
    const current = this.store.read(scope).conversation;
    if (input.proposal) this.validateProposal(viewer, current.projectId, input.proposal);
    const conversation = this.store.claim(scope, input.expectedVersion, input.requestId, false, JSON.stringify(input));
    if (!conversation) return this.read(viewer, { conversationId: current.id });
    try {
      conversation.messages.push(...input.messages.map(message => ({ ...message, at: new Date().toISOString(), origin: 'mcp' as const,
        ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}) })));
      // Shared messages alone do not silently approve, replace or discard a proposal.
      if (input.proposal !== undefined) conversation.proposal = input.proposal ? {
        id: randomUUID(), action: input.proposal, state: 'pending',
      } : null;
    } finally { this.store.save(scope, conversation); }
    return this.read(viewer, { conversationId: conversation.id });
  }

  private validateProposal(viewer: Viewer, projectId: string | null, action: AssistantAction): void {
    const scoped = { ...viewer, platformAdmin: false };
    if (action.kind === 'start_run') {
      if (projectId && action.projectId !== projectId) throw new AssistantConflict('The proposal does not match this project.');
      this.projects.projectReadiness(scoped, action.projectId);
    } else {
      if (projectId) throw new AssistantConflict('This conversation already belongs to a project. Start a new project conversation.');
      const target = action.project.repositoryTarget;
      if (!z.array(z.object({ installationId: z.string(), accountLogin: z.string(), status: z.string() })).parse(this.projects.listInstallations(scoped)).some(i => i.installationId === target.installationId &&
        i.accountLogin === target.owner && i.status === 'active')) throw new AssistantConflict('The GitHub destination is not available to this organisation.');
    }
  }

  /** Both existing MCP write tools consume the SAME saved proposal, before reaching their original service. */
  async approve(viewer: Viewer, raw: ConversationApproval, rawAction: AssistantAction,
    execute: (idempotencyKey: string) => Promise<ConversationReceipt>): Promise<ConversationReceipt> {
    const input = conversationApprovalSchema.parse(raw);
    const action = assistantActionSchema.parse(rawAction);
    const scope = this.scope(viewer, null, input.conversationId);
    const previous = this.store.approval(scope, input.proposalId);
    if (previous) {
      if (!isDeepStrictEqual(previous.action, action)) throw new AssistantConflict('The confirmed proposal has different content.');
      return previous.receipt;
    }
    const current = this.store.read(scope).conversation;
    if (!current.proposal || current.proposal.id !== input.proposalId || current.proposal.state !== 'pending') {
      throw new AssistantConflict('This proposal is no longer pending. Refresh the conversation.');
    }
    if (!isDeepStrictEqual(current.proposal.action, action)) throw new AssistantConflict('Confirm the exact saved proposal.');
    this.validateProposal(viewer, current.projectId, action);
    if (action.kind === 'start_run' && !current.projectId) {
      const target = this.store.read({ ...scope, conversationId: undefined, projectId: action.projectId }).conversation;
      if (target.id) throw new AssistantConflict('This project already has a conversation. Continue there before proposing the run.');
    }
    const conversation = this.store.claim(scope, input.version, input.requestId, false, JSON.stringify(input));
    if (!conversation) throw new AssistantConflict('This confirmation has already been received. Read the conversation.');
    const proposal = conversation.proposal!;
    proposal.state = 'executing';
    this.store.save(scope, conversation, false);
    // A slow repository check must not outlive the shared mutex. A crashed process still expires.
    const heartbeat = setInterval(() => this.store.keepAlive(scope, conversation), 15_000);
    heartbeat.unref();
    try {
      const receipt = await execute(`assistant:${proposal.id}`);
      conversation.messages.push({ role: 'receipt', origin: 'atoma', at: new Date().toISOString(), text: 'assistant.actionApproved' },
        { role: 'user', origin: 'mcp', at: new Date().toISOString(), text: input.confirmation });
      if (receipt.createdProjectId && action.kind === 'create_project') {
        conversation.projectId = receipt.createdProjectId;
        conversation.messages.push({ role: 'receipt', origin: 'atoma', at: new Date().toISOString(), text: 'assistant.projectCreated', projectId: receipt.createdProjectId });
        conversation.proposal = action.project.initialPrompt ? { id: randomUUID(), state: 'pending', projectName: action.project.name, action: {
          kind: 'start_run', projectId: receipt.createdProjectId, goal: action.project.initialPrompt, acceptanceCriteria: [],
        } } : { ...proposal, state: 'done' };
      } else if (receipt.run && action.kind === 'start_run') {
        conversation.lastRun = receipt.run;
        conversation.projectId ??= receipt.run.projectId;
        conversation.messages.push({ role: 'receipt', origin: 'atoma', at: new Date().toISOString(), text: 'assistant.runStarted', run: receipt.run });
        proposal.state = 'done';
      } else throw new Error('Missing execution receipt');
      this.store.finishApproval(scope, conversation, proposal.id, action, receipt);
      return receipt;
    } catch (error) {
      proposal.state = 'uncertain'; conversation.proposal = proposal;
      conversation.messages.push({ role: 'receipt', origin: 'atoma', at: new Date().toISOString(), text: 'assistant.actionUncertain' });
      this.store.save(scope, conversation);
      throw error;
    } finally { clearInterval(heartbeat); }
  }
}
