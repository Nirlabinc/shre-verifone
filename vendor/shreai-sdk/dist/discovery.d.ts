import type { PortsConfig, ServiceEntry, InfraEntry } from './types.js';
export declare function reloadPorts(): PortsConfig;
export declare function getPorts(): PortsConfig;
export declare function getService(name: string): ServiceEntry;
export declare function getInfra(name: string): InfraEntry;
export declare function resolveAllHosts(name: string): string[];
export declare function serviceUrl(name: string): string;
export declare function infraUrl(name: string): string;
export declare function getNodeIdentity(): {
    nodeId: string;
    hostname: string;
    host: string;
};
export declare function listServices(): string[];
export declare function listInfra(): string[];
