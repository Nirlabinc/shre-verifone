import { serviceUrl } from './discovery.js';
import { createLogger } from './logger.js';
const log = createLogger('shre-sdk:context');
const CONTEXT_TIMEOUT_MS = 5_000;
export async function fetchContext(req) {
    const empty = {
        layers: [],
        injection: '',
        totalLatencyMs: 0,
        requestedLayers: req.layers || ['soul', 'platform', 'rag', 'data', 'contacts'],
        healthReport: '',
        contextHealth: {},
        meta: {
            soulMode: 'unknown',
            agentId: req.agentId || null,
            tenantId: req.tenantId || null,
            platformDetected: null,
            totalChars: 0,
            timestamp: new Date().toISOString(),
        },
    };
    try {
        const base = serviceUrl('shre-context');
        const res = await fetch(`${base}/v1/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS),
        });
        if (!res.ok) {
            log.warn('shre-context returned non-OK', { status: res.status });
            return empty;
        }
        return (await res.json());
    }
    catch (err) {
        log.warn('shre-context unreachable (non-fatal)', { error: err.message });
        return empty;
    }
}
export async function getContextInjection(agentId, prompt, tenantId) {
    const pkg = await fetchContext({ agentId, prompt, tenantId });
    return pkg.injection;
}
