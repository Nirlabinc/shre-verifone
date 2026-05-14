export interface DomainGuardOptions {
    strict?: boolean;
}
export interface DomainGuard {
    beforeWrite(collection: string, data?: unknown): void;
    isOwnedCollection(collection: string): boolean;
}
export declare function validateDomainAccess(service: string, collection: string, operation: 'read' | 'write'): boolean;
export declare function getDomainMap(): Readonly<Record<string, readonly string[]>>;
export declare function createDomainGuard(serviceName: string, options?: DomainGuardOptions): DomainGuard;
