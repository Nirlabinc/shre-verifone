import { resolveAllHosts } from './discovery.js';
import { createResilience } from './resilience.js';
import { Agent } from 'node:https';
const httpsAgent = new Agent({ rejectUnauthorized: false });
function isRetryable(err) {
    const msg = err.message || '';
    if (/\b4\d{2}\b/.test(msg) && !msg.includes('429'))
        return false;
    if (msg.includes('401') || msg.includes('403'))
        return false;
    return true;
}
export function createServiceClient(caller) {
    const resilience = createResilience({
        service: `svc-client:${caller}`,
        defaults: {
            maxRetries: 2,
            baseDelayMs: 500,
            backoff: 2,
            jitter: 0.15,
            timeoutMs: 10_000,
            retryIf: isRetryable,
        },
    });
    async function doFetch(service, path, opts = {}) {
        const hosts = resolveAllHosts(service);
        const { getPorts } = await import('./discovery.js');
        const ports = getPorts();
        const entry = ports.services[service] || ports.infrastructure[service];
        const port = entry?.port || 80;
        const forceHttp = process.env.SHRE_FORCE_HTTP !== '0';
        const protocol = forceHttp ? 'http' : entry?.protocol || 'http';
        const headers = {
            'x-caller': caller,
            ...(opts.headers || {}),
        };
        if (opts.body && !headers['content-type'] && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        return resilience.fallbackChain(hosts.map((host) => ({
            name: `${service}@${host}`,
            fn: async () => {
                const url = `${protocol}://${host}:${port}${path}`;
                const isHttps = protocol === 'https';
                const fetchOpts = {
                    method: opts.method || 'GET',
                    headers,
                    signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 10_000),
                    ...(opts.body
                        ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }
                        : {}),
                    ...(isHttps ? { dispatcher: httpsAgent } : {}),
                };
                const res = await globalThis.fetch(url, fetchOpts);
                if (!res.ok && !opts.stream) {
                    const text = await res.text().catch(() => '');
                    const method = opts.method || 'GET';
                    throw new Error(`${service} ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
                }
                return res;
            },
        })));
    }
    return {
        async call(service, path, opts = {}) {
            const retryOpts = {
                maxRetries: opts.retries ?? 2,
                timeoutMs: opts.timeoutMs ?? 10_000,
            };
            const res = await resilience.wrap(`${service}:${opts.method || 'GET'}:${path}`, () => doFetch(service, path, opts), retryOpts);
            return res.json();
        },
        async fetch(service, path, opts = {}) {
            const retryOpts = {
                maxRetries: opts.stream ? 1 : (opts.retries ?? 2),
                timeoutMs: opts.timeoutMs ?? 10_000,
            };
            return resilience.wrap(`${service}:${opts.method || 'GET'}:${path}`, () => doFetch(service, path, { ...opts, stream: true }), retryOpts);
        },
        async healthy(service) {
            try {
                const res = await doFetch(service, '/health', { timeoutMs: 3_000 });
                return res.ok;
            }
            catch {
                return false;
            }
        },
    };
}
