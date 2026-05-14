import { type Logger } from './logger.js';
export type PowerState = 'active' | 'idle' | 'sleep' | 'waking';
export interface PowerManagerOptions {
    idleThresholdMs?: number;
    sleepThresholdMs?: number;
    checkIntervalMs?: number;
    onIdle?: () => void | Promise<void>;
    onSleep?: () => void | Promise<void>;
    onWake?: () => void | Promise<void>;
    onStateChange?: (from: PowerState, to: PowerState) => void;
    logger?: Logger;
    neverSleep?: boolean;
}
export interface PowerManager {
    touch(): void;
    state(): PowerState;
    idleMs(): number;
    wake(): Promise<void>;
    forceSleep(): Promise<void>;
    start(): void;
    stop(): void;
    stats(): PowerStats;
}
export interface PowerStats {
    currentState: PowerState;
    lastActivityAt: string;
    idleMs: number;
    totalIdleMs: number;
    totalSleepMs: number;
    totalActiveMs: number;
    transitionCount: number;
    uptimeMs: number;
}
export declare function createPowerManager(serviceName: string, opts?: PowerManagerOptions): PowerManager;
export declare function createPowerMiddleware(pm: PowerManager): {
    touch: (_c: unknown, next: () => Promise<unknown>) => Promise<unknown>;
};
