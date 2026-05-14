import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
export function createIdentityResolver(config = {}) {
    const log = config.logger ?? createLogger('identity');
    const brainDir = config.brainDir ?? join(homedir(), '.shre', 'brain', 'soul');
    const legacyDir = config.legacyDir ?? join(homedir(), '.shre', 'workspace');
    const cacheTtl = config.cacheTtlMs ?? 300_000;
    const contextUrl = config.contextServiceUrl ?? 'http://127.0.0.1:5462';
    let vault = null;
    let cache = null;
    function loadFile(path) {
        try {
            if (existsSync(path))
                return readFileSync(path, 'utf8').trim();
        }
        catch (err) {
        }
        return '';
    }
    function resolveFile(filename) {
        const brainPath = join(brainDir, filename);
        if (existsSync(brainPath))
            return loadFile(brainPath);
        return loadFile(join(legacyDir, filename));
    }
    function loadSoulContent() {
        if (vault) {
            return [vault.soul, vault.identity, vault.agents, vault.policy]
                .filter(Boolean)
                .join('\n\n---\n\n');
        }
        const soul = resolveFile('SOUL.md');
        const identity = resolveFile('IDENTITY.md');
        const user = resolveFile('USER.md');
        const memory = resolveFile('MEMORY.md');
        const parts = [soul, identity, user, memory].filter(Boolean);
        return parts.join('\n\n---\n\n');
    }
    function getSoulContext() {
        const now = Date.now();
        if (cache && now - cache.loadedAt < cacheTtl)
            return cache.content;
        const content = loadSoulContent();
        cache = { content, loadedAt: now };
        return content;
    }
    function injectSoul(systemPrompt) {
        const soul = getSoulContext();
        if (!soul)
            return systemPrompt ?? '';
        if (!systemPrompt)
            return soul;
        return `${soul}\n\n---\n\n${systemPrompt}`;
    }
    async function resolveForAgent(agentId, tenantId) {
        try {
            const params = new URLSearchParams({ agentId });
            if (tenantId)
                params.set('tenantId', tenantId);
            const resp = await fetch(`${contextUrl}/v1/context/soul?${params}`, {
                signal: AbortSignal.timeout(5000),
            });
            if (resp.ok) {
                const data = (await resp.json());
                return data.soul ?? getSoulContext();
            }
        }
        catch (err) {
            log.warn('[identity] Failed to resolve agent soul via shre-context, using local', {
                agentId,
                error: err.message,
            });
        }
        return getSoulContext();
    }
    function getMode() {
        if (vault)
            return 'vault';
        if (existsSync(join(brainDir, 'SOUL.md')))
            return 'training';
        return 'legacy';
    }
    function setVault(ctx) {
        vault = ctx;
        cache = null;
        log.info('[identity] Vault context set');
    }
    function invalidate() {
        cache = null;
    }
    return { getSoulContext, injectSoul, resolveForAgent, getMode, setVault, invalidate };
}
