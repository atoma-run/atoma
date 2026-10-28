/** The same project-history reference in receipts, activity and live status. */
export function RunNumber({ number, t }: {
  number: number | null;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  return number === null ? null : <strong className="gpu-run-number">{t('runs.number', { number })}</strong>;
}
