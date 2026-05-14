import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
const log = createLogger('shre-sdk:device-bridge');
export function createDeviceBridge(opts = {}) {
    const heartbeatMs = opts.heartbeatMs ?? 30_000;
    const offlineTimeoutMs = opts.offlineTimeoutMs ?? 90_000;
    const maxDevices = opts.maxDevices ?? 50;
    const devices = new Map();
    const deviceSenders = new Map();
    const pendingTasks = new Map();
    const handlers = {
        register: [],
        disconnect: [],
        telemetry: [],
        event: [],
    };
    const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, device] of devices) {
            if (now - device.lastSeenAt > offlineTimeoutMs) {
                device.status = 'offline';
                handlers.disconnect?.forEach((h) => h(device));
                devices.delete(id);
                deviceSenders.delete(id);
                log.info('Device timed out', { deviceId: id, name: device.name });
            }
            else {
                const sender = deviceSenders.get(id);
                if (sender) {
                    sender({ type: 'ping', id: randomUUID(), timestamp: Date.now(), data: {} });
                }
            }
        }
    }, heartbeatMs);
    function handleMessage(msg, sendFn) {
        const deviceId = msg.deviceId || msg.data?.deviceId;
        switch (msg.type) {
            case 'register': {
                if (devices.size >= maxDevices && !devices.has(deviceId)) {
                    sendFn({
                        type: 'error',
                        id: randomUUID(),
                        timestamp: Date.now(),
                        data: { error: 'Max devices reached', maxDevices },
                    });
                    return;
                }
                const info = msg.data;
                const device = {
                    ...info,
                    id: deviceId || info.id || randomUUID(),
                    connectedAt: Date.now(),
                    lastSeenAt: Date.now(),
                    latencyMs: 0,
                    status: 'online',
                };
                devices.set(device.id, device);
                deviceSenders.set(device.id, sendFn);
                handlers.register?.forEach((h) => h(device));
                log.info('Device registered', {
                    deviceId: device.id,
                    name: device.name,
                    platform: device.platform,
                    capabilities: device.capabilities,
                });
                sendFn({
                    type: 'register',
                    id: randomUUID(),
                    timestamp: Date.now(),
                    data: { accepted: true, deviceId: device.id },
                });
                break;
            }
            case 'pong': {
                const device = devices.get(deviceId);
                if (device) {
                    device.lastSeenAt = Date.now();
                    if (msg.data?.pingTimestamp) {
                        device.latencyMs = Date.now() - msg.data.pingTimestamp;
                    }
                }
                break;
            }
            case 'result': {
                const result = msg.data;
                const pending = pendingTasks.get(result.taskId);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingTasks.delete(result.taskId);
                    pending.resolve(result);
                }
                const device = devices.get(deviceId);
                if (device) {
                    device.lastSeenAt = Date.now();
                    device.status = 'online';
                }
                break;
            }
            case 'telemetry': {
                const device = devices.get(deviceId);
                if (device) {
                    device.lastSeenAt = Date.now();
                    handlers.telemetry?.forEach((h) => h(device, msg.data));
                }
                break;
            }
            case 'event': {
                const device = devices.get(deviceId);
                if (device) {
                    device.lastSeenAt = Date.now();
                    handlers.event?.forEach((h) => h(device, msg.data));
                }
                break;
            }
        }
    }
    return {
        devices() {
            return Array.from(devices.values());
        },
        device(id) {
            return devices.get(id) || null;
        },
        async sendTask(deviceId, task) {
            const sender = deviceSenders.get(deviceId);
            const device = devices.get(deviceId);
            if (!sender || !device) {
                return {
                    taskId: task.taskId,
                    status: 'error',
                    error: 'Device not connected',
                    durationMs: 0,
                };
            }
            if (task.requiredCapabilities) {
                const missing = task.requiredCapabilities.filter((c) => !device.capabilities.includes(c));
                if (missing.length > 0) {
                    return {
                        taskId: task.taskId,
                        status: 'unsupported',
                        error: `Missing capabilities: ${missing.join(', ')}`,
                        durationMs: 0,
                    };
                }
            }
            device.status = 'busy';
            return new Promise((resolve) => {
                const timeout = task.timeoutMs ?? 30_000;
                const timer = setTimeout(() => {
                    pendingTasks.delete(task.taskId);
                    device.status = 'online';
                    resolve({
                        taskId: task.taskId,
                        status: 'timeout',
                        error: `Timed out after ${timeout}ms`,
                        durationMs: timeout,
                    });
                }, timeout);
                pendingTasks.set(task.taskId, { resolve, timer });
                sender({
                    type: 'task',
                    id: randomUUID(),
                    deviceId,
                    timestamp: Date.now(),
                    data: task,
                });
            });
        },
        async dispatch(task) {
            for (const [id, device] of devices) {
                if (device.status !== 'online')
                    continue;
                if (task.requiredCapabilities) {
                    const hasAll = task.requiredCapabilities.every((c) => device.capabilities.includes(c));
                    if (!hasAll)
                        continue;
                }
                return this.sendTask(id, task);
            }
            return {
                taskId: task.taskId,
                status: 'error',
                error: 'No suitable device available',
                durationMs: 0,
            };
        },
        broadcast(type, data) {
            const msg = { type, id: randomUUID(), timestamp: Date.now(), data };
            for (const sender of deviceSenders.values()) {
                try {
                    sender(msg);
                }
                catch (err) {
                    log.debug('[device-bridge] Broadcast to device failed', {
                        error: err.message,
                    });
                }
            }
        },
        onDevice(event, handler) {
            if (handlers[event]) {
                handlers[event].push(handler);
            }
        },
        async shutdown() {
            clearInterval(heartbeatTimer);
            for (const [taskId, pending] of pendingTasks) {
                clearTimeout(pending.timer);
                pending.resolve({ taskId, status: 'error', error: 'Bridge shutting down', durationMs: 0 });
            }
            pendingTasks.clear();
            devices.clear();
            deviceSenders.clear();
            log.info('Device bridge shut down');
        },
        handleMessage,
    };
}
export function createDeviceClientProtocol(opts) {
    const deviceId = opts.deviceInfo.id || randomUUID();
    let sendFn = null;
    let taskHandler = null;
    let isConnected = false;
    function send(type, data) {
        if (!sendFn)
            return;
        sendFn({
            type,
            id: randomUUID(),
            deviceId,
            timestamp: Date.now(),
            data,
        });
    }
    return {
        setSender(fn) {
            sendFn = fn;
        },
        async handleIncoming(msg) {
            switch (msg.type) {
                case 'register':
                    if (msg.data.accepted) {
                        isConnected = true;
                        log.info('Registered with bridge', { deviceId });
                    }
                    break;
                case 'task':
                    if (taskHandler) {
                        const task = msg.data;
                        try {
                            const startTime = Date.now();
                            const result = await taskHandler(task);
                            result.durationMs = Date.now() - startTime;
                            send('result', result);
                        }
                        catch (err) {
                            send('result', {
                                taskId: task.taskId,
                                status: 'error',
                                error: err instanceof Error ? err.message : String(err),
                                durationMs: 0,
                            });
                        }
                    }
                    else {
                        send('result', {
                            taskId: msg.data.taskId,
                            status: 'unsupported',
                            error: 'No task handler registered',
                            durationMs: 0,
                        });
                    }
                    break;
                case 'ping':
                    send('pong', { pingTimestamp: msg.timestamp });
                    break;
            }
        },
        register() {
            send('register', {
                ...opts.deviceInfo,
                id: deviceId,
                ...(opts.authToken ? { authToken: opts.authToken } : {}),
            });
        },
        onTask(handler) {
            taskHandler = handler;
        },
        sendTelemetry(metrics) {
            send('telemetry', metrics);
        },
        sendEvent(eventType, data) {
            send('event', { eventType, ...data });
        },
        connected() {
            return isConnected;
        },
        deviceId,
    };
}
