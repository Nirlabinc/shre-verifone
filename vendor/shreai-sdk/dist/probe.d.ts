export interface NetworkConnection {
    protocol: 'tcp' | 'udp';
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    state: string;
    pid?: number;
    process?: string;
}
export interface NetworkProbe {
    connections(): NetworkConnection[];
    listeners(): NetworkConnection[];
    isPortInUse(port: number): boolean;
    whosOnPort(port: number): {
        pid: number;
        process: string;
    } | null;
}
export declare function createNetworkProbe(): NetworkProbe;
export interface PortScanResult {
    port: number;
    open: boolean;
    service?: string;
    responseTimeMs: number;
}
export interface PortScannerOptions {
    timeoutMs?: number;
    concurrency?: number;
}
export declare function createPortScanner(opts?: PortScannerOptions): {
    scanPort(host: string, port: number): Promise<PortScanResult>;
    scanRange(host: string, startPort: number, endPort: number): Promise<PortScanResult[]>;
    scanPorts(host: string, ports: number[]): Promise<PortScanResult[]>;
    scanCommon(host: string): Promise<PortScanResult[]>;
    scanShreServices(host?: string): Promise<PortScanResult[]>;
};
export interface ProcessInfo {
    pid: number;
    ppid: number;
    name: string;
    command: string;
    user: string;
    cpuPercent: number;
    memoryMB: number;
    startTime: string;
}
export interface ProcessProbe {
    list(nameFilter?: string): ProcessInfo[];
    get(pid: number): ProcessInfo | null;
    shreProcesses(): ProcessInfo[];
    resources(): {
        cpuUsagePercent: number;
        memoryUsedMB: number;
        memoryTotalMB: number;
        loadAvg: number[];
    };
}
export declare function createProcessProbe(): ProcessProbe;
export interface FileEvent {
    type: 'create' | 'modify' | 'delete' | 'rename';
    path: string;
    timestamp: number;
}
export interface FileWatcher {
    watch(path: string, handler: (event: FileEvent) => void): void;
    stop(): void;
    active(): boolean;
}
export declare function createFileWatcher(): FileWatcher;
