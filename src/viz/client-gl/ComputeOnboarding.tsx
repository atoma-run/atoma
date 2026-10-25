import { useQuery } from '@tanstack/react-query';
import { computeOnboardingSchema } from '../../contracts/computeProject.js';
import { useGpuStore } from './store.js';

/** One account-scoped setup step, including before the first project exists. */
export function ComputeOnboarding({ scopeKey, projectId, locale, t }: {
  scopeKey: string; projectId: string | null; locale: string; t: (key: string) => string;
}) {
  const query = useQuery({ queryKey: ['compute-onboarding', scopeKey], retry: false, refetchInterval: 10_000,
    queryFn: async () => {
      const response = await fetch('/api/compute/onboarding');
      if (!response.ok) throw new Error('Compute setup unavailable');
      return computeOnboardingSchema.parse(await response.json());
    } });
  const selectSection = useGpuStore(state => state.selectProjectSection);
  // A connected computer already answers "Connect a computer": an administrator
  // who may run on the server needs no prompt, a member is offered another one.
  const anyConnected = query.data?.devices.some(device => device.connected) ?? false;
  const connectKey = anyConnected ? 'compute.connectAnother' : 'compute.connectComputer';
  if (query.data?.hostedAllowed) return anyConnected ? null : <p><a href={`/compute/setup?lang=${encodeURIComponent(locale)}`}>{t(connectKey)}</a></p>;
  return <section className="gpu-assistant-setup" aria-label={t('compute.onboarding.title')}>
    <h3>{t(query.data?.devices.length ? 'compute.onboarding.readyTitle' : 'compute.onboarding.title')}</h3>
    <p>{t('compute.onboarding.intro')}</p>
    {query.isPending ? <p role="status">{t('compute.onboarding.loading')}</p> : null}
    {query.isError ? <p role="alert">{t('compute.loadFailed')} <button type="button" onClick={() => void query.refetch()}>{t('compute.refresh')}</button></p> : null}
    {query.data?.devices.map(device => <p key={device.deviceId}>{device.name} · {t(device.connected ? 'compute.onboarding.connected' : 'compute.availability.disconnected')}</p>)}
    <a href={`/compute/setup?lang=${encodeURIComponent(locale)}`}>{t(connectKey)}</a>
    {query.data?.devices.length ? <>
      <p>{t('compute.onboarding.selectProject')}</p>
      {projectId ? <button type="button" onClick={() => selectSection('settings')}>{t('compute.onboarding.projectSettings')}</button> : null}
    </> : null}
  </section>;
}
