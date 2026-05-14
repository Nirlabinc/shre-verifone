import { type Logger } from './logger.js';
export type HookPhase = 'before' | 'after';
export type HookHandler<T> = (ctx: T) => T | Promise<T>;
export interface HookPoint<T> {
    tap(phase: HookPhase, handler: HookHandler<T>, priority?: number): () => void;
    run(phase: HookPhase, ctx: T): Promise<T>;
    size(): number;
}
export interface HookConfig {
    logger?: Logger;
}
export interface HookRegistry {
    define<T>(name: string): HookPoint<T>;
    get<T>(name: string): HookPoint<T> | undefined;
    list(): string[];
}
export declare function createHookRegistry(config?: HookConfig): HookRegistry;
