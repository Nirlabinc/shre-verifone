export type CircuitState = 'closed' | 'open' | 'half-open';
export interface CircuitBreakerOptions {
    name: string;
    failureThreshold?: number;
    resetTimeout?: number;
    timeout?: number;
}
export declare class CircuitOpenError extends Error {
    constructor(name: string);
}
export declare class CircuitBreaker {
    private state;
    private failures;
    private lastFailure;
    private readonly name;
    private readonly failureThreshold;
    private readonly resetTimeout;
    private readonly timeout;
    constructor(opts: CircuitBreakerOptions);
    call<T>(fn: () => Promise<T>): Promise<T>;
    getState(): {
        state: CircuitState;
        failures: number;
        name: string;
    };
    private recordFailure;
    private withTimeout;
}
export interface CortexBreakerOptions {
    name?: string;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    onOpen?: () => void;
    onClose?: () => void;
}
export declare class CortexBreaker {
    private state;
    private failures;
    private failureWindowStart;
    private lastFailure;
    private readonly name;
    private readonly publishFn?;
    private readonly onOpen?;
    private readonly onClose?;
    private readonly failureThreshold;
    private readonly failureWindowMs;
    private readonly resetTimeout;
    private readonly timeout;
    constructor(opts?: CortexBreakerOptions);
    call<T>(fn: () => Promise<T>): Promise<T>;
    getState(): {
        state: CircuitState;
        failures: number;
        name: string;
    };
    private recordFailure;
    private emitOpened;
    private emitClosed;
    private withTimeout;
}
