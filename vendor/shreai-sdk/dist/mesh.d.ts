export type NodeRole = 'brain' | 'gpu' | 'builder' | 'qa' | 'watchdog' | 'inference' | string;
export interface MeshNode {
    id: string;
    hostname: string;
    tailscaleIp: string | null;
    magicDns: string | null;
    hardware: string;
    os: string;
    role: NodeRole;
    description: string;
    services: string[];
    priority: string;
    keepAlive: boolean;
    statusNote?: string;
}
export interface MeshTopology {
    tailnet: {
        suffix: string;
        account: string;
    };
    nodes: MeshNode[];
    failover: {
        strategy: string;
        detection: {
            method: string;
            intervalMs: number;
            missThreshold: number;
            deadThreshold: number;
        };
    };
}
export interface NodeHealthStatus {
    nodeId: string;
    hostname: string;
    role: NodeRole;
    tailscaleIp: string | null;
    reachable: boolean;
    httpStatus: number | null;
    latencyMs: number | null;
    checkedAt: string;
}
export declare function reloadMesh(): MeshTopology;
export declare function getMeshNodes(): MeshNode[];
export declare function getMeshTopology(): MeshTopology;
interface NodeHealthEntry {
    healthy: boolean;
    lastChecked: number;
    latencyMs: number;
}
export declare function updateNodeHealth(nodeId: string, healthy: boolean, latencyMs?: number): void;
export declare function feedHealthFromHeartbeat(depStatuses: Record<string, {
    reachable: boolean;
    latencyMs?: number;
}>): void;
export declare function getNodeHealth(nodeId: string): NodeHealthEntry | undefined;
export declare function isNodeHealthy(nodeId: string): boolean;
export declare function resolveServiceHost(serviceName: string): string;
export declare function resolveServiceHostAsync(serviceName: string, probeTimeoutMs?: number): Promise<string>;
export declare function getNodeByRole(role: NodeRole): MeshNode | undefined;
export declare function getMeshHealth(): Promise<NodeHealthStatus[]>;
export {};
