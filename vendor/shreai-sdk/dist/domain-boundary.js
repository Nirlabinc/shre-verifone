import { createLogger } from './logger.js';
const log = createLogger('shre-sdk:domain-boundary');
const DOMAIN_MAP = {
    'shre-router': ['routing', 'sessions', 'costs', 'muscle_memory', 'working_memory'],
    'shre-tasks': ['tasks', 'task_history'],
    'shre-scorer': ['scores', 'quality', 'agent_dna'],
    'shre-fleet': ['projects', 'fleet_tasks', 'changelogs'],
    'shre-rapidrms': ['rapidrms', 'pos_data', 'analytics'],
    'shre-health': ['health', 'heartbeat', 'diagnostics', 'predictions'],
    'shre-chat': ['conversations', 'chat_sessions'],
    'shre-context': ['context', 'rag', 'vectors'],
    'shre-meter': ['billing', 'usage', 'costs'],
    'shre-skills': ['skills', 'skill_history'],
    'shre-auth': ['auth', 'tokens', 'sessions'],
    'shre-registry': ['registry', 'agents'],
    'shre-chain': ['chain', 'blocks', 'knowledge'],
    'shre-monitor': ['monitor', 'alerts'],
    'shre-finetune': ['training', 'finetune', 'lora'],
};
export function validateDomainAccess(service, collection, operation) {
    if (operation === 'read')
        return true;
    const allowed = DOMAIN_MAP[service];
    if (!allowed) {
        log.warn('[domain-boundary] Unknown service in domain map', { service, collection });
        return true;
    }
    return allowed.some((d) => collection.startsWith(d));
}
export function getDomainMap() {
    return DOMAIN_MAP;
}
export function createDomainGuard(serviceName, options) {
    const strict = options?.strict ?? false;
    return {
        beforeWrite(collection, _data) {
            if (!validateDomainAccess(serviceName, collection, 'write')) {
                const msg = `Cross-domain write attempt: ${serviceName} -> ${collection}`;
                const ctx = {
                    service: serviceName,
                    collection,
                    allowedDomains: DOMAIN_MAP[serviceName],
                };
                if (strict) {
                    log.error('[domain-boundary] ' + msg, ctx);
                    throw new Error(`[domain-boundary] ${msg}`);
                }
                else {
                    log.warn('[domain-boundary] ' + msg, ctx);
                }
            }
        },
        isOwnedCollection(collection) {
            return validateDomainAccess(serviceName, collection, 'write');
        },
    };
}
