import { EventEmitter } from 'events';
export function createNodeConnector(config) {
    const emitter = new EventEmitter();
    let currentStatus = 'disconnected';
    let lastHealth = {
        status: 'disconnected',
        lastCheckedAt: null,
        latencyMs: null,
        error: null,
    };
    let healthTimer = null;
    function setStatus(next, error) {
        const prev = currentStatus;
        currentStatus = next;
        lastHealth = {
            ...lastHealth,
            status: next,
            error: error ?? null,
            lastCheckedAt: new Date().toISOString(),
        };
        if (prev !== next)
            emitter.emit('status-change', prev, next);
    }
    const connector = {
        type: 'node',
        id: config.id,
        name: config.name,
        category: config.category ?? 'custom',
        authType: config.authType ?? 'none',
        status: () => ({ ...lastHealth }),
        async test() {
            try {
                const result = await config.test();
                lastHealth = {
                    ...lastHealth,
                    lastCheckedAt: new Date().toISOString(),
                    latencyMs: result.latencyMs,
                    error: result.error ?? null,
                };
                emitter.emit('health-check', result);
                if (result.ok && currentStatus === 'error')
                    setStatus('connected');
                if (!result.ok && currentStatus === 'connected')
                    setStatus('degraded', result.error);
                return result;
            }
            catch (err) {
                const result = { ok: false, latencyMs: 0, error: err.message };
                emitter.emit('health-check', result);
                setStatus('error', err.message);
                return result;
            }
        },
        async connect(credentials) {
            setStatus('connecting');
            try {
                await config.connect(credentials);
                setStatus('connected');
                if (config.healthIntervalMs && !healthTimer) {
                    healthTimer = setInterval(() => connector.test().catch(() => { }), config.healthIntervalMs);
                }
            }
            catch (err) {
                setStatus('error', err.message);
                emitter.emit('error', err);
                throw err;
            }
        },
        async disconnect() {
            if (healthTimer) {
                clearInterval(healthTimer);
                healthTimer = null;
            }
            try {
                await config.disconnect();
                setStatus('disconnected');
            }
            catch (err) {
                setStatus('error', err.message);
                throw err;
            }
        },
        async execute(operation, input, ctx) {
            if (currentStatus !== 'connected' && currentStatus !== 'degraded') {
                throw new Error(`NodeConnector "${config.id}" is not connected (status: ${currentStatus})`);
            }
            if (!config.execute)
                throw new Error(`NodeConnector "${config.id}" does not implement execute()`);
            const start = Date.now();
            try {
                const result = await config.execute(operation, input, ctx);
                emitter.emit('execute', operation, Date.now() - start);
                return result;
            }
            catch (err) {
                emitter.emit('error', err);
                throw err;
            }
        },
        on(event, listener) {
            emitter.on(event, listener);
        },
        off(event, listener) {
            emitter.off(event, listener);
        },
    };
    return connector;
}
export function createToolConnector(config) {
    const emitter = new EventEmitter();
    let currentStatus = 'disconnected';
    let lastHealth = {
        status: 'disconnected',
        lastCheckedAt: null,
        latencyMs: null,
        error: null,
    };
    function setStatus(next, error) {
        const prev = currentStatus;
        currentStatus = next;
        lastHealth = {
            ...lastHealth,
            status: next,
            error: error ?? null,
            lastCheckedAt: new Date().toISOString(),
        };
        if (prev !== next)
            emitter.emit('status-change', prev, next);
    }
    const connector = {
        type: 'tool',
        id: config.id,
        name: config.name,
        nodeIds: config.nodeIds,
        mutating: config.mutating ?? false,
        status: () => ({ ...lastHealth }),
        validate(input) {
            if (!config.validate)
                return { valid: true };
            return config.validate(input);
        },
        async test() {
            const start = Date.now();
            try {
                setStatus('connected');
                const result = { ok: true, latencyMs: Date.now() - start };
                emitter.emit('health-check', result);
                return result;
            }
            catch (err) {
                setStatus('error', err.message);
                return { ok: false, latencyMs: Date.now() - start, error: err.message };
            }
        },
        async connect() {
            setStatus('connected');
        },
        async disconnect() {
            setStatus('disconnected');
        },
        async execute(operation, input, ctx) {
            const validation = connector.validate(input);
            if (!validation.valid) {
                throw new Error(`Tool "${config.id}" validation failed: ${validation.errors?.join(', ')}`);
            }
            const start = Date.now();
            try {
                const result = await config.execute(input, ctx);
                emitter.emit('execute', operation || config.id, Date.now() - start);
                return result;
            }
            catch (err) {
                emitter.emit('error', err);
                throw err;
            }
        },
        on(event, listener) {
            emitter.on(event, listener);
        },
        off(event, listener) {
            emitter.off(event, listener);
        },
    };
    return connector;
}
export function createAppConnector(config) {
    const emitter = new EventEmitter();
    let currentStatus = 'disconnected';
    let lastHealth = {
        status: 'disconnected',
        lastCheckedAt: null,
        latencyMs: null,
        error: null,
    };
    function setStatus(next, error) {
        const prev = currentStatus;
        currentStatus = next;
        lastHealth = {
            ...lastHealth,
            status: next,
            error: error ?? null,
            lastCheckedAt: new Date().toISOString(),
        };
        if (prev !== next)
            emitter.emit('status-change', prev, next);
    }
    const connector = {
        type: 'app',
        id: config.id,
        name: config.name,
        toolIds: config.toolIds,
        status: () => ({ ...lastHealth }),
        async test() {
            const start = Date.now();
            return { ok: currentStatus === 'connected', latencyMs: Date.now() - start };
        },
        async connect(credentials) {
            setStatus('connecting');
            try {
                if (config.initialize)
                    await config.initialize(credentials);
                setStatus('connected');
            }
            catch (err) {
                setStatus('error', err.message);
                throw err;
            }
        },
        async disconnect() {
            try {
                if (config.teardown)
                    await config.teardown();
                setStatus('disconnected');
            }
            catch (err) {
                setStatus('error', err.message);
                throw err;
            }
        },
        async execute(operation, input, _ctx) {
            if (currentStatus !== 'connected') {
                throw new Error(`AppConnector "${config.id}" is not connected (status: ${currentStatus})`);
            }
            const start = Date.now();
            if (config.onEvent)
                config.onEvent(operation, input);
            emitter.emit('execute', operation, Date.now() - start);
            return { handled: true, operation };
        },
        on(event, listener) {
            emitter.on(event, listener);
        },
        off(event, listener) {
            emitter.off(event, listener);
        },
    };
    return connector;
}
export function createPipeConnector(config) {
    const emitter = new EventEmitter();
    let currentStatus = 'disconnected';
    let lastHealth = {
        status: 'disconnected',
        lastCheckedAt: null,
        latencyMs: null,
        error: null,
    };
    function setStatus(next, error) {
        const prev = currentStatus;
        currentStatus = next;
        lastHealth = {
            ...lastHealth,
            status: next,
            error: error ?? null,
            lastCheckedAt: new Date().toISOString(),
        };
        if (prev !== next)
            emitter.emit('status-change', prev, next);
    }
    const connector = {
        type: 'pipe',
        id: config.id,
        name: config.name,
        sourceNodeId: config.sourceNodeId,
        targetNodeId: config.targetNodeId,
        direction: config.direction,
        transport: config.transport ?? 'local',
        status: () => ({ ...lastHealth }),
        async test() {
            if (config.test) {
                try {
                    const result = await config.test();
                    lastHealth = {
                        ...lastHealth,
                        lastCheckedAt: new Date().toISOString(),
                        latencyMs: result.latencyMs,
                        error: result.error ?? null,
                    };
                    emitter.emit('health-check', result);
                    return result;
                }
                catch (err) {
                    setStatus('error', err.message);
                    return { ok: false, latencyMs: 0, error: err.message };
                }
            }
            return { ok: currentStatus === 'connected', latencyMs: 0 };
        },
        async connect() {
            setStatus('connected');
        },
        async disconnect() {
            setStatus('disconnected');
        },
        async execute(operation, input, ctx) {
            if (currentStatus !== 'connected' && currentStatus !== 'degraded') {
                throw new Error(`PipeConnector "${config.id}" is not connected (status: ${currentStatus})`);
            }
            const start = Date.now();
            try {
                const data = config.transform ? await config.transform(input) : input;
                const result = await config.execute(data, ctx);
                emitter.emit('execute', operation || config.id, Date.now() - start);
                return result;
            }
            catch (err) {
                emitter.emit('error', err);
                throw err;
            }
        },
        on(event, listener) {
            emitter.on(event, listener);
        },
        off(event, listener) {
            emitter.off(event, listener);
        },
    };
    return connector;
}
export function createConnectorRegistry() {
    const connectors = new Map();
    return {
        register(connector) {
            connectors.set(connector.id, connector);
        },
        get(id) {
            return connectors.get(id);
        },
        getByType(type) {
            return Array.from(connectors.values()).filter((c) => c.type === type);
        },
        list() {
            return Array.from(connectors.values());
        },
        async testAll() {
            const results = new Map();
            await Promise.allSettled(Array.from(connectors.entries()).map(async ([id, c]) => {
                results.set(id, await c.test());
            }));
            return results;
        },
        async disconnectAll() {
            await Promise.allSettled(Array.from(connectors.values()).map((c) => c.disconnect()));
        },
    };
}
