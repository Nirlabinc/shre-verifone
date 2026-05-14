import { createLogger } from './logger.js';
const CATALOG = [
    {
        code: 'SHRE-E1001',
        category: 'infrastructure',
        title: 'Port already in use',
        signature: /EADDRINUSE|address already in use/i,
        severity: 'fatal',
        autoRemediable: true,
        defaultFix: 'Kill process on conflicting port or restart with alternate port',
        fixType: 'restart',
        remediationConfig: { action: 'retry', maxRetries: 3, baseDelayMs: 1000 },
    },
    {
        code: 'SHRE-E1002',
        category: 'infrastructure',
        title: 'Disk space exhausted',
        signature: /ENOSPC|no space left on device/i,
        severity: 'fatal',
        autoRemediable: true,
        defaultFix: 'Clean up logs, temp files, or old model files',
        fixType: 'resource_cleanup',
        remediationConfig: { action: 'escalate', escalateTo: 'ops-manager' },
    },
    {
        code: 'SHRE-E1003',
        category: 'infrastructure',
        title: 'Out of memory',
        signature: /ENOMEM|out of memory|heap out of memory|JavaScript heap/i,
        severity: 'fatal',
        autoRemediable: true,
        defaultFix: 'Restart service with increased memory limit or reduce concurrency',
        fixType: 'restart',
        remediationConfig: { action: 'retry', maxRetries: 1, baseDelayMs: 2000 },
    },
    {
        code: 'SHRE-E1004',
        category: 'infrastructure',
        title: 'TLS certificate error',
        signature: /UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed|CERT_|ERR_TLS|SSL/i,
        severity: 'error',
        autoRemediable: false,
        defaultFix: 'Regenerate TLS certificate with mkcert or fix cert chain',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E1005',
        category: 'infrastructure',
        title: 'Permission denied',
        signature: /EACCES|permission denied|TCC blocked/i,
        severity: 'error',
        autoRemediable: false,
        defaultFix: 'Fix file permissions or TCC settings',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E1006',
        category: 'infrastructure',
        title: 'NAS/volume unavailable',
        signature: /shre-models|\/Volumes\/.*unavail|mount.*fail|smb.*fail/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Fall back to local storage; remount volume when available',
        fixType: 'dependency_fix',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 5,
            baseDelayMs: 5000,
            maxDelayMs: 60000,
        },
    },
    {
        code: 'SHRE-E2001',
        category: 'connectivity',
        title: 'Service unreachable',
        signature: /ECONNREFUSED|connection refused/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Restart target service via launchctl',
        fixType: 'restart',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 5,
            baseDelayMs: 1000,
            maxDelayMs: 30000,
        },
    },
    {
        code: 'SHRE-E2002',
        category: 'connectivity',
        title: 'Connection timeout',
        signature: /ETIMEDOUT|socket hang up|request timed out|AbortError|TimeoutError/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Check target service health; increase timeout if under load',
        fixType: 'config_change',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 2000,
            maxDelayMs: 15000,
        },
    },
    {
        code: 'SHRE-E2003',
        category: 'connectivity',
        title: 'Circuit breaker open',
        signature: /circuit.breaker.*open|breaker.*blocked/i,
        severity: 'warn',
        autoRemediable: true,
        defaultFix: 'Wait for cooldown or restart target service to close breaker',
        fixType: 'dependency_fix',
        remediationConfig: { action: 'wait-retry', waitMs: 30000, maxRetries: 3 },
    },
    {
        code: 'SHRE-E2004',
        category: 'connectivity',
        title: 'DNS resolution failed',
        signature: /ENOTFOUND|getaddrinfo|DNS/i,
        severity: 'error',
        autoRemediable: false,
        defaultFix: 'Check DNS config or use IP address directly',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E2005',
        category: 'connectivity',
        title: 'Fetch failed',
        signature: /fetch failed|Failed to fetch|NetworkError/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Check if target service is running and protocol (http vs https) is correct',
        fixType: 'dependency_fix',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 1000,
            maxDelayMs: 10000,
        },
    },
    {
        code: 'SHRE-E2006',
        category: 'connectivity',
        title: 'Wrong protocol (HTTP/HTTPS mismatch)',
        signature: /routines:OPENSSL|ERR_SSL_WRONG|write EPROTO|SSL routines/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Check ports.json protocol field; service may be HTTP but called with HTTPS',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E3001',
        category: 'auth',
        title: 'Redis auth failed',
        signature: /NOAUTH|Redis.*auth/i,
        severity: 'fatal',
        autoRemediable: false,
        defaultFix: 'Set REDIS_PASSWORD or update vault credential',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E3002',
        category: 'auth',
        title: 'Trust gate rejection',
        signature: /trust.gate|untrusted.agent|unknown.agent/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Add agent to TRUSTED_AGENTS in shre-router',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E3003',
        category: 'auth',
        title: 'API key invalid or expired',
        signature: /invalid.*api.key|api.key.*invalid|unauthorized|401.*auth|credit.balance.*low/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Rotate API key or reset cooldown in key store',
        fixType: 'key_reset',
        remediationConfig: { action: 'retry', maxRetries: 1, baseDelayMs: 500 },
    },
    {
        code: 'SHRE-E3004',
        category: 'auth',
        title: 'Token expired',
        signature: /token.*expired|session.*expired|JWT.*expired/i,
        severity: 'warn',
        autoRemediable: true,
        defaultFix: 'Refresh token or re-authenticate',
        fixType: 'config_change',
        remediationConfig: { action: 'retry', maxRetries: 1, baseDelayMs: 500 },
    },
    {
        code: 'SHRE-E3005',
        category: 'auth',
        title: 'Vault credential missing',
        signature: /vault.*not found|vault.*missing|no.*vault/i,
        severity: 'error',
        autoRemediable: false,
        defaultFix: 'Create vault file at expected path with correct permissions',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E4001',
        category: 'routing',
        title: 'All providers failed',
        signature: /all.*provider.*fail|gateway.*unavailable.*retries|fallback.*exhausted/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Reset API key cooldowns and check provider status',
        fixType: 'key_reset',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 2000,
            maxDelayMs: 30000,
        },
    },
    {
        code: 'SHRE-E4002',
        category: 'routing',
        title: 'Rate limited by provider',
        signature: /rate.limit|429|too.many.requests/i,
        severity: 'warn',
        autoRemediable: true,
        defaultFix: 'Wait for cooldown; rotate to next API key',
        fixType: 'key_reset',
        remediationConfig: { action: 'wait-retry', waitMs: 60000, maxRetries: 3 },
    },
    {
        code: 'SHRE-E4003',
        category: 'routing',
        title: 'Budget exceeded',
        signature: /budget.*exceeded|budget.*block|spending.*limit/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Increase budget limit or wait for daily/weekly reset',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E4004',
        category: 'routing',
        title: 'Empty model response',
        signature: /empty.*response|no.*content.*response|response.*empty/i,
        severity: 'warn',
        autoRemediable: true,
        defaultFix: 'Retry with fallback model; check if prompt exceeds context window',
        fixType: 'restart',
        remediationConfig: { action: 'retry', maxRetries: 2, baseDelayMs: 1000 },
    },
    {
        code: 'SHRE-E4005',
        category: 'routing',
        title: 'Model not available',
        signature: /model.*not found|not a chat model|unsupported.*model/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Remove model from fallback chain or update model config',
        fixType: 'config_change',
        remediationConfig: { action: 'retry', maxRetries: 1, baseDelayMs: 500 },
    },
    {
        code: 'SHRE-E4006',
        category: 'routing',
        title: 'Tool loop exhausted',
        signature: /tool.loop|maximum.iteration|iterations.*exceeded/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Rephrase request or increase max iterations',
        fixType: 'escalate',
        remediationConfig: { action: 'escalate', escalateTo: 'human' },
    },
    {
        code: 'SHRE-E5001',
        category: 'data',
        title: 'CortexDB write failed',
        signature: /cortex.*write.*fail|cortexdb.*error|cortex.*unreachable/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Check CortexDB health; data buffered in WAL for retry',
        fixType: 'dependency_fix',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 5,
            baseDelayMs: 2000,
            maxDelayMs: 60000,
        },
    },
    {
        code: 'SHRE-E5002',
        category: 'data',
        title: 'PostgreSQL connection failed',
        signature: /pg.*connect|postgres.*fail|FATAL.*postgres|PG.*error|connection.*pool.*exhausted/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Check PgBouncer (6432) and PostgreSQL (5433) health',
        fixType: 'restart',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 5,
            baseDelayMs: 3000,
            maxDelayMs: 60000,
        },
    },
    {
        code: 'SHRE-E5003',
        category: 'data',
        title: 'Redis connection failed',
        signature: /redis.*connect|ECONNREFUSED.*6379|redis.*error/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Restart Redis service',
        fixType: 'restart',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 5,
            baseDelayMs: 2000,
            maxDelayMs: 30000,
        },
    },
    {
        code: 'SHRE-E5004',
        category: 'data',
        title: 'Qdrant unreachable',
        signature: /qdrant.*fail|qdrant.*timeout|qdrant.*unreachable|6333.*refused/i,
        severity: 'warn',
        autoRemediable: true,
        defaultFix: 'Restart Qdrant; vector search falls back to keyword',
        fixType: 'restart',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 2000,
            maxDelayMs: 30000,
        },
    },
    {
        code: 'SHRE-E6001',
        category: 'agent',
        title: 'Agent crash',
        signature: /agent.*crash|unrecoverable|process.*exit|SIGTERM|exit.code.*[^0]/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Restart agent via launchctl; check logs for root cause',
        fixType: 'restart',
        remediationConfig: { action: 'retry', maxRetries: 2, baseDelayMs: 5000 },
    },
    {
        code: 'SHRE-E6002',
        category: 'agent',
        title: 'Stuck task',
        signature: /stuck.*task|task.*timeout|task.*hung|execution.*stuck/i,
        severity: 'warn',
        autoRemediable: true,
        defaultFix: 'Force-fail stuck task and retry',
        fixType: 'restart',
        remediationConfig: { action: 'retry', maxRetries: 3, baseDelayMs: 2000 },
    },
    {
        code: 'SHRE-E6003',
        category: 'agent',
        title: 'Quality below threshold',
        signature: /quality.*below|quality.*gate.*fail|score.*below/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Retry with higher-capability model',
        fixType: 'escalate',
        remediationConfig: { action: 'escalate', escalateTo: 'ops-manager' },
    },
    {
        code: 'SHRE-E6004',
        category: 'agent',
        title: 'Tool permission denied',
        signature: /permission.denied.*tool|cannot.use.tool|tool.*denied/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Grant tool via /v1/tools/grants/:agentId',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E6005',
        category: 'agent',
        title: 'Data access denied',
        signature: /data.*access.*denied|data.*denied|not.*authorized.*data/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Update agent SOUL.md with data access instructions',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E7001',
        category: 'business',
        title: 'POS sync failed',
        signature: /pos.*sync.*fail|rapidrms.*sync|store.*sync.*error/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Check RapidRMS API credentials and store connectivity',
        fixType: 'dependency_fix',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 5000,
            maxDelayMs: 60000,
        },
    },
    {
        code: 'SHRE-E7002',
        category: 'business',
        title: 'Billing check failed',
        signature: /billing.*fail|balance.*check.*fail|payment.*required/i,
        severity: 'warn',
        autoRemediable: false,
        defaultFix: 'Verify billing API endpoint and credentials',
        fixType: 'config_change',
        remediationConfig: { action: 'escalate', escalateTo: 'human' },
    },
    {
        code: 'SHRE-E8001',
        category: 'external',
        title: 'RapidRMS API error',
        signature: /rapidrms.*api|rapidrms.*auth.*fail|rapidrms.*error/i,
        severity: 'error',
        autoRemediable: false,
        defaultFix: 'Check RapidRMS API key and endpoint configuration',
        fixType: 'config_change',
        remediationConfig: { action: 'block' },
    },
    {
        code: 'SHRE-E8002',
        category: 'external',
        title: 'Cloudflare tunnel error',
        signature: /cloudflare.*tunnel|tunnel.*error|1033|shre-tunnel/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Restart cloudflare tunnel LaunchAgent',
        fixType: 'restart',
        remediationConfig: { action: 'retry', maxRetries: 3, baseDelayMs: 5000 },
    },
    {
        code: 'SHRE-E8003',
        category: 'external',
        title: 'Ollama inference error',
        signature: /ollama.*error|ollama.*fail|11434.*error|model.*not found.*ollama/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Restart Ollama; check model availability with ollama list',
        fixType: 'restart',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 3000,
            maxDelayMs: 30000,
        },
    },
    {
        code: 'SHRE-E8004',
        category: 'external',
        title: 'MIB007 connection error',
        signature: /mib007.*fail|mib007.*error|mib007.*connection|MIB007.*timed out/i,
        severity: 'error',
        autoRemediable: true,
        defaultFix: 'Check MIB007 health and protocol (HTTP not HTTPS)',
        fixType: 'dependency_fix',
        remediationConfig: {
            action: 'retry-backoff',
            maxRetries: 3,
            baseDelayMs: 2000,
            maxDelayMs: 15000,
        },
    },
    {
        code: 'SHRE-E9001',
        category: 'unknown',
        title: 'Uncaught exception',
        signature: /uncaught.*exception|unhandled.*rejection/i,
        severity: 'fatal',
        autoRemediable: false,
        defaultFix: 'Investigate stack trace; likely a code bug',
        fixType: 'code_change',
        remediationConfig: { action: 'escalate', escalateTo: 'human' },
    },
];
export const ErrorCatalog = new Map(CATALOG.map((d) => [d.code, d]));
export function getErrorDefinition(code) {
    return ErrorCatalog.get(code);
}
export function listErrorCodes() {
    return [...CATALOG];
}
const UNKNOWN_ERROR = {
    code: 'SHRE-E9999',
    category: 'unknown',
    title: 'Unclassified error',
    signature: /.*/,
    severity: 'error',
    autoRemediable: false,
    defaultFix: 'Investigate manually; consider adding a new error code',
    fixType: 'escalate',
    remediationConfig: { action: 'escalate', escalateTo: 'human' },
};
export function classifyError(message) {
    for (const def of CATALOG) {
        if (def.signature.test(message))
            return def;
    }
    return UNKNOWN_ERROR;
}
export function getRemediation(error) {
    const def = typeof error === 'string'
        ? classifyError(error)
        : (getErrorDefinition(error.code) ?? classifyError(error.message));
    return def.remediationConfig ?? { action: 'escalate' };
}
export function createErrorInterceptor(service, opts = {}) {
    const log = opts.logger ?? createLogger(`${service}:errors`);
    const dedupMs = opts.dedupWindowMs ?? 60_000;
    const recentErrors = [];
    const MAX_RECENT = 500;
    const codeCounters = {};
    const categoryCounters = {};
    const severityCounters = {};
    const resolutionStore = {};
    let totalResolutions = 0;
    let successfulResolutions = 0;
    let failedResolutions = 0;
    const lastCapture = {};
    function buildPlatformError(def, message, context, error) {
        return {
            code: def.code,
            category: def.category,
            title: def.title,
            service,
            message,
            severity: def.severity,
            context,
            correlationId: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            stack: error?.stack,
            autoRemediable: def.autoRemediable,
            defaultFix: def.defaultFix,
        };
    }
    function trackError(pe) {
        recentErrors.push(pe);
        if (recentErrors.length > MAX_RECENT)
            recentErrors.shift();
        codeCounters[pe.code] = (codeCounters[pe.code] ?? 0) + 1;
        categoryCounters[pe.category] = (categoryCounters[pe.category] ?? 0) + 1;
        severityCounters[pe.severity] = (severityCounters[pe.severity] ?? 0) + 1;
    }
    function isDuplicate(code) {
        const now = Date.now();
        const last = lastCapture[code];
        if (last && now - last < dedupMs)
            return true;
        lastCapture[code] = now;
        return false;
    }
    async function emitAndStore(pe) {
        const logData = {
            errorCode: pe.code,
            category: pe.category,
            title: pe.title,
            ...pe.context,
        };
        if (pe.severity === 'fatal') {
            log.fatal(pe.message, logData);
        }
        else if (pe.severity === 'error') {
            log.error(pe.message, logData);
        }
        else {
            log.warn(pe.message, logData);
        }
        if (opts.publishFn) {
            const evtSeverity = pe.severity === 'fatal' ? 'critical' : pe.severity === 'error' ? 'failure' : 'warn';
            opts
                .publishFn('error.occurred', evtSeverity, {
                errorCode: pe.code,
                category: pe.category,
                title: pe.title,
                service: pe.service,
                message: pe.message,
                severity: pe.severity,
                context: pe.context,
                correlationId: pe.correlationId,
                autoRemediable: pe.autoRemediable,
                defaultFix: pe.defaultFix,
                timestamp: pe.timestamp,
            })
                .catch(() => { });
        }
        if (opts.cortexWrite) {
            opts
                .cortexWrite('platform_error', {
                error_code: pe.code,
                category: pe.category,
                service: pe.service,
                message: pe.message,
                severity: pe.severity,
                stack: pe.stack,
                context: pe.context,
                correlation_id: pe.correlationId,
                auto_remediable: pe.autoRemediable,
                default_fix: pe.defaultFix,
                resolved: false,
                occurred_at: pe.timestamp,
            })
                .catch(() => { });
        }
        if (opts.autoCreateTask !== false &&
            opts.createIssue &&
            (pe.severity === 'fatal' || pe.severity === 'error')) {
            const tag = `error-${pe.code}-${pe.service}`;
            opts
                .createIssue({
                tag,
                title: `[${pe.code}] ${pe.title} — ${pe.service}`,
                description: `**Error:** ${pe.message}\n\n**Fix:** ${pe.defaultFix}\n\n**Context:** ${JSON.stringify(pe.context, null, 2)}`,
                priority: pe.severity === 'fatal' ? 'critical' : 'high',
                category: 'error-recovery',
            })
                .catch(() => { });
        }
    }
    function capture(message, context = {}, error) {
        const fullMessage = error ? `${message}: ${error.message}` : message;
        const def = classifyError(fullMessage);
        const pe = buildPlatformError(def, fullMessage, context, error);
        if (def.remediationConfig) {
            pe.remediation = def.remediationConfig;
        }
        trackError(pe);
        if (!isDuplicate(pe.code)) {
            emitAndStore(pe).catch(() => { });
        }
        return pe;
    }
    function captureWithCode(code, message, context = {}, error) {
        const def = ErrorCatalog.get(code) ?? { ...UNKNOWN_ERROR, code };
        const pe = buildPlatformError(def, message, context, error);
        trackError(pe);
        if (!isDuplicate(pe.code)) {
            emitAndStore(pe).catch(() => { });
        }
        return pe;
    }
    async function recordResolution(code, resolution) {
        if (!resolutionStore[code])
            resolutionStore[code] = [];
        resolutionStore[code].push(resolution);
        totalResolutions++;
        if (resolution.success)
            successfulResolutions++;
        else
            failedResolutions++;
        if (opts.publishFn) {
            const evtSeverity = resolution.success ? 'resolved' : 'failure';
            await opts
                .publishFn('error.resolved', evtSeverity, {
                errorCode: code,
                service,
                resolvedBy: resolution.resolvedBy,
                strategy: resolution.strategy,
                description: resolution.description,
                durationMs: resolution.durationMs,
                success: resolution.success,
                taskId: resolution.taskId,
                timestamp: new Date().toISOString(),
            })
                .catch(() => { });
        }
        if (opts.cortexWrite) {
            await opts
                .cortexWrite('error_resolution', {
                error_code: code,
                service,
                resolved_by: resolution.resolvedBy,
                strategy: resolution.strategy,
                description: resolution.description,
                duration_ms: resolution.durationMs,
                success: resolution.success,
                task_id: resolution.taskId,
                resolved_at: new Date().toISOString(),
            })
                .catch(() => { });
        }
    }
    async function resolve(code, reason) {
        if (opts.resolveIssue) {
            const tag = `error-${code}-${service}`;
            await opts.resolveIssue(tag, reason).catch(() => { });
        }
        if (opts.publishFn) {
            await opts
                .publishFn('error.resolved', 'resolved', {
                errorCode: code,
                service,
                reason,
                timestamp: new Date().toISOString(),
            })
                .catch(() => { });
        }
    }
    return {
        capture,
        captureWithCode,
        recordResolution,
        resolve,
        stats() {
            const topUnresolved = Object.entries(codeCounters)
                .map(([code, count]) => {
                const last = recentErrors.filter((e) => e.code === code).pop();
                return { code, count, lastSeen: last?.timestamp ?? '' };
            })
                .sort((a, b) => b.count - a.count)
                .slice(0, 10);
            return {
                totalCaptured: recentErrors.length,
                byCode: { ...codeCounters },
                byCategory: { ...categoryCounters },
                bySeverity: { ...severityCounters },
                resolutions: {
                    total: totalResolutions,
                    successful: successfulResolutions,
                    failed: failedResolutions,
                },
                topUnresolved,
            };
        },
        recent(limit = 50) {
            return recentErrors.slice(-limit);
        },
        resolutions(code) {
            return resolutionStore[code] ?? [];
        },
    };
}
export function createErrorMiddleware(service, opts = {}) {
    const interceptor = createErrorInterceptor(service, opts);
    const includeStack = opts.includeStack ?? process.env.NODE_ENV !== 'production';
    return function errorMiddleware(err, _req, res, next) {
        if (res.headersSent) {
            next(err);
            return;
        }
        const pe = interceptor.capture(err.message, {}, err);
        const statusCode = pe.severity === 'fatal'
            ? 500
            : pe.code.startsWith('SHRE-E3')
                ? 401
                : pe.code.startsWith('SHRE-E4002')
                    ? 429
                    : 500;
        res.status(statusCode).json({
            error: {
                code: pe.code,
                title: pe.title,
                message: pe.message,
                category: pe.category,
                correlationId: pe.correlationId,
                fix: pe.defaultFix,
                ...(includeStack ? { stack: pe.stack } : {}),
            },
        });
    };
}
export function analyzeErrors(interceptor, _opts = {}) {
    const stats = interceptor.stats();
    const recent = interceptor.recent(500);
    const errorTimelines = {};
    for (const pe of recent) {
        if (!errorTimelines[pe.code]) {
            errorTimelines[pe.code] = {
                times: [],
                severity: pe.severity,
                category: pe.category,
                title: pe.title,
            };
        }
        errorTimelines[pe.code].times.push(new Date(pe.timestamp).getTime());
    }
    const topErrors = Object.entries(errorTimelines)
        .map(([code, data]) => {
        const times = data.times.sort((a, b) => a - b);
        const count = times.length;
        const intervals = times.slice(1).map((t, i) => t - (times[i] ?? 0));
        const avgIntervalMs = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
        const mid = Math.floor(times.length / 2);
        const firstHalf = times.slice(0, mid);
        const secondHalf = times.slice(mid);
        let trend = 'stable';
        if (firstHalf.length > 2 && secondHalf.length > 2) {
            const fLast = firstHalf[firstHalf.length - 1] ?? 0;
            const fFirst = firstHalf[0] ?? 0;
            const sLast = secondHalf[secondHalf.length - 1] ?? 0;
            const sFirst = secondHalf[0] ?? 0;
            const firstRate = firstHalf.length / (fLast - fFirst || 1);
            const secondRate = secondHalf.length / (sLast - sFirst || 1);
            if (secondRate > firstRate * 1.3)
                trend = 'rising';
            else if (secondRate < firstRate * 0.7)
                trend = 'declining';
        }
        return {
            code,
            title: data.title,
            count,
            category: data.category,
            severity: data.severity,
            lastSeen: new Date(times[times.length - 1] ?? Date.now()).toISOString(),
            firstSeen: new Date(times[0] ?? Date.now()).toISOString(),
            trend,
            avgIntervalMs: Math.round(avgIntervalMs),
        };
    })
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
    const CLUSTER_WINDOW_MS = 5_000;
    const coOccurrences = {};
    const codeCounts = {};
    for (let i = 0; i < recent.length; i++) {
        const a = recent[i];
        codeCounts[a.code] = (codeCounts[a.code] ?? 0) + 1;
        for (let j = i + 1; j < recent.length; j++) {
            const b = recent[j];
            const timeDiff = Math.abs(new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            if (timeDiff > CLUSTER_WINDOW_MS)
                break;
            if (a.code === b.code)
                continue;
            const key = [a.code, b.code].sort().join('|');
            if (!coOccurrences[key])
                coOccurrences[key] = { count: 0 };
            coOccurrences[key].count = (coOccurrences[key].count ?? 0) + 1;
        }
    }
    const clusters = [];
    for (const [key, data] of Object.entries(coOccurrences)) {
        const parts = key.split('|');
        const codeA = parts[0] ?? '';
        const codeB = parts[1] ?? '';
        const minCount = Math.min(codeCounts[codeA] ?? 0, codeCounts[codeB] ?? 0);
        if (minCount < 2)
            continue;
        const correlation = (data.count ?? 0) / minCount;
        if (correlation < 0.3)
            continue;
        const defA = ErrorCatalog.get(codeA);
        const defB = ErrorCatalog.get(codeB);
        clusters.push({
            name: `${defA?.title ?? codeA} ↔ ${defB?.title ?? codeB}`,
            errors: [codeA, codeB],
            correlation: Math.round(correlation * 100) / 100,
            likelyRootCause: inferClusterCause(codeA, codeB),
        });
    }
    const rootCauses = topErrors.slice(0, 10).map((e) => {
        const def = ErrorCatalog.get(e.code);
        const relatedCluster = clusters.find((c) => c.errors.includes(e.code));
        const resolutions = interceptor.resolutions(e.code);
        const successfulRes = resolutions.filter((r) => r.success);
        return {
            code: e.code,
            rootCause: inferRootCause(e, recent.filter((r) => r.code === e.code)),
            confidence: successfulRes.length > 0 ? 0.9 : e.count > 5 ? 0.7 : 0.5,
            evidence: buildEvidence(e, recent.filter((r) => r.code === e.code)),
            suggestedFix: successfulRes.length > 0
                ? `Previously resolved by: ${successfulRes[0].description}`
                : (def?.defaultFix ?? 'Investigate manually'),
            fixType: def?.fixType ?? 'escalate',
            relatedErrors: relatedCluster?.errors.filter((c) => c !== e.code) ?? [],
        };
    });
    const fatalCount = stats.bySeverity['fatal'] ?? 0;
    const errorCount = stats.bySeverity['error'] ?? 0;
    const warnCount = stats.bySeverity['warn'] ?? 0;
    const risingCount = topErrors.filter((e) => e.trend === 'rising').length;
    const healthScore = Math.max(0, Math.min(100, 100 - fatalCount * 20 - errorCount * 5 - warnCount * 1 - risingCount * 10));
    return {
        topErrors,
        rootCauses,
        clusters,
        healthScore,
        analyzedAt: new Date().toISOString(),
    };
}
export async function analyzeErrorsWithAI(interceptor, opts) {
    const baseAnalysis = analyzeErrors(interceptor);
    if (!opts.aiCall || baseAnalysis.topErrors.length === 0)
        return baseAnalysis;
    const errorSummary = baseAnalysis.topErrors
        .slice(0, 10)
        .map((e) => {
        const resolutions = interceptor.resolutions(e.code);
        return `- ${e.code} "${e.title}" (${e.count}x, trend: ${e.trend}, severity: ${e.severity})${resolutions.length > 0
            ? ` [${resolutions.filter((r) => r.success).length} successful fixes]`
            : ' [unresolved]'}`;
    })
        .join('\n');
    const clusterSummary = baseAnalysis.clusters
        .map((c) => `- ${c.errors.join(' + ')} (correlation: ${c.correlation})`)
        .join('\n');
    const systemPrompt = `You are a platform reliability engineer analyzing error patterns for the Shre AI platform.
Return ONLY valid JSON with this structure:
{
  "insights": [
    { "code": "SHRE-Exxxx", "rootCause": "...", "suggestedFix": "...", "priority": "critical|high|medium|low" }
  ],
  "overallAssessment": "one paragraph",
  "immediateActions": ["action 1", "action 2"]
}`;
    const prompt = `Analyze these platform errors and provide root cause analysis:

Top errors:
${errorSummary}

Error clusters (fire together):
${clusterSummary || 'None detected'}

Health score: ${baseAnalysis.healthScore}/100

For each error, explain WHY it's happening (root cause) and the BEST fix. Consider cascading failures.`;
    try {
        const aiResponse = await opts.aiCall(prompt, systemPrompt);
        const parsed = JSON.parse(aiResponse);
        if (parsed.insights && Array.isArray(parsed.insights)) {
            for (const insight of parsed.insights) {
                const existing = baseAnalysis.rootCauses.find((r) => r.code === insight.code);
                if (existing) {
                    existing.rootCause = insight.rootCause || existing.rootCause;
                    existing.suggestedFix = insight.suggestedFix || existing.suggestedFix;
                    existing.confidence = Math.min(1, existing.confidence + 0.15);
                }
            }
        }
    }
    catch {
    }
    return baseAnalysis;
}
export function generateErrorTasks(analysis) {
    const tasks = [];
    for (const rc of analysis.rootCauses) {
        const topError = analysis.topErrors.find((e) => e.code === rc.code);
        if (!topError)
            continue;
        if (topError.severity === 'warn' && topError.count < 5)
            continue;
        const priority = topError.severity === 'fatal'
            ? 'critical'
            : topError.trend === 'rising'
                ? 'high'
                : topError.count > 10
                    ? 'high'
                    : topError.severity === 'error'
                        ? 'medium'
                        : 'low';
        const related = rc.relatedErrors.length > 0 ? `\n\n**Related errors:** ${rc.relatedErrors.join(', ')}` : '';
        const evidence = rc.evidence.length > 0
            ? `\n\n**Evidence:**\n${rc.evidence.map((e) => `- ${e}`).join('\n')}`
            : '';
        tasks.push({
            tag: `error-analysis-${rc.code}`,
            title: `[${rc.code}] ${topError.title} — ${topError.count} occurrences (${topError.trend})`,
            description: [
                `**Error Code:** ${rc.code}`,
                `**Category:** ${topError.category}`,
                `**Severity:** ${topError.severity}`,
                `**Occurrences:** ${topError.count} (trend: ${topError.trend})`,
                `**Avg interval:** ${topError.avgIntervalMs > 0 ? `${Math.round(topError.avgIntervalMs / 1000)}s` : 'N/A'}`,
                `**First seen:** ${topError.firstSeen}`,
                `**Last seen:** ${topError.lastSeen}`,
                '',
                `**Root Cause:** ${rc.rootCause}`,
                `**Confidence:** ${Math.round(rc.confidence * 100)}%`,
                '',
                `**Suggested Fix:** ${rc.suggestedFix}`,
                `**Fix Type:** ${rc.fixType}`,
                related,
                evidence,
            ].join('\n'),
            priority,
            category: 'error-recovery',
            errorCode: rc.code,
        });
    }
    for (const cluster of analysis.clusters) {
        if (cluster.correlation < 0.5)
            continue;
        tasks.push({
            tag: `error-cluster-${cluster.errors.sort().join('-')}`,
            title: `Error cluster: ${cluster.name}`,
            description: [
                `**Correlated errors:** ${cluster.errors.join(', ')}`,
                `**Correlation:** ${Math.round(cluster.correlation * 100)}%`,
                `**Likely root cause:** ${cluster.likelyRootCause}`,
                '',
                'These errors fire together — fixing the root cause should resolve all of them.',
            ].join('\n'),
            priority: 'high',
            category: 'error-recovery',
            errorCode: cluster.errors[0] ?? '',
        });
    }
    return tasks;
}
function inferRootCause(topError, instances) {
    const { code, category, count, trend, avgIntervalMs } = topError;
    if (avgIntervalMs > 0 && avgIntervalMs < 120_000 && count > 5) {
        return `Recurring issue detected every ~${Math.round(avgIntervalMs / 1000)}s — likely a monitoring check finding a persistent problem`;
    }
    switch (category) {
        case 'connectivity': {
            const targets = new Set(instances.map((i) => i.context.target ?? i.context.port ?? 'unknown'));
            return `Service connectivity issue affecting: ${[...targets].join(', ')}. ${trend === 'rising' ? 'Getting worse — target service may be degrading.' : ''}`;
        }
        case 'infrastructure':
            return `Infrastructure resource constraint. ${code === 'SHRE-E1001' ? 'Port conflict — duplicate process or stale PID.' : code === 'SHRE-E1006' ? 'NAS/SMB volume offline or disconnected.' : 'System resource exhaustion.'}`;
        case 'auth':
            return `Authentication/authorization failure. ${instances.some((i) => String(i.message).includes('401')) ? 'Credentials expired or rotated without updating the service.' : 'Permission or trust gate misconfiguration.'}`;
        case 'routing':
            return `AI routing pipeline issue. ${code === 'SHRE-E4001' ? 'All API keys exhausted or rate-limited.' : code === 'SHRE-E4004' ? 'Model returning empty — may be overloaded or prompt exceeds context window.' : 'Check model availability and fallback chain.'}`;
        case 'data':
            return `Data layer failure. ${code === 'SHRE-E5001' ? 'CortexDB overloaded or unreachable.' : 'Database connection pool may be exhausted.'}`;
        case 'agent':
            return `Agent execution issue. ${code === 'SHRE-E6002' ? 'Task stuck — executor may have crashed or model timed out.' : 'Check agent logs and tool permissions.'}`;
        default:
            return `Repeated ${category} error (${count}x). Investigate service logs for patterns.`;
    }
}
function inferClusterCause(codeA, codeB) {
    const defA = ErrorCatalog.get(codeA);
    const defB = ErrorCatalog.get(codeB);
    const catA = defA?.category;
    const catB = defB?.category;
    if (catA === 'connectivity' || catB === 'connectivity') {
        const other = catA === 'connectivity' ? defB : defA;
        return `Service down causing cascade: connectivity failure triggers ${other?.category ?? 'unknown'} errors`;
    }
    if ((catA === 'infrastructure' && catB === 'connectivity') ||
        (catB === 'infrastructure' && catA === 'connectivity')) {
        return 'Infrastructure resource issue causing service connectivity failures';
    }
    if ((catA === 'auth' && catB === 'routing') || (catB === 'auth' && catA === 'routing')) {
        return 'Authentication failure blocking AI routing — likely expired or invalid API keys';
    }
    return `${defA?.title ?? codeA} and ${defB?.title ?? codeB} share a common trigger — investigate timing`;
}
function buildEvidence(topError, instances) {
    const evidence = [];
    if (topError.count > 10)
        evidence.push(`High frequency: ${topError.count} occurrences`);
    if (topError.trend === 'rising')
        evidence.push('Trend is rising — issue is getting worse');
    const services = new Set(instances.map((i) => i.service));
    if (services.size > 1)
        evidence.push(`Affects multiple services: ${[...services].join(', ')}`);
    const targets = new Set(instances.map((i) => i.context.target).filter(Boolean));
    if (targets.size > 0)
        evidence.push(`Target(s): ${[...targets].join(', ')}`);
    const uniqueMessages = new Set(instances.map((i) => i.message));
    if (uniqueMessages.size === 1) {
        evidence.push('Same exact error message every time — deterministic failure');
    }
    else {
        evidence.push(`${uniqueMessages.size} unique messages — may have multiple triggers`);
    }
    return evidence;
}
export function withErrorCapture(interceptor, context = {}) {
    return async (fn) => {
        try {
            return await fn();
        }
        catch (err) {
            interceptor.capture(err.message ?? String(err), context, err instanceof Error ? err : undefined);
            return null;
        }
    };
}
