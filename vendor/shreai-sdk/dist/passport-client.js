import { serviceUrl } from './discovery.js';
import { validateJWTLocally } from './auth.js';
export function createPassportClient(opts) {
    const cacheTtl = opts?.cacheTtlMs ?? 60_000;
    const cache = new Map();
    if (opts?.bus) {
        opts.bus.subscribe('auth.revoked', async (event) => {
            const subject = event.data?.subject;
            if (subject) {
                for (const [key, val] of cache) {
                    if (val.payload.entityId === subject || val.payload.passportId === subject) {
                        cache.delete(key);
                    }
                }
            }
        });
    }
    async function verify(token) {
        const cached = cache.get(token);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.payload;
        }
        cache.delete(token);
        const baseUrl = opts?.passportUrl ?? serviceUrl('shre-passport');
        const doFetch = () => fetch(`${baseUrl}/v1/passport/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
            signal: AbortSignal.timeout(3000),
        });
        try {
            const res = opts?.breakerCall ? await opts.breakerCall(doFetch) : await doFetch();
            if (!res.ok)
                return null;
            const data = (await res.json());
            if (!data.valid)
                return null;
            const payload = {
                passportId: data.passportId,
                entityId: data.entityId,
                type: data.type,
                scopes: data.scopes,
                clearanceTier: data.clearanceTier,
            };
            cache.set(token, { payload, expiresAt: Date.now() + cacheTtl });
            return payload;
        }
        catch (err) {
            console.debug('[passport-client] Remote verification failed, trying local JWT', {
                error: err.message,
            });
            const localClaims = validateJWTLocally(token);
            if (localClaims) {
                const fallbackPayload = {
                    passportId: localClaims.jti,
                    entityId: localClaims.sub,
                    type: 'platform_user',
                    scopes: localClaims.scopes ?? [],
                    clearanceTier: localClaims.isSuperAdmin
                        ? 100
                        : ({ owner: 100, admin: 80, member: 40, viewer: 20 }[localClaims.role] ?? 20),
                };
                cache.set(token, {
                    payload: fallbackPayload,
                    expiresAt: Date.now() + Math.min(cacheTtl, 30_000),
                });
                console.warn('[passport-client] Using local JWT fallback for', localClaims.sub);
                return fallbackPayload;
            }
            return null;
        }
    }
    return {
        verify,
        clearCache: () => cache.clear(),
    };
}
export function requirePassport(client, opts) {
    return async (c, next) => {
        const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            if (opts?.optional)
                return next();
            return c.json({ error: 'Unauthorized — passport required', code: 'NO_TOKEN' }, 401);
        }
        const token = authHeader.slice(7);
        const payload = await client.verify(token);
        if (!payload) {
            if (opts?.optional)
                return next();
            return c.json({ error: 'Invalid or expired passport', code: 'INVALID_TOKEN' }, 401);
        }
        c.set('passport', payload);
        c.set('tenant', { tenantId: payload.entityId });
        return next();
    };
}
export function passportHeaders(token) {
    return { Authorization: `Bearer ${token}` };
}
