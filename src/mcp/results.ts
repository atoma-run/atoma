import type { CallToolResult } from '@modelcontextprotocol/server';
import { serviceProblem, type ServiceProblem } from '../contracts/clientExperience.js';

export function errorResult(message: string, problem: ServiceProblem = serviceProblem(409, message)): CallToolResult {
  return { content: [{ type: 'text', text: `${message}\nNext: ${problem.nextAction}` }],
    structuredContent: { error: problem }, isError: true };
}
