import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual, createHmac } from 'node:crypto';
const HOME = homedir();
const VAULT_DIR = join(HOME, '.shre', 'vault');
const AUTH_PROFILES_DIR = existsSync(join(HOME, '.shre', 'agents'))
    ? join(HOME, '.shre')
    : join(HOME, '.openclaw');
export function readVaultKey(filename) {
    if (filename.includes('..') ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.startsWith('~') ||
        resolve(VAULT_DIR, filename) !== join(VAULT_DIR, filename)) {
        return '';
    }
    try {
        return readFileSync(join(VAULT_DIR, filename), 'utf-8').trim();
    }
    catch (err) {
        return '';
    }
}
export function readAuthProfile(profileName, agentId) {
    const agents = agentId ? [agentId] : ['shre', 'main'];
    for (const agent of agents) {
        try {
            const path = join(AUTH_PROFILES_DIR, 'agents', agent, 'agent', 'auth-profiles.json');
            const raw = readFileSync(path, 'utf-8');
            const data = JSON.parse(raw);
            const key = data?.profiles?.[profileName]?.key;
            if (key)
                return key;
        }
        catch (err) {
            continue;
        }
    }
    return '';
}
export function readGatewayToken() {
    const envToken = process.env.SHRE_GATEWAY_TOKEN;
    if (envToken)
        return envToken;
    try {
        const legacyDir = join(HOME, '.openclaw');
        const raw = readFileSync(join(legacyDir, 'openclaw.json'), 'utf-8');
        const data = JSON.parse(raw);
        return data?.gateway?.auth?.token ?? '';
    }
    catch (_err) {
        return '';
    }
}
const PROVIDER_PROFILES = {
    anthropic: 'anthropic:default',
    openai: 'openai:default',
    google: 'google:default',
    xai: 'xai:default',
};
const PROVIDER_ENV_VARS = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    xai: 'XAI_API_KEY',
    keith: 'KEITH_API_KEY',
};
export function resolveProviderKey(provider) {
    const profile = PROVIDER_PROFILES[provider];
    if (profile) {
        const key = readAuthProfile(profile);
        if (key)
            return key;
    }
    const envVar = PROVIDER_ENV_VARS[provider];
    if (envVar) {
        const key = process.env[envVar];
        if (key)
            return key;
    }
    return '';
}
export function validateBearerToken(authHeader, expectedToken) {
    if (!authHeader || !expectedToken)
        return false;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (token.length !== expectedToken.length)
        return false;
    try {
        return timingSafeEqual(Buffer.from(token, 'utf-8'), Buffer.from(expectedToken, 'utf-8'));
    }
    catch (err) {
        return false;
    }
}
export function createServiceAuth(envVarName, vaultFilename) {
    let token = '';
    if (vaultFilename) {
        token = readVaultKey(vaultFilename);
    }
    if (!token) {
        token = process.env[envVarName] ?? '';
    }
    return {
        token,
        validate: (authHeader) => validateBearerToken(authHeader, token),
        hasToken: token.length > 0,
    };
}
export function authHeaders(vaultFilename) {
    const token = readVaultKey(vaultFilename);
    if (!token)
        return {};
    return { Authorization: `Bearer ${token}` };
}
export function requireBearerAuth(envVarName, vaultFilename) {
    const { token, hasToken } = createServiceAuth(envVarName, vaultFilename);
    if (!hasToken) {
        return (_req, _res, next) => next();
    }
    return (req, res, next) => {
        const authHeader = req.headers?.['authorization'] ?? req.headers?.['Authorization'] ?? null;
        if (validateBearerToken(authHeader ?? null, token)) {
            next();
        }
        else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };
}
export function generateServiceHMAC(serviceName, payload, secret) {
    const key = secret || readVaultKey(`${serviceName}.key`) || process.env.SHRE_SERVICE_SECRET || '';
    if (!key)
        return '';
    return createHmac('sha256', key).update(payload).digest('hex');
}
export function verifyServiceHMAC(serviceName, payload, signature, secret) {
    const expected = generateServiceHMAC(serviceName, payload, secret);
    if (!expected || !signature)
        return false;
    try {
        return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    }
    catch {
        return false;
    }
}
export function serviceIdentityMiddleware(opts) {
    return async (c, next) => {
        const signature = c.req.header('X-Shre-Signature');
        const sourceService = c.req.header('X-Shre-Service');
        const timestamp = c.req.header('X-Shre-Timestamp');
        if (!signature || !sourceService || !timestamp) {
            return c.json({ error: 'Missing service identity headers' }, 401);
        }
        const now = Date.now();
        const ts = parseInt(timestamp, 10);
        if (isNaN(ts) || Math.abs(now - ts) > 300_000) {
            return c.json({ error: 'Identity timestamp expired or invalid' }, 401);
        }
        const payload = `${sourceService}:${timestamp}`;
        const isValid = verifyServiceHMAC(sourceService, payload, signature, opts.secret);
        if (isValid) {
            return next();
        }
        else {
            return c.json({ error: 'Invalid service signature' }, 401);
        }
    };
}
let _signingKey = null;
let _signingKeyLoadedAt = 0;
const SIGNING_KEY_RELOAD_MS = 60_000;
function loadSigningKey() {
    const now = Date.now();
    if (_signingKey && now - _signingKeyLoadedAt < SIGNING_KEY_RELOAD_MS)
        return _signingKey;
    const keyPath = join(HOME, '.shre', 'auth', 'signing-key.hex');
    try {
        const hex = readFileSync(keyPath, 'utf-8').trim();
        _signingKey = Buffer.from(hex, 'hex');
        _signingKeyLoadedAt = now;
        return _signingKey;
    }
    catch {
        return null;
    }
}
export function validateJWTLocally(token) {
    try {
        const key = loadSigningKey();
        if (!key)
            return null;
        const parts = token.split('.');
        if (parts.length !== 3)
            return null;
        const header = parts[0];
        const payload = parts[1];
        const signature = parts[2];
        const expected = createHmac('sha256', key)
            .update(`${header}.${payload}`, 'utf-8')
            .digest('base64url');
        const expBuf = Buffer.from(expected, 'utf-8');
        const sigBuf = Buffer.alloc(expBuf.length);
        Buffer.from(signature, 'utf-8').copy(sigBuf, 0, 0, Math.min(signature.length, expBuf.length));
        if (!timingSafeEqual(sigBuf, expBuf))
            return null;
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
        const now = Math.floor(Date.now() / 1000);
        if (claims.exp < now)
            return null;
        if (claims.tokenType !== 'platform_user')
            return null;
        return claims;
    }
    catch {
        return null;
    }
}
const GLOBAL_AUTH_CACHE = new Map();
const DEFAULT_CACHE_TTL = 300_000;
const OFFLINE_CACHE_TTL = 30_000;
let _revocationSubscribed = false;
export function initAuthCache(eventBus) {
    if (_revocationSubscribed || !eventBus)
        return;
    _revocationSubscribed = true;
    onTokenRevoked(eventBus, (subject) => {
        for (const [token, entry] of GLOBAL_AUTH_CACHE) {
            if (entry.claims.sub === subject || entry.claims.id === subject) {
                GLOBAL_AUTH_CACHE.delete(token);
            }
        }
    });
}
export function requireUserAuth(opts) {
    const authUrl = process.env.SHRE_AUTH_URL || 'http://127.0.0.1:5455';
    const ttl = opts?.cacheTtl ?? DEFAULT_CACHE_TTL;
    const ROLE_CLEARANCE = {
        owner: 100,
        admin: 80,
        member: 40,
        viewer: 20,
    };
    return async (c, next) => {
        const authHeader = c.req?.header?.('Authorization') ?? '';
        if (!authHeader.startsWith('Bearer ')) {
            return c.json({ error: 'Unauthorized', code: 'MISSING_TOKEN' }, 401);
        }
        const token = authHeader.slice(7);
        try {
            let claims = null;
            const cached = GLOBAL_AUTH_CACHE.get(token);
            const effectiveTtl = cached?.offline ? OFFLINE_CACHE_TTL : ttl;
            if (cached && Date.now() - cached.cachedAt < effectiveTtl) {
                claims = cached.claims;
            }
            else {
                let authSuccess = false;
                try {
                    const res = await fetch(`${authUrl}/v1/auth/validate-user`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token }),
                        signal: AbortSignal.timeout(3000),
                    });
                    if (res.ok) {
                        const result = (await res.json());
                        if (!result.valid || !result.claims) {
                            GLOBAL_AUTH_CACHE.delete(token);
                            return c.json({ error: 'Invalid token', code: 'INVALID_TOKEN' }, 401);
                        }
                        claims = result.claims;
                        GLOBAL_AUTH_CACHE.set(token, { claims, cachedAt: Date.now() });
                        authSuccess = true;
                        if (GLOBAL_AUTH_CACHE.size > 2000) {
                            const oldestKey = GLOBAL_AUTH_CACHE.keys().next().value;
                            if (oldestKey !== undefined)
                                GLOBAL_AUTH_CACHE.delete(oldestKey);
                        }
                    }
                }
                catch {
                }
                if (!authSuccess) {
                    if (cached) {
                        console.warn('[auth] shre-auth down, using stale cache for', cached.claims.sub);
                        claims = cached.claims;
                    }
                    else {
                        const localClaims = validateJWTLocally(token);
                        if (localClaims) {
                            console.warn('[auth] shre-auth down, validated locally for', localClaims.sub);
                            claims = {
                                sub: localClaims.sub,
                                role: localClaims.role,
                                scopes: localClaims.scopes,
                                isSuperAdmin: localClaims.isSuperAdmin,
                                activeWorkspaceId: localClaims.activeWorkspaceId,
                                activeWorkspaceName: localClaims.activeWorkspaceName,
                                workspaceIds: localClaims.workspaceIds,
                                email: localClaims.email,
                                name: localClaims.name,
                                jti: localClaims.jti,
                            };
                            GLOBAL_AUTH_CACHE.set(token, { claims, cachedAt: Date.now(), offline: true });
                        }
                        else {
                            return c.json({
                                error: 'Auth service unavailable and local validation failed',
                                code: 'AUTH_UNREACHABLE',
                            }, 503);
                        }
                    }
                }
            }
            if (!claims) {
                return c.json({ error: 'Auth validation failed', code: 'AUTH_ERROR' }, 500);
            }
            if (opts?.requiredScope && !claims.isSuperAdmin) {
                const has = claims.scopes?.includes('*') || claims.scopes?.includes(opts.requiredScope);
                if (!has) {
                    return c.json({ error: 'Insufficient scope', code: 'FORBIDDEN', required: opts.requiredScope }, 403);
                }
            }
            if (opts?.requiredRole && !claims.isSuperAdmin) {
                const required = ROLE_CLEARANCE[opts.requiredRole] ?? 0;
                const current = (claims.role ? ROLE_CLEARANCE[claims.role] : 0) ?? 0;
                if (current < required) {
                    return c.json({ error: 'Insufficient role', code: 'INSUFFICIENT_ROLE' }, 403);
                }
            }
            c.set('user', claims);
            return next();
        }
        catch (err) {
            const localClaims = validateJWTLocally(token);
            if (localClaims) {
                console.warn('[auth] Exception in auth chain, validated locally for', localClaims.sub);
                c.set('user', {
                    sub: localClaims.sub,
                    role: localClaims.role,
                    scopes: localClaims.scopes,
                    isSuperAdmin: localClaims.isSuperAdmin,
                    activeWorkspaceId: localClaims.activeWorkspaceId,
                    workspaceIds: localClaims.workspaceIds,
                });
                return next();
            }
            console.error('[auth] Auth chain failed completely', { error: err.message });
            return c.json({ error: 'Auth service unreachable', code: 'AUTH_UNREACHABLE' }, 503);
        }
    };
}
export function onTokenRevoked(eventBus, handler) {
    return eventBus.subscribe('auth.revoked', async (event) => {
        const subject = event.data?.subject ?? '';
        const revokedAt = event.data?.revoked_at ?? event.ts;
        const revokedCount = event.data?.revoked_count ?? 0;
        if (subject) {
            await handler(subject, revokedAt, revokedCount);
        }
    });
}
export function createTokenCache(eventBus) {
    const cache = new Map();
    const unsub = onTokenRevoked(eventBus, (subject) => {
        cache.delete(subject);
    });
    return {
        get: (subject) => cache.get(subject),
        set: (subject, token) => cache.set(subject, token),
        delete: (subject) => cache.delete(subject),
        clear: () => cache.clear(),
        size: () => cache.size,
        shutdown: unsub,
    };
}
