/**
 * shre-verifone observability wiring.
 *
 * Re-exports trace and heartbeat utilities used by live-server.mjs.
 * Provides createTraceMiddleware for raw HTTP servers (non-Express).
 */

import {
  createTraceMiddleware,
  createTrace,
  getRecentTraces,
  getRecentFailures,
  getTraceStats,
} from 'shre-sdk/trace';
import { createHeartbeatMonitor } from 'shre-sdk/heartbeat';

/**
 * Apply trace middleware to a raw Node HTTP request/response pair.
 * For use in createServer() handlers (not Express).
 */
export function applyTrace(serviceName, req) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || undefined;
  const trace = createTrace(serviceName, correlationId);
  const url = new URL(req.url, `http://localhost`);
  trace.setRequest?.({ method: req.method, path: url.pathname });
  return trace;
}

/**
 * Standard observability route paths:
 *   /v1/traces         — recent traces
 *   /v1/traces/failures — recent failures
 *   /v1/traces/stats   — aggregate stats
 *
 * These are wired in live-server.mjs via getRecentTraces/getRecentFailures/getTraceStats.
 */

export {
  createTraceMiddleware,
  createTrace,
  getRecentTraces,
  getRecentFailures,
  getTraceStats,
  createHeartbeatMonitor,
};
