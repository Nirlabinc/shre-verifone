export interface R2Config {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint?: string;
}
export interface R2PutOptions {
    contentType?: string;
    metadata?: Record<string, string>;
    bucket?: string;
}
export interface R2ListResult {
    key: string;
    size: number;
    lastModified: string;
}
export interface R2Client {
    put(key: string, body: Buffer | string, opts?: R2PutOptions): Promise<void>;
    get(key: string, bucket?: string): Promise<Buffer | null>;
    head(key: string, bucket?: string): Promise<{
        size: number;
        lastModified: string;
    } | null>;
    list(prefix: string, maxKeys?: number, bucket?: string): Promise<R2ListResult[]>;
    delete(key: string, bucket?: string): Promise<void>;
    isEnabled(): boolean;
}
export declare function createR2Client(service: string, config?: Partial<R2Config>): R2Client;
