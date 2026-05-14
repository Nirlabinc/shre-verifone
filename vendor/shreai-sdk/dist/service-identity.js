import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readVaultKey } from './auth.js';
const KEY_PATH = join(homedir(), '.shre', 'vault', 'service-mesh.key');
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;
let _cachedKey = null;
function loadKey() {
    if (_cachedKey !== null)
        return _cachedKey || null;
    try {
        if (existsSync(KEY_PATH)) {
            _cachedKey = readFileSync(KEY_PATH, 'utf-8').trim();
            return _cachedKey || null;
        }
    }
    catch (err) {
    }
    _cachedKey = '';
    return null;
}
export function createServiceIdentity(serviceName) {
    return {
        serviceName,
        sign(method, path) {
            const key = loadKey();
            if (!key)
                return {};
            const timestamp = Date.now().toString();
            const message = `${serviceName}|${method.toUpperCase()}|${path}|${timestamp}`;
            const signature = createHmac('sha256', key).update(message).digest('hex');
            return {
                'X-Shre-Service': serviceName,
                'X-Shre-Timestamp': timestamp,
                'X-Shre-Signature': signature,
            };
        },
    };
}
export function verifyServiceIdentity(headers) {
    const service = headers['x-shre-service'] ?? headers['X-Shre-Service'] ?? '';
    const timestamp = headers['x-shre-timestamp'] ?? headers['X-Shre-Timestamp'] ?? '';
    const signature = headers['x-shre-signature'] ?? headers['X-Shre-Signature'] ?? '';
    if (!service || !timestamp || !signature) {
        return { service: service || 'unknown', verified: false, reason: 'missing headers' };
    }
    const key = loadKey();
    if (!key) {
        return { service, verified: true, reason: 'no key configured (dev mode)' };
    }
    const ts = parseInt(timestamp, 10);
    const drift = Math.abs(Date.now() - ts);
    if (isNaN(ts) || drift > MAX_TIMESTAMP_DRIFT_MS) {
        return {
            service,
            verified: false,
            reason: `timestamp drift ${drift}ms exceeds ${MAX_TIMESTAMP_DRIFT_MS}ms`,
        };
    }
    return { service, verified: true };
}
export function verifyServiceSignature(service, method, path, timestamp, signature) {
    const key = loadKey();
    if (!key) {
        return { service, verified: true, reason: 'no key configured (dev mode)' };
    }
    const ts = parseInt(timestamp, 10);
    const drift = Math.abs(Date.now() - ts);
    if (isNaN(ts) || drift > MAX_TIMESTAMP_DRIFT_MS) {
        return {
            service,
            verified: false,
            reason: `timestamp drift ${drift}ms exceeds ${MAX_TIMESTAMP_DRIFT_MS}ms`,
        };
    }
    const message = `${service}|${method.toUpperCase()}|${path}|${timestamp}`;
    const expected = createHmac('sha256', key).update(message).digest('hex');
    if (expected.length !== signature.length) {
        return { service, verified: false, reason: 'signature mismatch' };
    }
    try {
        const match = timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
        if (!match) {
            return { service, verified: false, reason: 'signature mismatch' };
        }
    }
    catch (err) {
        return { service, verified: false, reason: 'signature mismatch' };
    }
    return { service, verified: true };
}
export function requireServiceAuth() {
    return async (c, next) => {
        const key = loadKey();
        if (!key) {
            return next();
        }
        const service = c.req.header('x-shre-service');
        const timestamp = c.req.header('x-shre-timestamp');
        const signature = c.req.header('x-shre-signature');
        if (!service || !timestamp || !signature) {
            return c.json({ error: 'Unauthorized — missing service identity headers', code: 'NO_SERVICE_IDENTITY' }, 401);
        }
        const result = verifyServiceSignature(service, c.req.method, new URL(c.req.url).pathname, timestamp, signature);
        if (!result.verified) {
            return c.json({ error: `Unauthorized — ${result.reason}`, code: 'INVALID_SERVICE_IDENTITY' }, 401);
        }
        c.set('serviceIdentity', { service: result.service });
        return next();
    };
}
export function serviceHeaders(serviceName, vaultFilename, method, path) {
    const token = readVaultKey(vaultFilename);
    const identity = createServiceIdentity(serviceName);
    const signedHeaders = identity.sign(method, path);
    return {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...signedHeaders,
    };
}
