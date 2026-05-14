import { type Logger } from './logger.js';
export declare const VFS_ZONES: readonly ["tmp", "persist", "shared"];
export type VfsZone = (typeof VFS_ZONES)[number];
export declare const VFS_DEFAULTS: {
    readonly tmpTtlMs: 3600000;
    readonly persistTtlMs: 0;
    readonly sharedTtlMs: 0;
    readonly maxValueBytes: 1048576;
    readonly cortexDataType: "agent_vfs";
    readonly redisPrefix: "shre:vfs:";
};
export interface VfsEntry {
    path: string;
    zone: VfsZone;
    data: unknown;
    agentId?: string;
    createdAt: string;
    updatedAt: string;
    ttlMs?: number;
    size: number;
}
export interface VfsListEntry {
    path: string;
    zone: VfsZone;
    agentId?: string;
    size: number;
    updatedAt: string;
}
export interface VfsWriteOptions {
    ttlMs?: number;
    metadata?: Record<string, unknown>;
}
export interface VfsClientOptions {
    agentId?: string;
    redisUrl?: string;
    cortexUrl?: string;
    logger?: Logger;
}
export interface VfsClient {
    read(path: string): Promise<VfsEntry | null>;
    write(path: string, data: unknown, options?: VfsWriteOptions): Promise<boolean>;
    list(prefix: string, limit?: number): Promise<VfsListEntry[]>;
    delete(path: string): Promise<boolean>;
    exists(path: string): Promise<boolean>;
}
export interface ParsedPath {
    zone: VfsZone;
    agentId: string | null;
    key: string;
    raw: string;
}
export declare function parsePath(path: string): ParsedPath;
export declare function createVfsClient(serviceName: string, options?: VfsClientOptions): VfsClient;
