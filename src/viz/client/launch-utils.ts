import type { GoalGuidance } from './types.js';

export function launchCommand(guidance: GoalGuidance | undefined, goal: string): string {
  if (!guidance || !goal.trim()) return '';
  return `npm run ${guidance.npmScript} -- "${goal.trim().replace(/"/g, '\\"')}"`;
}
