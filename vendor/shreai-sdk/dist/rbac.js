import { serviceUrl } from './discovery.js';
export const ROLES = {
    admin: {
        roleId: 'admin',
        displayName: 'Administrator',
        clearanceLevel: 100,
        defaultScopes: ['*'],
    },
    operator: {
        roleId: 'operator',
        displayName: 'Operator',
        clearanceLevel: 80,
        defaultScopes: [
            'pos:read',
            'pos:write',
            'delivery:read',
            'delivery:write',
            'backoffice:read',
            'agents:read',
            'agents:write',
        ],
    },
    'agent-manager': {
        roleId: 'agent-manager',
        displayName: 'Agent Manager',
        clearanceLevel: 60,
        defaultScopes: ['agents:read', 'agents:write', 'pos:read', 'backoffice:read'],
    },
    viewer: {
        roleId: 'viewer',
        displayName: 'Viewer',
        clearanceLevel: 40,
        defaultScopes: ['pos:read', 'delivery:read', 'agents:read'],
    },
};
export const MEMBERSHIP_ROLES = {
    owner: { displayName: 'Owner', clearance: 100 },
    admin: { displayName: 'Administrator', clearance: 80 },
    member: { displayName: 'Member', clearance: 40 },
    viewer: { displayName: 'Viewer', clearance: 20 },
};
export const PERMISSION_KEYS = [
    'users:invite',
    'users:manage_permissions',
    'users:remove',
    'agents:create',
    'agents:configure',
    'agents:remove',
    'tasks:assign',
    'tasks:assign_scope',
    'tasks:create',
    'joins:approve',
    'vault:manage',
    'vault:checkout',
    'vault:view_log',
    'vault:approve_requests',
    'security:manage',
    'workspace:settings',
    'workspace:billing',
    'workspace:delete',
    'reports:view',
    'reports:export',
    'apps:install',
    'apps:access',
    'chat:send',
    'chat:view_history',
];
export const ROLE_PERMISSION_MATRIX = {
    owner: PERMISSION_KEYS,
    admin: [
        'users:invite',
        'users:manage_permissions',
        'users:remove',
        'agents:create',
        'agents:configure',
        'agents:remove',
        'tasks:assign',
        'tasks:assign_scope',
        'tasks:create',
        'joins:approve',
        'vault:checkout',
        'vault:view_log',
        'vault:approve_requests',
        'workspace:settings',
        'reports:view',
        'reports:export',
        'apps:install',
        'apps:access',
        'chat:send',
        'chat:view_history',
    ],
    member: [
        'agents:create',
        'tasks:create',
        'tasks:assign',
        'vault:checkout',
        'reports:view',
        'apps:access',
        'chat:send',
        'chat:view_history',
    ],
    viewer: ['reports:view', 'apps:access', 'chat:send', 'chat:view_history'],
};
export function roleHasPermission(role, permission) {
    return ROLE_PERMISSION_MATRIX[role]?.includes(permission) ?? false;
}
export function permissionsForRole(role) {
    return ROLE_PERMISSION_MATRIX[role] ?? [];
}
export function rolesWithPermission(permission) {
    return Object.keys(ROLE_PERMISSION_MATRIX).filter((role) => ROLE_PERMISSION_MATRIX[role].includes(permission));
}
export function hasScope(passport, scope) {
    const scopes = passport.scopes;
    if (!scopes || !Array.isArray(scopes))
        return false;
    if (scopes.includes('*') || scopes.includes('admin'))
        return true;
    if (scopes.includes(scope))
        return true;
    const [prefix] = scope.split(':');
    if (prefix && scopes.includes(`${prefix}:*`))
        return true;
    return false;
}
export function hasAllScopes(passport, scopes) {
    return scopes.every((s) => hasScope(passport, s));
}
export function hasAnyScope(passport, scopes) {
    return scopes.some((s) => hasScope(passport, s));
}
export async function resolveUserRoles(userId, tenantId) {
    const baseUrl = serviceUrl('shre-registry');
    try {
        const res = await fetch(`${baseUrl}/v1/users/${userId}/roles?tenant_id=${tenantId}`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok)
            return [];
        const data = (await res.json());
        return data.roles ?? [];
    }
    catch (err) {
        console.debug('[rbac] Failed to fetch user roles', { error: err.message });
        return [];
    }
}
const PASSPORT_TYPE_CLEARANCE = {
    DIPLOMATIC: 100,
    RESIDENT: 80,
    SERVICE: 60,
    VISITOR: 40,
    TOURIST: 20,
};
export function requireRole(minClearance) {
    return async (c, next) => {
        const passport = c.get?.('passport');
        if (!passport) {
            return c.json({ error: 'Unauthorized — passport required', code: 'NO_PASSPORT' }, 401);
        }
        const clearance = passport.clearanceTier ?? PASSPORT_TYPE_CLEARANCE[passport.type] ?? 0;
        if (clearance < minClearance) {
            return c.json({
                error: 'Forbidden — insufficient clearance',
                code: 'INSUFFICIENT_CLEARANCE',
                required: minClearance,
                current: clearance,
            }, 403);
        }
        return next();
    };
}
export function requireScope(...scopes) {
    return async (c, next) => {
        const passport = c.get?.('passport');
        if (!passport) {
            return c.json({ error: 'Unauthorized — passport required', code: 'NO_PASSPORT' }, 401);
        }
        for (const scope of scopes) {
            if (!hasScope(passport, scope)) {
                return c.json({
                    error: `Forbidden — missing scope: ${scope}`,
                    code: 'MISSING_SCOPE',
                    required: scopes,
                    current: passport.scopes,
                }, 403);
            }
        }
        return next();
    };
}
