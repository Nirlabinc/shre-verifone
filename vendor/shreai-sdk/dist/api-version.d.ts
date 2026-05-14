import { type Logger } from './logger.js';
export interface VersionConfig {
    current: number;
    supported: number[];
    deprecated?: DeprecatedVersion[];
    logger?: Logger;
}
export interface DeprecatedVersion {
    version: number;
    sunsetDate: string;
    migrationGuide?: string;
}
export interface VersionInfo {
    requested: number;
    isDeprecated: boolean;
    sunsetDate?: string;
    isSupported: boolean;
}
export interface VersioningStats {
    byVersion: Record<number, number>;
    deprecatedUsage: number;
    rejections: number;
}
export interface Versioning {
    extractVersion(path: string, headers?: Record<string, string>, query?: Record<string, string>): VersionInfo;
    responseHeaders(info: VersionInfo): Record<string, string>;
    middleware(): (c: any, next: () => Promise<any>) => Promise<any>;
    expressMiddleware(): (req: any, res: any, next: () => void) => void;
    stats(): VersioningStats;
    isSupported(version: number): boolean;
}
export declare function createVersioning(serviceName: string, config: VersionConfig): Versioning;
