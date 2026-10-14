import { z } from 'zod';

/** A project preference, never evidence of a running deployment. */
export const deploymentDestinationSchema = z.enum(['none', 'atoma', 'external']);
export type DeploymentDestination = z.infer<typeof deploymentDestinationSchema>;

export const deploymentSettingInputSchema = z.object({
  destination: deploymentDestinationSchema,
  expectedDestination: deploymentDestinationSchema,
}).strict();
