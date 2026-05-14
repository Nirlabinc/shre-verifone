export interface Dependency {
    name: string;
    url: string;
    timeout?: number;
    optional?: boolean;
}
export interface StartupResult {
    ok: boolean;
    passed: string[];
    failed: string[];
    warnings: string[];
}
export declare function validateDependencies(deps: Dependency[], options?: {
    retries?: number;
    retryDelay?: number;
    exitOnFail?: boolean;
}): Promise<StartupResult>;
