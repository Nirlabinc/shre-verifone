const DEFAULT_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
].join('; ');
const DEFAULT_PERMISSIONS_POLICY = [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'payment=()',
    'usb=()',
    'magnetometer=()',
    'gyroscope=()',
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=(self)',
    'fullscreen=(self)',
].join(', ');
export function securityHeaders(config) {
    const opts = config || {};
    const isProduction = process.env.NODE_ENV === 'production';
    const enableHsts = opts.hsts ?? isProduction;
    const hstsMaxAge = opts.hstsMaxAge ?? 31536000;
    const framePolicy = opts.framePolicy || 'deny';
    const referrerPolicy = opts.referrerPolicy || 'strict-origin-when-cross-origin';
    const csp = opts.csp || DEFAULT_CSP;
    const permissionsPolicy = opts.permissionsPolicy || DEFAULT_PERMISSIONS_POLICY;
    const corsOrigins = new Set(opts.corsOrigins || []);
    const cspExemptPaths = new Set(opts.cspExemptPaths || []);
    return async (c, next) => {
        if (corsOrigins.size > 0) {
            const origin = c.req.header('origin');
            if (origin && corsOrigins.has(origin)) {
                c.header('Access-Control-Allow-Origin', origin);
                c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Id, X-Agent-Id, X-Correlation-Id');
                c.header('Access-Control-Max-Age', '86400');
                c.header('Access-Control-Allow-Credentials', 'true');
                c.header('Vary', 'Origin');
            }
            if (c.req.method === 'OPTIONS') {
                c.status(204);
                return c.body(null);
            }
        }
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('X-Frame-Options', framePolicy === 'deny' ? 'DENY' : 'SAMEORIGIN');
        c.header('X-XSS-Protection', '1; mode=block');
        c.header('Referrer-Policy', referrerPolicy);
        c.header('Permissions-Policy', permissionsPolicy);
        if (!cspExemptPaths.has(c.req.path)) {
            c.header('Content-Security-Policy', csp);
        }
        if (enableHsts) {
            const hstsValue = opts.hstsSubdomains !== false
                ? `max-age=${hstsMaxAge}; includeSubDomains; preload`
                : `max-age=${hstsMaxAge}`;
            c.header('Strict-Transport-Security', hstsValue);
        }
        c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        c.header('Pragma', 'no-cache');
        c.header('X-Powered-By', '');
        c.header('Server', '');
        if (opts.customHeaders) {
            for (const [key, value] of Object.entries(opts.customHeaders)) {
                c.header(key, value);
            }
        }
        return next();
    };
}
export function apiOnlyCSP() {
    return "default-src 'none'; frame-ancestors 'none'";
}
export function developmentCSP() {
    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: http:",
        "connect-src 'self' ws: wss: http: https:",
        "font-src 'self' data:",
        "frame-ancestors 'self'",
    ].join('; ');
}
