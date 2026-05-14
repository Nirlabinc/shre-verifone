import { serviceUrl } from './discovery.js';
import { createLogger } from './logger.js';
import { resolveServiceHostAsync } from './mesh.js';
export function createRouterClient(agentId, opts) {
    const log = createLogger(`${agentId}:router-client`);
    let routerUrl = opts?.routerUrl || process.env.ROUTER_URL || serviceUrl('shre-router');
    const maxRetries = opts?.maxRetries ?? 3;
    const multiNode = process.env.SHRE_MULTI_NODE === '1';
    const fallbackDisabled = opts?.ollamaFallback === false;
    const fallbackConfig = fallbackDisabled
        ? { enabled: false, host: '', port: 0, defaultModel: '', healthCacheTtlMs: 0 }
        : {
            enabled: true,
            host: '127.0.0.1',
            port: 11434,
            defaultModel: 'qwen3:8b',
            healthCacheTtlMs: 30_000,
            ...(typeof opts?.ollamaFallback === 'object' ? opts.ollamaFallback : {}),
        };
    let _ollamaHealthy = null;
    let _ollamaHealthCheckedAt = 0;
    async function checkOllamaHealth() {
        if (!fallbackConfig.enabled)
            return false;
        const now = Date.now();
        if (_ollamaHealthy !== null && now - _ollamaHealthCheckedAt < fallbackConfig.healthCacheTtlMs) {
            return _ollamaHealthy;
        }
        try {
            const res = await fetch(`http://${fallbackConfig.host}:${fallbackConfig.port}/api/tags`, {
                signal: AbortSignal.timeout(3_000),
            });
            _ollamaHealthy = res.ok;
        }
        catch {
            _ollamaHealthy = false;
        }
        _ollamaHealthCheckedAt = now;
        return _ollamaHealthy;
    }
    function resolveLocalModel(model) {
        if (!model || model === 'auto')
            return fallbackConfig.defaultModel;
        return model;
    }
    async function fallbackToOllama(messages, options) {
        const model = resolveLocalModel(options?.model);
        log.warn('[router-client] Using Ollama fallback — shre-router unavailable', { model, agentId });
        const res = await fetch(`http://${fallbackConfig.host}:${fallbackConfig.port}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages,
                stream: false,
                ...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
            }),
            signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Ollama fallback failed: ${res.status} ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        return {
            text: parseResponse(data),
            model,
            gate: 'ollama-fallback',
            raw: data,
        };
    }
    const circuit = {
        failures: 0,
        lastFailure: 0,
        open: false,
    };
    const CIRCUIT_THRESHOLD = 5;
    const CIRCUIT_RESET_MS = 30_000;
    function checkCircuit() {
        if (!circuit.open)
            return;
        if (Date.now() - circuit.lastFailure > CIRCUIT_RESET_MS) {
            circuit.open = false;
            circuit.failures = 0;
            return;
        }
        throw new Error(`shre-router circuit breaker open (${circuit.failures} failures, resets in ${Math.ceil((CIRCUIT_RESET_MS - (Date.now() - circuit.lastFailure)) / 1000)}s)`);
    }
    function recordSuccess() {
        circuit.failures = 0;
        circuit.open = false;
    }
    function recordFailure() {
        circuit.failures++;
        circuit.lastFailure = Date.now();
        if (circuit.failures >= CIRCUIT_THRESHOLD) {
            circuit.open = true;
        }
    }
    function parseResponse(data) {
        return (data?.content?.[0]?.text ||
            data?.message?.content ||
            data?.choices?.[0]?.message?.content ||
            data?.candidates?.[0]?.content?.parts?.[0]?.text ||
            '');
    }
    function backoff(attempt) {
        const ms = Math.min(1000 * Math.pow(2, attempt), 8000);
        return new Promise((r) => setTimeout(r, ms));
    }
    async function chat(input, options) {
        const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
        try {
            checkCircuit();
        }
        catch (circuitErr) {
            if (fallbackConfig.enabled && (await checkOllamaHealth())) {
                return fallbackToOllama(messages, options);
            }
            throw circuitErr;
        }
        const body = {
            model: options?.model ?? 'auto',
            stream: false,
            maxTokens: options?.maxTokens ?? 4096,
            agentId,
            messages,
            metadata: { taskType: options?.taskType ?? 'conversation' },
        };
        if (options?.budget)
            body.budget = options.budget;
        if (options?.systemPrompt)
            body.systemPrompt = options.systemPrompt;
        if (options?.tenantId)
            body.tenantId = options.tenantId;
        if (options?.tools)
            body.tools = options.tools;
        const headers = { 'Content-Type': 'application/json' };
        if (options?.tenantId)
            headers['x-tenant-id'] = options.tenantId;
        const timeoutMs = options?.timeoutMs ?? 60_000;
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                if (options?.signal) {
                    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
                }
                const res = await fetch(`${routerUrl}/v1/chat`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (!res.ok) {
                    const errText = await res.text().catch(() => '');
                    if (res.status >= 400 && res.status < 500) {
                        recordSuccess();
                        throw new Error(`shre-router ${res.status}: ${errText.slice(0, 200)}`);
                    }
                    throw new Error(`shre-router ${res.status}: ${errText.slice(0, 200)}`);
                }
                const data = await res.json();
                recordSuccess();
                return {
                    text: parseResponse(data),
                    model: data?._shre?.model || data?.model,
                    gate: data?._shre?.gate,
                    cacheHit: data?._shre?.cacheHit,
                    raw: data,
                };
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (lastError.message.includes('shre-router 4'))
                    throw lastError;
                if (lastError.name === 'AbortError' && options?.signal?.aborted)
                    throw lastError;
                recordFailure();
                if (attempt < maxRetries) {
                    if (multiNode && !opts?.routerUrl) {
                        try {
                            const altHost = await resolveServiceHostAsync('shre-router');
                            if (altHost) {
                                const port = 5497;
                                const newUrl = `http://${altHost}:${port}`;
                                if (newUrl !== routerUrl) {
                                    log.info('[router-client] Failing over to alternate router node', {
                                        from: routerUrl,
                                        to: newUrl,
                                    });
                                    routerUrl = newUrl;
                                }
                            }
                        }
                        catch {
                        }
                    }
                    await backoff(attempt);
                }
            }
        }
        if (fallbackConfig.enabled && (await checkOllamaHealth())) {
            return fallbackToOllama(messages, options);
        }
        throw lastError ?? new Error('shre-router unreachable after retries');
    }
    return { chat, parseResponse };
}
