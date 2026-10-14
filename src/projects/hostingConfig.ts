import { isIP } from 'node:net';
export function hostingConfig(env: NodeJS.ProcessEnv, origin: string): { domain: string; port: number; maxDeployments: number } | null {
  if (env['ATOMA_HOSTING_ENABLED'] !== '1') {
    if (env['ATOMA_HOSTING_ENABLED'] && env['ATOMA_HOSTING_ENABLED'] !== '0') throw new Error('Invalid hosting switch');
    return null;
  }
  const domain = env['ATOMA_HOSTING_DOMAIN'] ?? '';
  const control = new URL(origin);
  if (control.protocol !== 'https:' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || isIP(domain) || domain === control.hostname || control.hostname.endsWith(`.${domain}`)) {
    throw new Error('Hosting needs a dedicated HTTPS hostname namespace');
  }
  const port = Number(env['ATOMA_HOSTING_PORT'] ?? 4411);
  const maxDeployments = Number(env['ATOMA_HOSTING_MAX'] ?? 2);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(maxDeployments) || maxDeployments < 1 || maxDeployments > 100) throw new Error('Invalid hosting capacity or port');
  return { domain, port, maxDeployments };
}
