import type { PassportPayload } from './passport-client.js';
import type { HonoLikeContext } from './types.js';
export interface RoleDefinition {
    roleId: string;
    displayName: string;
    clearanceLevel: number;
    defaultScopes: string[];
}
export declare const ROLES: Record<string, RoleDefinition>;
export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';
export declare const MEMBERSHIP_ROLES: Record<MembershipRole, {
    displayName: string;
    clearance: number;
}>;
export declare const PERMISSION_KEYS: readonly ["users:invite", "users:manage_permissions", "users:remove", "agents:create", "agents:configure", "agents:remove", "tasks:assign", "tasks:assign_scope", "tasks:create", "joins:approve", "vault:manage", "vault:checkout", "vault:view_log", "vault:approve_requests", "security:manage", "workspace:settings", "workspace:billing", "workspace:delete", "reports:view", "reports:export", "apps:install", "apps:access", "chat:send", "chat:view_history"];
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export declare const ROLE_PERMISSION_MATRIX: Record<MembershipRole, readonly PermissionKey[]>;
export declare function roleHasPermission(role: MembershipRole, permission: PermissionKey): boolean;
export declare function permissionsForRole(role: MembershipRole): readonly PermissionKey[];
export declare function rolesWithPermission(permission: PermissionKey): MembershipRole[];
export declare function hasScope(passport: PassportPayload | {
    scopes: string[];
}, scope: string): boolean;
export declare function hasAllScopes(passport: PassportPayload | {
    scopes: string[];
}, scopes: string[]): boolean;
export declare function hasAnyScope(passport: PassportPayload | {
    scopes: string[];
}, scopes: string[]): boolean;
export interface UserRole {
    roleId: string;
    tenantId: string;
    clearanceLevel: number;
    scopes: string[];
}
export declare function resolveUserRoles(userId: string, tenantId: string): Promise<UserRole[]>;
export declare function requireRole(minClearance: number): (c: HonoLikeContext, next: () => Promise<void>) => Promise<void | Response>;
export declare function requireScope(...scopes: string[]): (c: HonoLikeContext, next: () => Promise<void>) => Promise<void | Response>;
