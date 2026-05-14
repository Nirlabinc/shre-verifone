import { audit } from './feed.js';
export function createAuditClient(serviceName, bus) {
    return {
        async log(entryType, data, actor) {
            const payload = {
                service: serviceName,
                ...data?.payload,
            };
            if (data?.tenantId)
                payload.tenantId = data.tenantId;
            if (data?.agentId)
                payload.agentId = data.agentId;
            if (data?.ip)
                payload.ip = data.ip;
            if (data?.resource)
                payload.resource = data.resource;
            if (data?.action)
                payload.action = data.action;
            await audit(bus, entryType, payload, actor ?? data?.actor ?? serviceName).catch(() => { });
        },
    };
}
export function auditMiddleware(client) {
    const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    return async (c, next) => {
        if (!MUTATION_METHODS.has(c.req.method)) {
            return next();
        }
        await next();
        const status = c.res?.status ?? 0;
        const passport = c.get?.('passport');
        const actor = passport?.entityId ?? c.get?.('tenant')?.tenantId ?? 'anonymous';
        client
            .log('access.admin', {
            actor,
            ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
            resource: `${c.req.method} ${c.req.path}`,
            action: c.req.method.toLowerCase(),
            payload: { status, path: c.req.path },
            tenantId: c.get?.('tenant')?.tenantId,
        })
            .catch(() => { });
    };
}
