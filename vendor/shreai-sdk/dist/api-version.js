import { createLogger } from './logger.js';
export function createVersioning(serviceName, config) {
    const log = config.logger ?? createLogger(`${serviceName}:version`);
    const supportedSet = new Set(config.supported);
    const deprecatedMap = new Map();
    for (const d of config.deprecated ?? []) {
        deprecatedMap.set(d.version, d);
    }
    const _byVersion = {};
    let _deprecatedUsage = 0;
    let _rejections = 0;
    function extractVersion(path, headers, query) {
        let version = config.current;
        const pathMatch = path.match(/\/v(\d+)\//);
        if (pathMatch && pathMatch[1]) {
            version = parseInt(pathMatch[1], 10);
        }
        const headerVersion = headers?.['x-api-version'];
        if (headerVersion) {
            version = parseInt(headerVersion, 10);
        }
        const queryVersion = query?.['api_version'];
        if (queryVersion) {
            version = parseInt(queryVersion, 10);
        }
        const deprecated = deprecatedMap.get(version);
        const isSupported = supportedSet.has(version);
        _byVersion[version] = (_byVersion[version] || 0) + 1;
        if (deprecated)
            _deprecatedUsage++;
        if (!isSupported)
            _rejections++;
        return {
            requested: version,
            isDeprecated: !!deprecated,
            sunsetDate: deprecated?.sunsetDate,
            isSupported,
        };
    }
    function responseHeaders(info) {
        const headers = {
            'X-API-Version': String(info.requested),
            'X-API-Current-Version': String(config.current),
        };
        if (info.isDeprecated) {
            const dep = deprecatedMap.get(info.requested);
            headers['Deprecation'] = 'true';
            headers['Warning'] =
                `299 - "API version ${info.requested} is deprecated. Please migrate to v${config.current}."`;
            if (info.sunsetDate) {
                headers['Sunset'] = new Date(info.sunsetDate).toUTCString();
            }
            if (dep?.migrationGuide) {
                headers['Link'] = `<${dep.migrationGuide}>; rel="deprecation"`;
            }
        }
        return headers;
    }
    function middleware() {
        return async (c, next) => {
            const path = c.req.path || c.req.url || '';
            const headers = {};
            if (c.req.header) {
                const xApiVersion = c.req.header('x-api-version');
                if (xApiVersion)
                    headers['x-api-version'] = xApiVersion;
            }
            const query = c.req.query?.() ?? {};
            const info = extractVersion(path, headers, query);
            if (!info.isSupported) {
                return c.json({
                    error: `API version ${info.requested} is not supported`,
                    supported: config.supported,
                    current: config.current,
                }, 400);
            }
            c.set('apiVersion', info.requested);
            c.set('versionInfo', info);
            if (info.isDeprecated) {
                log.warn('[version] Deprecated API version used', {
                    version: info.requested,
                    sunsetDate: info.sunsetDate,
                    path,
                });
            }
            await next();
            const respHeaders = responseHeaders(info);
            for (const [key, value] of Object.entries(respHeaders)) {
                c.header(key, value);
            }
        };
    }
    function expressMiddleware() {
        return (req, res, next) => {
            const path = req.path || req.url || '';
            const headers = {};
            if (req.headers?.['x-api-version']) {
                headers['x-api-version'] = req.headers['x-api-version'];
            }
            const query = req.query ?? {};
            const info = extractVersion(path, headers, query);
            if (!info.isSupported) {
                res.status(400).json({
                    error: `API version ${info.requested} is not supported`,
                    supported: config.supported,
                    current: config.current,
                });
                return;
            }
            req.apiVersion = info.requested;
            req.versionInfo = info;
            if (info.isDeprecated) {
                log.warn('[version] Deprecated API version used', {
                    version: info.requested,
                    sunsetDate: info.sunsetDate,
                    path,
                });
            }
            const respHeaders = responseHeaders(info);
            for (const [key, value] of Object.entries(respHeaders)) {
                res.setHeader(key, value);
            }
            next();
        };
    }
    return {
        extractVersion,
        responseHeaders,
        middleware,
        expressMiddleware,
        stats: () => ({
            byVersion: { ..._byVersion },
            deprecatedUsage: _deprecatedUsage,
            rejections: _rejections,
        }),
        isSupported: (v) => supportedSet.has(v),
    };
}
