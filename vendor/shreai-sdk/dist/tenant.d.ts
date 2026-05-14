import type { HonoLikeContext } from './types.js';
export interface TenantContext {
    userId: string;
    tenantId: string;
    role?: string;
}
export declare function extractTenantContext(opts: {
    authorization?: string | null;
    tenantIdHeader?: string | null;
    claims?: {
        sub?: string;
        role?: string;
        tenant_id?: string;
    } | null;
}): TenantContext | null;
export declare function tenantHeaders(ctx: TenantContext): Record<string, string>;
export declare function validateTenantContext(ctx: TenantContext | null): string | null;
export declare function requireTenant(opts: {
    verifyAuth: (req: unknown) => {
        sub?: string;
        role?: string;
        tenant_id?: string;
    } | null;
    allowAnonymous?: boolean;
}): (c: HonoLikeContext, next: () => Promise<void>) => Promise<Response | undefined>;
