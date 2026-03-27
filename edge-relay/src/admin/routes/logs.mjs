/**
 * Logs API Routes — view activity and audit logs
 */

import { getActivityLog, getActivitySummary } from '../../secretservice/activity-logger.mjs';
import { getAuditLog } from '../../secretservice/audit-chain.mjs';
import { getRecentAnomalies } from '../../secretservice/anomaly-detector.mjs';

export function logsRoutes(routes) {
  // Activity log (paginated)
  routes.set('GET /api/logs/activity', {
    fn: async ({ url }) => {
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const direction = url.searchParams.get('direction');
      const since = url.searchParams.get('since');
      return { body: { logs: getActivityLog({ limit, direction, since }) } };
    },
  });

  // Activity summary
  routes.set('GET /api/logs/activity/summary', {
    fn: async ({ url }) => {
      const since = url.searchParams.get('since');
      return { body: { summary: getActivitySummary(since) } };
    },
  });

  // Audit chain log
  routes.set('GET /api/logs/audit', {
    fn: async ({ url }) => {
      const limit = parseInt(url.searchParams.get('limit') || '100');
      return { body: { audit: getAuditLog(limit) } };
    },
  });

  // Anomaly events
  routes.set('GET /api/logs/anomalies', {
    fn: async ({ url }) => {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      return { body: { anomalies: getRecentAnomalies(limit) } };
    },
  });
}
