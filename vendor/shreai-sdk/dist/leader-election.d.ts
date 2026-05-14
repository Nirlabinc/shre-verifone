export interface LeaderElectionOptions {
    ttlMs?: number;
    renewMs?: number;
    redisUrl?: string;
}
export interface LeaderElection {
    acquire(): Promise<boolean>;
    release(): Promise<void>;
    withLock<T>(fn: () => Promise<T>): Promise<T | null>;
    isLeader(): boolean;
    shutdown(): Promise<void>;
}
export declare function getNodeId(): string;
export declare function createLeaderElection(lockName: string, opts?: LeaderElectionOptions): LeaderElection;
