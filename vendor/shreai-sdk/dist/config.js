import { readFileSync, watchFile, unwatchFile, existsSync } from 'node:fs';
import { createLogger } from './logger.js';
import { getShrePath } from './paths.js';
const CONFIG_PATH = getShrePath('model-config.json');
const POLL_INTERVAL_MS = 2_000;
let _config = null;
let _watching = false;
const _listeners = [];
const _log = createLogger('shre-config');
export function loadConfig(path) {
    if (_config)
        return _config;
    const configPath = path ?? CONFIG_PATH;
    try {
        const raw = readFileSync(configPath, 'utf-8');
        _config = JSON.parse(raw);
        return _config;
    }
    catch (err) {
        _log.error('Failed to load model-config.json', { path: configPath }, err);
        throw new Error(`Cannot load config: ${configPath}`);
    }
}
export function reloadConfig(path) {
    _config = null;
    const cfg = loadConfig(path);
    for (const listener of _listeners) {
        try {
            listener(cfg);
        }
        catch (err) {
            _log.error('Config reload listener error', {}, err);
        }
    }
    return cfg;
}
export function startWatching() {
    if (_watching)
        return;
    const configPath = CONFIG_PATH;
    if (!existsSync(configPath)) {
        _log.warn('Config file not found — watching disabled', { path: configPath });
        return;
    }
    watchFile(configPath, { interval: POLL_INTERVAL_MS }, () => {
        try {
            reloadConfig(configPath);
            _log.info('Config hot-reloaded');
        }
        catch (err) {
            _log.warn('Config hot-reload failed — using cached', {}, err);
        }
    });
    process.on('SIGHUP', () => {
        try {
            reloadConfig(configPath);
            _log.info('Config reloaded via SIGHUP');
        }
        catch (err) {
            _log.debug('Config SIGHUP reload failed, keeping cached', { error: err.message });
        }
    });
    _watching = true;
}
export function stopWatching() {
    if (!_watching)
        return;
    unwatchFile(CONFIG_PATH);
    _watching = false;
}
export function onReload(fn) {
    _listeners.push(fn);
    return () => {
        const idx = _listeners.indexOf(fn);
        if (idx >= 0)
            _listeners.splice(idx, 1);
    };
}
export function resolveRole(role) {
    const cfg = loadConfig();
    const modelId = cfg.roles[role];
    if (!modelId)
        throw new Error(`Unknown role: "${role}"`);
    return modelId;
}
export function resolveGate(gateKey) {
    const cfg = loadConfig();
    const gate = cfg.gates[gateKey] ?? cfg.gates['default'];
    if (!gate)
        throw new Error(`Unknown gate: "${gateKey}"`);
    return {
        primary: cfg.roles[gate.primary] ?? gate.primary,
        fallback: cfg.roles[gate.fallback] ?? gate.fallback,
    };
}
export function getAgentModel(agentId) {
    const cfg = loadConfig();
    const override = cfg.agents.overrides[agentId];
    return override?.model ?? cfg.agents.defaults.model;
}
export function getModel(modelId) {
    const cfg = loadConfig();
    return cfg.catalog[modelId];
}
export function getModelPricing(modelId) {
    const model = getModel(modelId);
    if (!model)
        return { inputPer1M: 0, outputPer1M: 0, local: false };
    return { ...model.pricing, local: model.local };
}
export function estimateCost(modelId, promptTokens, completionTokens) {
    const pricing = getModelPricing(modelId);
    if (pricing.local)
        return 0;
    return ((promptTokens / 1_000_000) * pricing.inputPer1M +
        (completionTokens / 1_000_000) * pricing.outputPer1M);
}
export function matchByExpertise(domain, minScore = 50) {
    const cfg = loadConfig();
    const results = [];
    for (const [modelId, model] of Object.entries(cfg.catalog)) {
        const score = model.expertise?.[domain] ?? 0;
        if (score >= minScore) {
            results.push({ modelId, model, score });
        }
    }
    return results.sort((a, b) => b.score - a.score);
}
export function cheapestExpert(domain, minScore = 50) {
    const matches = matchByExpertise(domain, minScore);
    if (matches.length === 0)
        return null;
    const sorted = [...matches].sort((a, b) => {
        if (a.model.local && !b.model.local)
            return -1;
        if (!a.model.local && b.model.local)
            return 1;
        const costA = a.model.pricing.inputPer1M + a.model.pricing.outputPer1M;
        const costB = b.model.pricing.inputPer1M + b.model.pricing.outputPer1M;
        return costA - costB;
    });
    return sorted[0]?.modelId ?? null;
}
export function getFallbackChain() {
    const cfg = loadConfig();
    return cfg.defaultFallbackChain;
}
