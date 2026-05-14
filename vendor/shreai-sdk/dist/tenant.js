export function extractTenantContext(opts) {
    const { authorization, tenantIdHeader, claims } = opts;
    if (claims?.sub) {
        return {
            userId: claims.sub,
            tenantId: tenantIdHeader || claims.tenant_id || 'default',
            role: claims.role,
        };
    }
    if (!authorization)
        return null;
    return null;
}
export function tenantHeaders(ctx) {
    return {
        'x-tenant-id': ctx.tenantId,
        'x-user-id': ctx.userId,
        ...(ctx.role ? { 'x-user-role': ctx.role } : {}),
    };
}
export function validateTenantContext(ctx) {
    if (!ctx)
        return 'Missing tenant context — authentication required';
    if (!ctx.userId || ctx.userId === 'system')
        return 'Missing user identity';
    return null;
}
export function requireTenant(opts) {
    return async (c, next) => {
        const claims = opts.verifyAuth(c.req?.raw || c.req);
        const tenantIdHeader = c.req?.header?.('x-tenant-id') || c.req?.headers?.['x-tenant-id'];
        const ctx = extractTenantContext({ claims, tenantIdHeader });
        if (!ctx && !opts.allowAnonymous) {
            return c.json({ error: 'Unauthorized — tenant context required' }, 401);
        }
        c.set('tenant', ctx || { userId: 'anonymous', tenantId: 'default' });
        await next();
    };
}
