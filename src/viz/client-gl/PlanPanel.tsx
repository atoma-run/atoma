import { PLAN_IDS, type AccountPlan, type PlanId } from '../../contracts/accountPlan.js';

/**
 * YOUR PLAN — where the account stands commercially, in the one screen the
 * account already opens.
 *
 * ONE PLAN IS REAL DURING THE BETA. The server names it (`organisation.plan`)
 * and the card draws it with the limits THIS instance enforces, read from the
 * platform settings rather than typed here: the screen can never promise a
 * run budget the run path refuses. The paid plans are PREVIEWS — greyed,
 * `aria-disabled`, with no button at all. A disabled "Upgrade" would be a
 * promise of a flow that does not exist; a card that says "coming" is a fact.
 *
 * NO PRICES. None is decided, and a number on this screen reads as a quote.
 * Every word here is catalog copy; the plan ids come from the contract.
 */

/** What each plan offers, as catalog keys under `plan.feature.*`. */
const PLAN_FEATURES: Readonly<Record<PlanId, readonly string[]>> = {
  free: ['ownSubscriptions', 'sharedCatalogue', 'projectsAndMcp', 'standardQueue'],
  pro: ['queuePriority', 'moreConcurrentRuns', 'longerRuns', 'higherSpendCap', 'prioritySupport'],
  team: ['everythingInPro', 'manyConcurrentRuns', 'organisationBilling', 'usageReports', 'dedicatedSupport'],
};

/** Whole hours where the budget is one, minutes otherwise: a run budget, not a stopwatch. */
export function formatRunTime(ms: number, t: PlanPanelProps['t']): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return t('plan.limit.hours', { count: minutes / 60 });
  return t('plan.limit.minutes', { count: minutes });
}

export interface PlanPanelProps {
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: string;
  plan: AccountPlan | null;
}

export function PlanPanel({ t, locale, plan }: PlanPanelProps) {
  const current: PlanId = plan?.current ?? 'free';
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const integer = new Intl.NumberFormat(locale);
  return (
    <>
      <p className="gpu-org-models-title">{t('plan.title')}</p>
      <p className="gpu-org-models-hint">
        {t(plan?.beta === false ? 'plan.hint' : 'plan.hintBeta')}
      </p>
      <div className="gpu-plan-grid">
        {PLAN_IDS.map((id) => {
          const isCurrent = id === current;
          return (
            <section
              key={id}
              className="gpu-plan-card"
              data-plan={id}
              data-current={isCurrent ? 'true' : 'false'}
              aria-disabled={isCurrent ? undefined : true}
              aria-labelledby={`plan-name-${id}`}
            >
              <div className="gpu-plan-card-head">
                <span id={`plan-name-${id}`} className="gpu-plan-name">{t(`plan.name.${id}`)}</span>
                <span className="gpu-plan-badges">
                  {isCurrent ? (
                    <span className="gpu-subscription-state" data-state="connected">{t('plan.current')}</span>
                  ) : (
                    <span className="gpu-subscription-state">{t('plan.comingSoon')}</span>
                  )}
                  {isCurrent && plan?.beta !== false ? (
                    <span className="gpu-subscription-state" data-state="connecting">{t('plan.beta')}</span>
                  ) : null}
                </span>
              </div>
              <p>{t(`plan.summary.${id}`)}</p>
              {isCurrent && plan ? (
                <dl className="gpu-org-directory-facts gpu-plan-limits" aria-label={t('plan.limits')}>
                  <div>
                    <dt>{t('plan.limit.concurrentRuns')}</dt>
                    <dd>{t('plan.limit.concurrentRunsValue', { count: plan.limits.concurrentRuns })}</dd>
                  </div>
                  <div>
                    <dt>{t('plan.limit.runTime')}</dt>
                    <dd>{formatRunTime(plan.limits.runTimeoutMs, t)}</dd>
                  </div>
                  <div>
                    <dt>{t('plan.limit.spendCap')}</dt>
                    <dd>
                      {plan.limits.runCostMaxUsd > 0
                        ? t('plan.limit.perRun', { value: usd.format(plan.limits.runCostMaxUsd) })
                        : t('plan.limit.none')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('plan.limit.tokenCap')}</dt>
                    <dd>
                      {plan.limits.runTokenMax > 0
                        ? t('plan.limit.perRun', { value: integer.format(plan.limits.runTokenMax) })
                        : t('plan.limit.none')}
                    </dd>
                  </div>
                </dl>
              ) : null}
              <ul className="gpu-plan-features">
                {PLAN_FEATURES[id].map((feature) => (
                  <li key={feature}>{t(`plan.feature.${feature}`)}</li>
                ))}
              </ul>
              {isCurrent ? null : (
                <p className="gpu-plan-unavailable">{t('plan.unavailableBeta')}</p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
