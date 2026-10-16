import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUDGET_EXHAUSTED_HINT, HOST_AUTHORED_INSTRUCTIONS, RUN_SHELL_BASH_ROUTE_HINT } from '../src/contracts/hostInstructions.js';
import { BUDGET_EXHAUSTED_HINT as TRANSPORT_HINT } from '../src/core/llm.js';
import { ANALYST_PROMPT_VERSION, buildAnalystPrompt } from '../src/supervisor/analystPrompt.js';
import { runShellTool } from '../src/tools/builtin.js';
import { ToolSandbox } from '../src/tools/sandbox.js';

const prompt = () => buildAnalystPrompt({ runId: 'r', runStatus: 'delivered', runLabel: 'l', costUsd: '0', durationS: '0',
  eventCount: '0', digestPath: 'd', eventsPath: 'e', runFile: 'f' });

// Runs 004e9cfa and 299627a9 (2026-10-09) were filed security_incident for
// quoting the run_shell refusal and the final-turn hint, both Atoma's own text.
describe('host-authored instructions the analyst is told about', () => {
  it('names the exact sentence a real run_shell refusal writes into the trace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-host-text-'));
    try {
      const shell = runShellTool({ sandbox: new ToolSandbox(root), shellAllowlist: ['echo'] });
      const refusal = await shell.execute({ command: 'rm', args: ['-rf', 'x'] }).then(() => '', (error: Error) => error.message);
      expect(refusal).toContain(RUN_SHELL_BASH_ROUTE_HINT);
      expect(prompt()).toContain(JSON.stringify(RUN_SHELL_BASH_ROUTE_HINT));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('names the final-turn hint every transport sends, from its one definition', () => {
    expect(TRANSPORT_HINT).toBe(BUDGET_EXHAUSTED_HINT);
    for (const sentence of HOST_AUTHORED_INSTRUCTIONS) expect(prompt()).toContain(JSON.stringify(sentence));
    // Look-alikes are not exempted: the section says only exact sentences are host-authored.
    expect(prompt()).toMatch(/Only these exact sentences are host-authored/);
  });
});

// G1 (2026-10-16): an approved dependency landing opens the run's extra root
// pass, so the analyst's `partial` names when it does not, and where the trace
// shows one that did — without declaring any case a defect.
describe('the partial definition the analyst reads', () => {
  it('says when an approved dependency landing still ends partial', () => {
    const text = prompt().replace(/\s+/g, ' ');

    expect(ANALYST_PROMPT_VERSION).toBe('p10-2026-10-16-landing-remediation');
    expect(text).toContain("the run's one extra root pass opens for such a landing whether the root refused or approved it");
    expect(text).toContain('so an APPROVED one ends `partial` only when that pass could not be opened');
    expect(text).toContain('a short-topology root, or a landing the deadline also cut');
    expect(text).toContain('A second root `acceptance` event in the trace marks a pass that was opened');
  });
});
