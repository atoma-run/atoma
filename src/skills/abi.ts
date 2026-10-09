import { scriptExtension } from '../contracts/scriptEnvelope.js';
import type { SkillLanguage } from './types.js';

/**
 * SCRIPT-SKILL ABI — the calling convention between atoma and a compiled
 * skill script, in ONE module. Both dispatch paths (the L1-driven
 * untrusted path via skillContextBlock, and the zero-LLM trusted path in
 * runScriptSkillDirect) MUST agree on: where the scratch file lands, which
 * interpreter runs it, and what argv it receives. They used to derive
 * these independently in two places — any drift meant "script works on
 * one path, fails on the other", the least debuggable failure shape the
 * lifecycle can produce (counters move on one path only).
 *
 * The stdout envelope half of the ABI lives in
 * src/contracts/scriptEnvelope.ts (schema + strict parse + pre-flight
 * gate); this module owns the INVOCATION half.
 */

/**
 * Sandbox-local scratch filename: `_skill_<id>.<ext>` on the L1-driven path,
 * `_skill_<id>.<namespace>.<dispatch>.<ext>` for one trusted direct dispatch.
 * Extension policy (.mjs, never bare .js) is scriptExtension's — see its
 * comment.
 *
 * A direct dispatch names its OWN file: parallel subtasks share one
 * workspace, and with one name per skill the cleanup of one dispatch deleted
 * the file another was about to run — an `ENOENT` counted as a deterministic
 * failure, two of which demote the script (code review 2026-10-09, 2.25).
 * The `_skill_` prefix stays, so evidence filters and the L1's own scratch
 * check still recognise it. The L1 path keeps the bare name: it is folded
 * into the molecule's system prompt, where a per-dispatch token would defeat
 * its prompt cache.
 */
export function scriptScratchFilename(
  skillId: string,
  language: SkillLanguage,
  dispatch?: { readonly namespace: string; readonly dispatchId: string }
): string {
  const token = (value: string) => value.replace(/[^A-Za-z0-9-]/g, '-');
  const unique = dispatch ? `.${token(dispatch.namespace)}.${token(dispatch.dispatchId)}` : '';
  return `_skill_${skillId}${unique}.${scriptExtension(language)}`;
}

/** Interpreter binary for run_shell. All three appear in the run_shell allowlist. */
export function scriptInterpreter(language: SkillLanguage): string {
  return language === 'python' ? 'python3' : language;
}

/**
 * argv contract: ONE argument — the JSON-encoded subtask description.
 * Everything task-specific must be DERIVED by the script from the
 * workspace + this argument (compile prompt: NO TASK-SPECIFIC LITERALS).
 */
export function scriptArgv(subtaskDescription: string): string[] {
  return [JSON.stringify(subtaskDescription)];
}

/** Full run_shell argv for the trusted direct path. */
export function scriptInvocationArgv(
  filename: string,
  subtaskDescription: string
): string[] {
  return [filename, ...scriptArgv(subtaskDescription)];
}

/**
 * Human-readable form of the same ABI for the L1-driven prompt path.
 * The placeholder is intentionally executable-looking without encoding the
 * literal word "subtaskDescription" as the argument value.
 */
export function scriptInvocationArgvTemplate(filename: string): string {
  return `["${filename}", <JSON.stringify(subtaskDescription)>]`;
}
