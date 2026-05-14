import { randomUUID } from 'node:crypto';
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
};
function getMinLevel() {
    const env = process.env.SHRE_LOG_LEVEL?.toLowerCase();
    if (env && env in LOG_LEVELS)
        return env;
    return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}
function formatError(err) {
    if (!err)
        return undefined;
    if (err instanceof Error) {
        return {
            message: err.message,
            stack: err.stack,
            code: err.code,
        };
    }
    return { message: String(err) };
}
const SECRET_PATTERNS = [
    /sk-ant-api\w{2}-[\w-]{10,}/g,
    /sk-[a-zA-Z0-9]{20,}/g,
    /AIza[a-zA-Z0-9_-]{30,}/g,
    /xai-[a-zA-Z0-9]{20,}/g,
    /ghp_[a-zA-Z0-9]{36}/g,
    /gho_[a-zA-Z0-9]{36}/g,
];
function redactSecrets(text) {
    let result = text;
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, (match) => match.slice(0, 8) + '***REDACTED***');
    }
    return result;
}
export function createLogger(service, defaultContext) {
    const minLevel = getMinLevel();
    const minLevelNum = LOG_LEVELS[minLevel];
    const ctx = defaultContext ?? {};
    function emit(level, msg, data, err) {
        if (LOG_LEVELS[level] < minLevelNum)
            return;
        const correlationId = (data?.correlationId ?? ctx.correlationId);
        const filteredData = data
            ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'correlationId'))
            : undefined;
        const entry = {
            ts: new Date().toISOString(),
            service,
            level,
            msg,
        };
        if (correlationId)
            entry.correlationId = correlationId;
        if (filteredData && Object.keys(filteredData).length > 0)
            entry.data = filteredData;
        if (err)
            entry.error = formatError(err);
        const output = redactSecrets(JSON.stringify(entry));
        if (level === 'error' || level === 'fatal') {
            process.stderr.write(output + '\n');
        }
        else {
            process.stdout.write(output + '\n');
        }
    }
    function normalizeArgs(dataOrErr, err) {
        if (err !== undefined) {
            return [dataOrErr, err];
        }
        if (dataOrErr === undefined || dataOrErr === null) {
            return [undefined, undefined];
        }
        if (dataOrErr instanceof Error ||
            typeof dataOrErr === 'string' ||
            typeof dataOrErr !== 'object' ||
            Array.isArray(dataOrErr)) {
            return [undefined, dataOrErr];
        }
        return [dataOrErr, undefined];
    }
    const logger = {
        debug: (msg, data) => emit('debug', msg, data),
        info: (msg, data) => emit('info', msg, data),
        warn: (msg, dataOrErr, err) => {
            const [d, e] = normalizeArgs(dataOrErr, err);
            emit('warn', msg, d, e);
        },
        error: (msg, dataOrErr, err) => {
            const [d, e] = normalizeArgs(dataOrErr, err);
            emit('error', msg, d, e);
        },
        fatal: (msg, dataOrErr, err) => {
            const [d, e] = normalizeArgs(dataOrErr, err);
            emit('fatal', msg, d, e);
        },
        child(context) {
            return createLogger(service, { ...ctx, ...context });
        },
        newCorrelationId() {
            return randomUUID().slice(0, 12);
        },
    };
    return logger;
}
export function extractCorrelationId(headers) {
    const existing = headers['x-correlation-id'] ?? headers['x-request-id'];
    if (typeof existing === 'string' && existing.length > 0)
        return existing;
    if (Array.isArray(existing) && existing[0])
        return existing[0];
    return randomUUID().slice(0, 12);
}
export function traceHeaders(correlationId, sourceService) {
    return {
        'X-Correlation-Id': correlationId,
        'X-Source-Service': sourceService ?? '',
    };
}
export function generateCorrelationId(prefix) {
    const ts = Date.now().toString(36);
    const rand = randomUUID().replace(/-/g, '').slice(0, 8);
    return `${prefix ?? 'shre'}-${ts}-${rand}`;
}
export function createCorrelationMiddleware(service) {
    const baseLog = createLogger(service);
    function middleware(req, res, next) {
        const correlationId = extractCorrelationId(req.headers ?? {});
        req.correlationId = correlationId;
        req.log = baseLog.child({ correlationId });
        res.setHeader('x-correlation-id', correlationId);
        next();
    }
    function getCorrelationId(req) {
        return req.correlationId ?? extractCorrelationId(req.headers ?? {});
    }
    return { middleware, getCorrelationId };
}
