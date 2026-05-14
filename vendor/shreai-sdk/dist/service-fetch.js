import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Agent } from 'node:https';
const CA_PATHS = [
    join(homedir(), 'Library', 'Application Support', 'mkcert', 'rootCA.pem'),
    join(homedir(), '.local', 'share', 'mkcert', 'rootCA.pem'),
    join(homedir(), '.shre', 'tls', 'rootCA.pem'),
    process.env.NODE_EXTRA_CA_CERTS ?? '',
].filter(Boolean);
let _caCert = null;
let _caResolved = false;
function resolveCACert() {
    if (_caResolved)
        return _caCert;
    _caResolved = true;
    for (const p of CA_PATHS) {
        try {
            if (existsSync(p)) {
                _caCert = readFileSync(p, 'utf-8');
                return _caCert;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
let _agent = null;
export function createServiceAgent() {
    if (_agent)
        return _agent;
    const ca = resolveCACert();
    _agent = new Agent({
        ...(ca ? { ca } : {}),
        keepAlive: true,
        maxSockets: 50,
        timeout: 30_000,
    });
    return _agent;
}
export function createServiceFetch(_serviceName) {
    createServiceAgent();
    return async function serviceFetch(url, init) {
        const timeout = init?.timeout ?? 30_000;
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        if (['POST', 'PUT', 'PATCH'].includes(method) && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        const fetchOpts = {
            ...init,
            method,
            headers,
            signal: init?.signal ?? AbortSignal.timeout(timeout),
        };
        if (!process.env.NODE_EXTRA_CA_CERTS) {
            const ca = resolveCACert();
            if (ca) {
                const caPath = CA_PATHS.find((p) => existsSync(p));
                if (caPath)
                    process.env.NODE_EXTRA_CA_CERTS = caPath;
            }
        }
        return fetch(url, fetchOpts);
    };
}
