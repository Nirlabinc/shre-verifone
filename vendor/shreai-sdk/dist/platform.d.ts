export type PlatformOS = 'macos' | 'linux' | 'windows' | 'android' | 'ios' | 'unknown';
export type PlatformArch = 'arm64' | 'x64' | 'arm' | 'unknown';
export type PlatformTier = 'server' | 'desktop' | 'mobile' | 'embedded' | 'unknown';
export interface PlatformInfo {
    os: PlatformOS;
    arch: PlatformArch;
    tier: PlatformTier;
    hostname: string;
    cpuCount: number;
    totalMemoryMB: number;
    freeMemoryMB: number;
    nodeVersion: string;
    kernelProbeSupport: ('ebpf' | 'dtrace' | 'etw')[];
    serviceManager: 'launchd' | 'systemd' | 'windows-service' | 'none';
}
export declare function detectPlatform(): PlatformInfo;
export interface PlatformPaths {
    config: string;
    data: string;
    cache: string;
    logs: string;
    runtime: string;
    services: string;
}
export declare function getPlatformPaths(appName?: string): PlatformPaths;
export interface ServiceDefinition {
    name: string;
    displayName: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    restartOnFailure?: boolean;
    startOnBoot?: boolean;
}
export interface ServiceManager {
    install(def: ServiceDefinition): Promise<{
        path: string;
        content: string;
    }>;
    generate(def: ServiceDefinition): string;
    start(name: string): Promise<void>;
    stop(name: string): Promise<void>;
    status(name: string): Promise<'running' | 'stopped' | 'unknown'>;
}
export declare function createServiceManager(): ServiceManager;
export interface HardwareCapabilities {
    recommendedTier: 'lite' | 'standard' | 'full';
    canRunCortexDB: boolean;
    canRunLocalLLM: boolean;
    maxConcurrentTasks: number;
    gpu: string | null;
    warnings: string[];
}
export declare function assessHardware(): HardwareCapabilities;
export interface KernelProbe {
    type: 'ebpf' | 'dtrace' | 'etw';
    attach(program: string): Promise<void>;
    detach(): Promise<void>;
    active(): boolean;
}
export declare function createKernelProbe(type: 'ebpf' | 'dtrace' | 'etw'): KernelProbe;
