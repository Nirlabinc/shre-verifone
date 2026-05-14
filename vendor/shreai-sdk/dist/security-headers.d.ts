export interface SecurityHeadersConfig {
    corsOrigins?: string[];
    csp?: string;
    hsts?: boolean;
    hstsMaxAge?: number;
    hstsSubdomains?: boolean;
    framePolicy?: 'deny' | 'sameorigin';
    referrerPolicy?: string;
    customHeaders?: Record<string, string>;
    cspExemptPaths?: string[];
    permissionsPolicy?: string;
}
interface MiddlewareContext {
    req: {
        header(name: string): string | undefined;
        method: string;
        path: string;
        url: string;
    };
    header(name: string, value: string): void;
    status(code: number): void;
    body(data: null): Response;
}
export declare function securityHeaders(config?: SecurityHeadersConfig): (c: MiddlewareContext, next: () => Promise<void>) => Promise<void | Response>;
export declare function apiOnlyCSP(): string;
export declare function developmentCSP(): string;
export {};
