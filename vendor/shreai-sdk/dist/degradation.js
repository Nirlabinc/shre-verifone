import { createLogger } from './logger.js';
const RING_BUFFER_SIZE = 100;
class RingBuffer {
    items = [];
    maxSize;
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    push(item) {
        if (this.items.length >= this.maxSize) {
            this.items.shift();
        }
        this.items.push(item);
    }
    getAll() {
        return [...this.items];
    }
    getLast(n) {
        return this.items.slice(-n);
    }
}
const ONE_HOUR_MS = 60 * 60_000;
export function createDegradationReporter(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const buffer = new RingBuffer(RING_BUFFER_SIZE);
    function report(component, severity, message, metadata) {
        const event = {
            service: serviceName,
            component,
            severity,
            message,
            timestamp: new Date().toISOString(),
            ...(metadata && { metadata }),
        };
        buffer.push(event);
        log.warn(`[degradation] ${component}: ${message}`, {
            component,
            severity,
            ...metadata,
        });
        if (opts.publishFn) {
            const eventSeverity = severity === 'critical' ? 'critical' : severity === 'major' ? 'warning' : 'info';
            opts
                .publishFn('degradation.detected', eventSeverity, {
                service: serviceName,
                component,
                severity,
                message,
                ...metadata,
            })
                .catch(() => {
            });
        }
    }
    function getRecent(limit = 20) {
        return buffer.getLast(limit);
    }
    function getCounts() {
        const cutoff = Date.now() - ONE_HOUR_MS;
        const counts = {};
        for (const event of buffer.getAll()) {
            if (new Date(event.timestamp).getTime() >= cutoff) {
                counts[event.component] = (counts[event.component] ?? 0) + 1;
            }
        }
        return counts;
    }
    return { report, getRecent, getCounts };
}
