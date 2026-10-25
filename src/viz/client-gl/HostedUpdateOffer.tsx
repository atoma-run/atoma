import { ButtonIcon } from './ButtonIcon.js';
import { buttonIconKind } from './button-icons.js';
import type { HostedUpdateOffer, HostingControl } from './project-deployment.js';

/**
 * The online application's next step where a person reads an accepted run:
 * the conversation's run card and the DOM twin of the run's result page.
 * The canvas draws the same `hostedUpdateOffer` model (renderer/views/result.ts).
 */
export function HostedUpdateOfferSection({ offer, t, onActivate }: {
  offer: HostedUpdateOffer;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onActivate: (id: string) => void;
}) {
  const control = (button: HostingControl) => <button key={button.id} type="button" disabled={Boolean(button.disabled)}
    onClick={() => onActivate(button.id)}><ButtonIcon kind={buttonIconKind(button.id)} />{t(button.label ?? button.id)}</button>;
  return <section aria-label={t('hosting.offer.region')}>
    {offer.lead ? <p>{t(offer.lead)}</p> : null}
    {offer.progress ? <p role="status">{t(offer.progress)}</p> : null}
    {offer.error ? <p role="alert">{t(offer.error)}</p> : null}
    {offer.askAdmin ? <p>{t(offer.askAdmin)}</p> : null}
    {offer.confirm ? <div role="group" aria-label={t('hosting.update')}>
      <p>{t(offer.confirm.message)}</p>
      <div className="gpu-assistant-message-actions">{offer.confirm.actions.map(control)}</div>
    </div> : null}
    {offer.actions.length ? <div className="gpu-assistant-message-actions">{offer.actions.map(control)}</div> : null}
  </section>;
}
