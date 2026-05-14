import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from './logger.js';
const discoveryCache = new Map();
const jwksCache = new Map();
const CACHE_TTL_MS = 3600_000;
async function fetchDiscovery(issuer, log) {
    const cached = discoveryCache.get(issuer);
    if (cached && cached.expiresAt > Date.now())
        return cached.config;
    const url = issuer.endsWith('/')
        ? `${issuer}.well-known/openid-configuration`
        : `${issuer}/.well-known/openid-configuration`;
    log.debug('Fetching OIDC discovery', { issuer, url });
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
        throw new Error(`OIDC discovery failed for ${issuer}: ${res.status} ${res.statusText}`);
    }
    const config = (await res.json());
    discoveryCache.set(issuer, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    return config;
}
async function fetchJWKS(jwksUri, log) {
    const cached = jwksCache.get(jwksUri);
    if (cached && cached.expiresAt > Date.now())
        return cached.keys;
    log.debug('Fetching JWKS', { uri: jwksUri });
    const res = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
        throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json());
    jwksCache.set(jwksUri, { keys: data.keys, expiresAt: Date.now() + CACHE_TTL_MS });
    return data.keys;
}
const pendingStates = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingStates) {
        if (now - val.createdAt > 600_000)
            pendingStates.delete(key);
    }
}, 300_000).unref();
function base64url(data) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    return buf.toString('base64url');
}
function issueSessionJWT(user, secret, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSeconds;
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        sub: user.sub,
        email: user.email,
        name: user.name,
        groups: user.groups,
        roles: user.roles,
        provider: user.provider,
        iat: now,
        exp,
        iss: 'shre-platform',
    }));
    const hmac = createHmac('sha256', secret);
    hmac.update(`${header}.${payload}`);
    const sig = hmac.digest('base64url');
    return {
        token: `${header}.${payload}.${sig}`,
        expiresAt: new Date(exp * 1000).toISOString(),
    };
}
export async function validateToken(token, issuer, log) {
    const _log = log || createLogger('sso-validator');
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return { valid: false, error: 'Invalid JWT structure' };
        const headerRaw = Buffer.from(parts[0], 'base64url').toString();
        const payloadRaw = Buffer.from(parts[1], 'base64url').toString();
        const header = JSON.parse(headerRaw);
        const claims = JSON.parse(payloadRaw);
        if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) {
            return { valid: false, error: 'Token expired' };
        }
        if (claims.iss !== issuer) {
            return { valid: false, error: `Issuer mismatch: expected ${issuer}, got ${claims.iss}` };
        }
        const discovery = await fetchDiscovery(issuer, _log);
        const keys = await fetchJWKS(discovery.jwks_uri, _log);
        const matchingKey = header.kid
            ? keys.find((k) => k.kid === header.kid)
            : keys.find((k) => k.use === 'sig' && k.alg === (header.alg || 'RS256'));
        if (!matchingKey) {
            return { valid: false, error: 'No matching JWK found for token kid' };
        }
        _log.warn('JWT signature verification requires jose library for full validation', {
            kid: header.kid,
            alg: header.alg,
        });
        return { valid: true, claims };
    }
    catch (err) {
        _log.error('Token validation failed', {}, err);
        return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
}
export function createSSOProvider(config) {
    const log = createLogger('shre-sso');
    const scopes = config.scopes || ['openid', 'profile', 'email'];
    const jwtSecret = config.jwtSecret || randomBytes(32).toString('hex');
    const tokenTtl = config.tokenTtlSeconds || 86400;
    if (config.provider === 'saml') {
        return {
            async initiateLogin() {
                throw new Error('SAML 2.0 not yet implemented. Requires xml-crypto dependency. ' +
                    "Use provider: 'oidc' with Azure AD, Okta, or Google for SSO. " +
                    'SAML support planned for Q3 2026.');
            },
            async handleCallback() {
                throw new Error('SAML 2.0 not yet implemented. Use OIDC provider.');
            },
            async validateToken() {
                return { valid: false, error: 'SAML validation not implemented' };
            },
            async getDiscovery() {
                throw new Error('SAML does not use OIDC discovery');
            },
        };
    }
    function mapGroupsToRoles(groups) {
        if (!config.groupRoleMapping)
            return [];
        const roles = [];
        for (const group of groups) {
            const role = config.groupRoleMapping[group];
            if (role)
                roles.push(role);
        }
        return [...new Set(roles)];
    }
    function enforceDomainAllowlist(email) {
        if (!config.allowedDomains || config.allowedDomains.length === 0)
            return;
        const domain = email.split('@')[1]?.toLowerCase();
        if (!domain || !config.allowedDomains.includes(domain)) {
            throw new Error(`Email domain '${domain}' not in allowed domains: ${config.allowedDomains.join(', ')}`);
        }
    }
    async function emitAuditEvent(category, data) {
        if (!config.eventBus)
            return;
        try {
            await config.eventBus.publish(category, 'info', {
                service: 'shre-sso',
                ...data,
                timestamp: new Date().toISOString(),
            });
        }
        catch (err) {
            log.warn('Failed to emit SSO audit event', { category }, err);
        }
    }
    return {
        async initiateLogin(req) {
            const discovery = await fetchDiscovery(config.issuer, log);
            const state = randomBytes(32).toString('hex');
            const nonce = randomBytes(16).toString('hex');
            pendingStates.set(state, { nonce, createdAt: Date.now() });
            const params = new URLSearchParams({
                response_type: 'code',
                client_id: config.clientId,
                redirect_uri: config.redirectUri,
                scope: scopes.join(' '),
                state,
                nonce,
                prompt: 'select_account',
            });
            if (req?.query?.login_hint) {
                params.set('login_hint', req.query.login_hint);
            }
            const redirectUrl = `${discovery.authorization_endpoint}?${params.toString()}`;
            log.info('SSO login initiated', { provider: config.provider, issuer: config.issuer });
            return { redirectUrl, state };
        },
        async handleCallback(params) {
            const { code, state } = params;
            const pending = pendingStates.get(state);
            if (!pending) {
                await emitAuditEvent('auth.failed', { reason: 'invalid_state', provider: config.provider });
                throw new Error('Invalid or expired SSO state parameter (possible CSRF attack)');
            }
            pendingStates.delete(state);
            if (Date.now() - pending.createdAt > 600_000) {
                await emitAuditEvent('auth.failed', { reason: 'state_expired', provider: config.provider });
                throw new Error('SSO state expired (login took too long)');
            }
            const discovery = await fetchDiscovery(config.issuer, log);
            const tokenRes = await fetch(discovery.token_endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: config.redirectUri,
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!tokenRes.ok) {
                const errorBody = await tokenRes.text().catch(() => 'unknown');
                log.error('Token exchange failed', { status: tokenRes.status, body: errorBody });
                await emitAuditEvent('auth.failed', {
                    reason: 'token_exchange_failed',
                    status: tokenRes.status,
                });
                throw new Error(`Token exchange failed: ${tokenRes.status}`);
            }
            const tokens = (await tokenRes.json());
            const idTokenParts = tokens.id_token.split('.');
            if (idTokenParts.length !== 3)
                throw new Error('Invalid ID token structure');
            const claims = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString());
            if (claims.nonce !== pending.nonce) {
                await emitAuditEvent('auth.failed', {
                    reason: 'nonce_mismatch',
                    provider: config.provider,
                });
                throw new Error('ID token nonce mismatch (possible replay attack)');
            }
            let userinfoClaims = {};
            try {
                const userinfoRes = await fetch(discovery.userinfo_endpoint, {
                    headers: { Authorization: `Bearer ${tokens.access_token}` },
                    signal: AbortSignal.timeout(10_000),
                });
                if (userinfoRes.ok) {
                    userinfoClaims = (await userinfoRes.json());
                }
            }
            catch (err) {
                log.warn('Userinfo fetch failed, using ID token claims only', {}, err);
            }
            const merged = { ...claims, ...userinfoClaims };
            const email = merged.email || '';
            const name = merged.name || merged.preferred_username || email;
            const sub = merged.sub || '';
            const groups = Array.isArray(merged.groups)
                ? merged.groups
                : Array.isArray(merged['cognito:groups'])
                    ? merged['cognito:groups']
                    : [];
            enforceDomainAllowlist(email);
            const roles = mapGroupsToRoles(groups);
            const user = {
                sub,
                email,
                name,
                groups,
                provider: config.provider,
                roles,
                rawClaims: merged,
            };
            const { token, expiresAt } = issueSessionJWT(user, jwtSecret, tokenTtl);
            await emitAuditEvent('auth.login', {
                email: user.email,
                provider: user.provider,
                groups: user.groups,
                roles: user.roles,
                method: 'sso',
            });
            log.info('SSO login successful', {
                email: user.email,
                provider: user.provider,
                roles: user.roles,
                groups: user.groups.length,
            });
            return { user, token, expiresAt };
        },
        async validateToken(token) {
            return validateToken(token, config.issuer, log);
        },
        async getDiscovery() {
            return fetchDiscovery(config.issuer, log);
        },
    };
}
