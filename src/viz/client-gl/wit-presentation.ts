import type { WitReport } from '../../contracts/witReport.js';
export const WIT_STATUSES = ['passed', 'generated', 'failed', 'error', 'unknown'] as const;
export function witCounts(report: WitReport) {
  return WIT_STATUSES.map(status => ({ status, count: report.receipts.filter(row => row.status === status).length }));
}
