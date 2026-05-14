export interface InternalClientOptions {
    serviceName: string;
    secret?: string;
}
export declare class InternalServiceClient {
    private serviceName;
    private secret?;
    constructor(opts: InternalClientOptions);
    call(targetService: string, path: string, init?: RequestInit): Promise<Response>;
    get(targetService: string, path: string, init?: RequestInit): Promise<Response>;
    post(targetService: string, path: string, body: any, init?: RequestInit): Promise<Response>;
}
export declare function createInternalClient(serviceName: string, secret?: string): InternalServiceClient;
