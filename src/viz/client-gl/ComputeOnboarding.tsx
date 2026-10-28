import { useQuery } from '@tanstack/react-query';
import { computeOnboardingSchema } from '../../contracts/computeProject.js';
import { useGpuStore } from './store.js';
import { AtomaLoader } from './AtomaLoader.js';
import { ButtonIcon } from './ButtonIcon.js';

/** One account-scoped setup step, including before the first project exists. */
export function ComputeOnboarding({ scopeKey, projectId, locale, t, hostedAllowed = false }: {
  hostedAllowed?: boolean;
  scopeKey: string; projectId: string | null; locale: string; t: (key: string) => string;
}) {
  const query = useQuery({ enabled: !hostedAllowed, queryKey: ['compute-onboarding', scopeKey], retry: false, refetchInterval: 10_000,
    queryFn: async () => {
      const response = await fetch('/api/compute/onboarding');
      if (!response.ok) throw new Error('Compute setup unavailable');
      return computeOnboardingSchema.parse(await response.json());
    } });
  const selectSection = useGpuStore(state => state.selectProjectSection);
  // Pairing persists while a computer is offline. Presence is never proof
  // that the viewer has not paired one, and server-capable admins need no setup.
  if (hostedAllowed || query.data?.hostedAllowed) return null;
  if (query.isPending) return <AtomaLoader label={t('compute.onboarding.loading')} />;
  const error = query.isError ? <p role="alert" className="gpu-compute-onboarding-error">{t('compute.loadFailed')}
    <button type="button" onClick={() => void query.refetch()}><ButtonIcon kind="refresh" />{t('compute.refresh')}</button></p> : null;
  if (!query.data) return error;
  const devices = query.data.devices;
  const anyConnected = devices.some(device => device.connected);
  if (devices.length > 0) return <details className="gpu-compute-onboarding-summary">
    <summary><span>{t('compute.onboarding.readyTitle')}</span><span className={anyConnected ? 'gpu-compute-connected' : undefined}>
      {t(anyConnected ? 'compute.onboarding.connected' : 'compute.availability.disconnected')}</span></summary>
    <div>
      {devices.map(device => <p key={device.deviceId}>{device.name} · {t(device.connected ? 'compute.onboarding.connected' : 'compute.availability.disconnected')}</p>)}
      {error}
      <p>{t('compute.onboarding.selectProject')}</p>
      <div className="gpu-compute-onboarding-actions">
        {projectId ? <button type="button" onClick={() => selectSection('settings')}><ButtonIcon kind="settings" />{t('compute.onboarding.projectSettings')}</button> : null}
        <a href={`/compute/setup?lang=${encodeURIComponent(locale)}`}>{t('compute.connectAnother')}</a>
      </div>
    </div>
  </details>;
  return <section className="gpu-assistant-setup" aria-label={t('compute.onboarding.title')}>
    <h3>{t('compute.onboarding.title')}</h3>
    <p>{t('compute.onboarding.intro')}</p>
    {error}
    <a href={`/compute/setup?lang=${encodeURIComponent(locale)}`}>{t('compute.connectComputer')}</a>
  </section>;
}
