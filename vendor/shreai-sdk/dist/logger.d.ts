export interface Logger {
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, dataOrErr?: Record<string, unknown> | unknown, err?: unknown): void;
    error(msg: string, dataOrErr?: Record<string, unknown> | unknown, err?: unknown): void;
    fatal(msg: string, dataOrErr?: Record<string, unknown> | unknown, err?: unknown): void;
    child(context: {
        correlationId?: string;
        [key: string]: unknown;
    }): Logger;
    newCorrelationId(): string;
}
export declare function createLogger(service: string, defaultContext?: Record<string, unknown>): Logger;
export declare function extractCorrelationId(headers: Record<string, string | string[] | undefined>): string;
export declare function traceHeaders(correlationId: string, sourceService?: string): Record<string, string>;
export declare function generateCorrelationId(prefix?: string): string;
interface ExpressLikeRequest {
    headers?: Record<string, string | string[] | undefined>;
    correlationId?: string;
    log?: Logger;
    [key: string]: unknown;
}
interface ExpressLikeResponse {
    setHeader(name: string, value: string): void;
    [key: string]: unknown;
}
export declare function createCorrelationMiddleware(service: string): {
    middleware: (req: ExpressLikeRequest, res: ExpressLikeResponse, next: () => void) => void;
    getCorrelationId: (req: ExpressLikeRequest) => string;
};
export {};
