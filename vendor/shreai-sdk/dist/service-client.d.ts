export interface ServiceCallOpts {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
    stream?: boolean;
    signal?: AbortSignal;
}
export interface ServiceClient {
    call<T = unknown>(service: string, path: string, opts?: ServiceCallOpts): Promise<T>;
    fetch(service: string, path: string, opts?: ServiceCallOpts): Promise<Response>;
    healthy(service: string): Promise<boolean>;
}
export declare function createServiceClient(caller: string): ServiceClient;
