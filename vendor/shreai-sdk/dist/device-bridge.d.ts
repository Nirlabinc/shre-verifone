import type { PlatformOS } from './platform.js';
export type DeviceCapability = 'camera' | 'microphone' | 'gps' | 'accelerometer' | 'gyroscope' | 'bluetooth' | 'wifi-scan' | 'notifications' | 'contacts' | 'calendar' | 'sms' | 'phone' | 'clipboard' | 'screen-capture' | 'file-system' | 'shell' | 'browser' | 'usb' | 'gpio' | 'serial' | 'nfc';
export interface DeviceInfo {
    id: string;
    name: string;
    platform: PlatformOS;
    arch: string;
    osVersion: string;
    appVersion: string;
    capabilities: DeviceCapability[];
    metadata?: Record<string, unknown>;
}
export interface ConnectedDevice extends DeviceInfo {
    connectedAt: number;
    lastSeenAt: number;
    latencyMs: number;
    status: 'online' | 'idle' | 'busy' | 'offline';
}
export type BridgeMessageType = 'register' | 'task' | 'result' | 'telemetry' | 'event' | 'ping' | 'pong' | 'error' | 'capability-query' | 'capability-response';
export interface BridgeMessage {
    type: BridgeMessageType;
    id: string;
    deviceId?: string;
    timestamp: number;
    data: Record<string, unknown>;
}
export interface DeviceTask {
    taskId: string;
    action: string;
    params: Record<string, unknown>;
    timeoutMs?: number;
    requiredCapabilities?: DeviceCapability[];
}
export interface TaskResult {
    taskId: string;
    status: 'success' | 'error' | 'timeout' | 'unsupported';
    data?: Record<string, unknown>;
    error?: string;
    durationMs: number;
}
export interface DeviceBridgeOptions {
    port?: number;
    heartbeatMs?: number;
    offlineTimeoutMs?: number;
    maxDevices?: number;
    authToken?: string;
}
export interface DeviceBridge {
    devices(): ConnectedDevice[];
    device(id: string): ConnectedDevice | null;
    sendTask(deviceId: string, task: DeviceTask): Promise<TaskResult>;
    dispatch(task: DeviceTask): Promise<TaskResult>;
    broadcast(type: BridgeMessageType, data: Record<string, unknown>): void;
    onDevice(event: 'register' | 'disconnect' | 'telemetry' | 'event', handler: (device: ConnectedDevice, data?: Record<string, unknown>) => void): void;
    shutdown(): Promise<void>;
}
export declare function createDeviceBridge(opts?: DeviceBridgeOptions): DeviceBridge;
export interface DeviceClientOptions {
    serverUrl: string;
    deviceInfo: Omit<DeviceInfo, 'id'> & {
        id?: string;
    };
    authToken?: string;
    autoReconnect?: boolean;
    reconnectMs?: number;
    telemetryIntervalMs?: number;
}
export interface DeviceClient {
    connect(): Promise<void>;
    onTask(handler: (task: DeviceTask) => Promise<TaskResult>): void;
    sendTelemetry(metrics: Record<string, unknown>): void;
    sendEvent(eventType: string, data: Record<string, unknown>): void;
    disconnect(): void;
    connected(): boolean;
}
export declare function createDeviceClientProtocol(opts: DeviceClientOptions): {
    setSender(fn: (msg: BridgeMessage) => void): void;
    handleIncoming(msg: BridgeMessage): Promise<void>;
    register(): void;
    onTask(handler: (task: DeviceTask) => Promise<TaskResult>): void;
    sendTelemetry(metrics: Record<string, unknown>): void;
    sendEvent(eventType: string, data: Record<string, unknown>): void;
    connected(): boolean;
    deviceId: string;
};
