export class CircuitOpenError extends Error {
    constructor(name) {
        super(`Circuit breaker '${name}' is open — request blocked`);
        this.name = 'CircuitOpenError';
    }
}
export class CircuitBreaker {
    state = 'closed';
    failures = 0;
    lastFailure = 0;
    name;
    failureThreshold;
    resetTimeout;
    timeout;
    constructor(opts) {
        this.name = opts.name;
        this.failureThreshold = opts.failureThreshold ?? 5;
        this.resetTimeout = opts.resetTimeout ?? 30_000;
        this.timeout = opts.timeout ?? 10_000;
    }
    async call(fn) {
        if (this.state === 'open') {
            if (Date.now() - this.lastFailure >= this.resetTimeout) {
                this.state = 'half-open';
            }
            else {
                throw new CircuitOpenError(this.name);
            }
        }
        try {
            const result = await this.withTimeout(fn);
            this.failures = 0;
            this.state = 'closed';
            return result;
        }
        catch (err) {
            this.recordFailure();
            throw err;
        }
    }
    getState() {
        return { state: this.state, failures: this.failures, name: this.name };
    }
    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();
        if (this.failures >= this.failureThreshold) {
            this.state = 'open';
        }
    }
    withTimeout(fn) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Circuit '${this.name}' call timed out after ${this.timeout}ms`));
            }, this.timeout);
            fn().then((val) => {
                clearTimeout(timer);
                resolve(val);
            }, (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
}
export class CortexBreaker {
    state = 'closed';
    failures = 0;
    failureWindowStart = 0;
    lastFailure = 0;
    name;
    publishFn;
    onOpen;
    onClose;
    failureThreshold = 3;
    failureWindowMs = 5_000;
    resetTimeout = 15_000;
    timeout = 10_000;
    constructor(opts = {}) {
        this.name = opts.name ?? 'cortex-breaker';
        this.publishFn = opts.publishFn;
        this.onOpen = opts.onOpen;
        this.onClose = opts.onClose;
    }
    async call(fn) {
        if (this.state === 'open') {
            if (Date.now() - this.lastFailure >= this.resetTimeout) {
                this.state = 'half-open';
            }
            else {
                throw new CircuitOpenError(this.name);
            }
        }
        try {
            const result = await this.withTimeout(fn);
            if (this.state !== 'closed') {
                this.emitClosed();
            }
            this.failures = 0;
            this.state = 'closed';
            return result;
        }
        catch (err) {
            this.recordFailure();
            throw err;
        }
    }
    getState() {
        if (this.state === 'open' && Date.now() - this.lastFailure >= this.resetTimeout) {
            this.state = 'half-open';
        }
        return { state: this.state, failures: this.failures, name: this.name };
    }
    recordFailure() {
        const now = Date.now();
        if (now - this.failureWindowStart > this.failureWindowMs) {
            this.failures = 0;
            this.failureWindowStart = now;
        }
        this.failures++;
        this.lastFailure = now;
        if (this.failures >= this.failureThreshold && this.state !== 'open') {
            this.state = 'open';
            this.emitOpened();
        }
    }
    emitOpened() {
        this.onOpen?.();
        if (this.publishFn) {
            this.publishFn('cortex.circuit.opened', 'critical', {
                breaker: this.name,
                failures: this.failures,
                timestamp: new Date().toISOString(),
            }).catch(() => {
            });
        }
    }
    emitClosed() {
        this.onClose?.();
        if (this.publishFn) {
            this.publishFn('cortex.circuit.closed', 'info', {
                breaker: this.name,
                recoveredAt: new Date().toISOString(),
            }).catch(() => { });
        }
    }
    withTimeout(fn) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`CortexBreaker '${this.name}' timed out after ${this.timeout}ms`));
            }, this.timeout);
            fn().then((val) => {
                clearTimeout(timer);
                resolve(val);
            }, (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
}
