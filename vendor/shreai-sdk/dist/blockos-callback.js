import { serviceUrl } from './core.js';
export async function validateBlockOSToken(token, authUrl) {
    const url = authUrl || serviceUrl?.('shre-auth') || 'http://127.0.0.1:5455';
    try {
        const res = await fetch(`${url}/v1/auth/validate-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            return { ok: false, error: 'Invalid or expired platform token', status: 401 };
        }
        const data = (await res.json());
        if (!data.valid || !data.claims) {
            return { ok: false, error: 'Token validation failed', status: 401 };
        }
        if (!data.claims.email) {
            return { ok: false, error: 'Invalid token payload — missing email', status: 401 };
        }
        return {
            ok: true,
            user: {
                id: data.claims.sub,
                email: data.claims.email,
                name: data.claims.name,
                role: data.claims.role,
                activeWorkspaceId: data.claims.activeWorkspaceId,
            },
        };
    }
    catch (err) {
        return {
            ok: false,
            error: `Platform authentication failed: ${err.message}`,
            status: 500,
        };
    }
}
export function createBlockOSCallbackHandler(config) {
    return async (c) => {
        const token = c.req.query('token');
        if (!token || typeof token !== 'string') {
            return c.json({ error: 'Missing token parameter' }, 400);
        }
        const result = await validateBlockOSToken(token, config.authUrl);
        if (result.ok === false) {
            const fail = result;
            config.onError?.(fail.error, fail.status);
            return c.json({ error: fail.error }, fail.status);
        }
        const { redirectTo } = await config.onUser(result.user);
        return c.redirect(redirectTo);
    };
}
export function createBlockOSCallbackMiddleware(config) {
    return async (req, res) => {
        const token = req.query.token;
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'Missing token parameter' });
        }
        const result = await validateBlockOSToken(token, config.authUrl);
        if (result.ok === false) {
            const fail = result;
            config.onError?.(fail.error, fail.status);
            return res.status(fail.status).json({ error: fail.error });
        }
        const { redirectTo } = await config.onUser(result.user);
        return res.redirect(redirectTo);
    };
}
