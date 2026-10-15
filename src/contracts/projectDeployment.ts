import { z } from 'zod';

/** A project preference, never evidence of a running deployment. */
export const deploymentDestinationSchema = z.enum(['none', 'atoma', 'external']);
export type DeploymentDestination = z.infer<typeof deploymentDestinationSchema>;

export const deploymentSettingInputSchema = z.object({
  destination: deploymentDestinationSchema,
  expectedDestination: deploymentDestinationSchema,
}).strict();

/**
 * A project's label under the hosting namespace (`<label>.app.atoma.run`):
 * one to three words of ASCII letters joined by single hyphens. No digit, so
 * no label can ever equal a legacy `p-<uuid>` address; no leading, trailing
 * or doubled hyphen, so no IDNA `xn--` form either. Model-proposed and
 * validated here, therefore an identity, not display copy.
 */
export const HOSTING_SUBDOMAIN_MAX = 40;
export const hostingSubdomainSchema = z.string().min(3).max(HOSTING_SUBDOMAIN_MAX).regex(/^[a-z]+(?:-[a-z]+){0,2}$/);
export type HostingSubdomain = z.infer<typeof hostingSubdomainSchema>;
/** Labels that would read as the platform's own, never a project's. */
export const RESERVED_HOSTING_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www', 'api', 'app', 'apps', 'admin', 'atoma', 'auth', 'login', 'mail', 'mcp', 'preview', 'status', 'static', 'cdn',
]);

/** An administrator's address change; `expectedSubdomain` rejects a stale write. */
export const hostingAddressInputSchema = z.object({
  subdomain: hostingSubdomainSchema,
  expectedSubdomain: hostingSubdomainSchema.nullable(),
}).strict();
