export type AlertSeverity = 'warn' | 'critical' | 'emergency';
export interface InfraAlert {
    category: 'ram' | 'cpu' | 'disk' | 'network' | 'process';
    metric: string;
    message: string;
    severity: AlertSeverity;
    value: number;
    threshold: number;
    ts: string;
}
export type PressureLevel = 'normal' | 'warn' | 'critical';
export interface RamMetrics {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPct: number;
    pressureLevel: PressureLevel;
    swapUsedBytes: number;
}
export type CpuPressure = 'normal' | 'warn' | 'critical';
export interface CpuMetrics {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    usagePct: number;
    coreCount: number;
    pressure: CpuPressure;
}
export interface DiskVolumeMetrics {
    volume: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPct: number;
    inodeUsedPct: number;
}
export interface DiskMetrics {
    volumes: DiskVolumeMetrics[];
}
export interface NetworkMetrics {
    packetLossPct: number;
    dnsResolutionMs: number;
    gatewayReachable: boolean;
}
export interface ProcessMetrics {
    totalProcesses: number;
    zombieCount: number;
    openFileDescriptors: number;
    fdLimit: number;
    fdUsedPct: number;
}
export interface InfraSnapshot {
    ts: string;
    service: string;
    ram: RamMetrics;
    cpu: CpuMetrics;
    disk: DiskMetrics;
    network: NetworkMetrics;
    process: ProcessMetrics;
    alerts: InfraAlert[];
    collectionMs: number;
}
export interface InfraMonitorOptions {
    publishFn?: (event: string, severity: string, data: Record<string, unknown>) => void;
    maxSnapshots?: number;
    maxDiskSamples?: number;
    volumes?: string[];
    thresholds?: Partial<InfraThresholds>;
}
export interface InfraThresholds {
    ramWarnPct: number;
    ramCriticalPct: number;
    cpuWarnMultiplier: number;
    cpuCriticalMultiplier: number;
    diskWarnPct: number;
    diskCriticalPct: number;
    diskEmergencyPct: number;
    inodeWarnPct: number;
    inodeCriticalPct: number;
    packetLossWarnPct: number;
    packetLossCriticalPct: number;
    dnsWarnMs: number;
    dnsCriticalMs: number;
    zombieWarnCount: number;
    zombieCriticalCount: number;
    fdCriticalPct: number;
}
export interface DiskPrediction {
    volume: string;
    daysUntilFull: number;
    growthBytesPerDay: number;
    sampleCount: number;
}
export interface InfraMonitor {
    snapshot(): Promise<InfraSnapshot>;
    getLatest(): InfraSnapshot | null;
    getHistory(limit?: number): InfraSnapshot[];
    getAlerts(): InfraAlert[];
    predictDiskFull(volume?: string): DiskPrediction;
    startPeriodicCollection(intervalMs?: number): void;
    stop(): void;
}
export declare function createInfraMonitor(serviceName: string, options?: InfraMonitorOptions): InfraMonitor;
