import { createLogger } from './logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
const RIGHTS_DIR = join(process.env.HOME || '/tmp', '.shre');
const RIGHTS_FILE = join(RIGHTS_DIR, 'agent-rights.json');
const DEFAULT_RIGHTS = {
    'self-heal': true,
    'shell-exec': true,
    'file-write': true,
    'file-delete': true,
    'db-write': true,
    'db-delete': true,
    'task-create': true,
    'task-resolve': true,
    'config-change': true,
    'service-restart': true,
    'network-access': true,
    'secret-access': true,
    'agent-spawn': true,
    'budget-override': false,
    'data-export': true,
    'audit-bypass': false,
};
class AgentRightsManagerImpl {
    log;
    store;
    constructor() {
        this.log = createLogger('shre-sdk:agent-rights');
        this.store = this.loadOrCreate();
    }
    can(agentId, right) {
        const config = this.getAgentConfig(agentId);
        if (config.fullRights) {
            return right !== 'audit-bypass';
        }
        const granted = config.rights[right];
        if (granted !== undefined)
            return granted;
        const defaultGrant = this.store.defaults.rights[right];
        if (defaultGrant !== undefined)
            return defaultGrant;
        return DEFAULT_RIGHTS[right] ?? false;
    }
    grant(agentId, right, note) {
        const config = this.ensureAgentConfig(agentId);
        config.rights[right] = true;
        config.updatedAt = new Date().toISOString();
        if (note)
            config.notes = note;
        this.save();
        this.log.info('Right granted', { agentId, right, note });
    }
    deny(agentId, right, note) {
        const config = this.ensureAgentConfig(agentId);
        config.rights[right] = false;
        config.updatedAt = new Date().toISOString();
        if (note)
            config.notes = note;
        this.save();
        this.log.info('Right denied', { agentId, right, note });
    }
    setFullRights(agentId, enabled, note) {
        const config = this.ensureAgentConfig(agentId);
        config.fullRights = enabled;
        config.updatedAt = new Date().toISOString();
        if (note)
            config.notes = note;
        this.save();
        this.log.info('Full rights toggled', { agentId, enabled, note });
    }
    getRights(agentId) {
        return { ...this.getAgentConfig(agentId) };
    }
    getStore() {
        return JSON.parse(JSON.stringify(this.store));
    }
    setDefaults(defaults) {
        if (defaults.fullRights !== undefined) {
            this.store.defaults.fullRights = defaults.fullRights;
        }
        if (defaults.rights) {
            this.store.defaults.rights = { ...this.store.defaults.rights, ...defaults.rights };
        }
        this.save();
        this.log.info('Defaults updated', { defaults });
    }
    reload() {
        this.store = this.loadOrCreate();
    }
    save() {
        try {
            mkdirSync(RIGHTS_DIR, { recursive: true });
            writeFileSync(RIGHTS_FILE, JSON.stringify(this.store, null, 2));
        }
        catch (err) {
            this.log.error('Failed to save agent rights', { error: err.message });
        }
    }
    getAgentConfig(agentId) {
        return (this.store.agents[agentId] || {
            agentId,
            fullRights: this.store.defaults.fullRights,
            rights: { ...this.store.defaults.rights },
            updatedAt: new Date().toISOString(),
        });
    }
    ensureAgentConfig(agentId) {
        if (!this.store.agents[agentId]) {
            this.store.agents[agentId] = {
                agentId,
                fullRights: this.store.defaults.fullRights,
                rights: {},
                updatedAt: new Date().toISOString(),
            };
        }
        return this.store.agents[agentId];
    }
    loadOrCreate() {
        try {
            if (existsSync(RIGHTS_FILE)) {
                const raw = readFileSync(RIGHTS_FILE, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed.version && parsed.defaults && parsed.agents) {
                    return parsed;
                }
            }
        }
        catch (err) {
            this.log.warn('Failed to load agent rights, using defaults', {
                error: err.message,
            });
        }
        const store = {
            version: 1,
            defaults: {
                fullRights: true,
                rights: {},
            },
            agents: {},
        };
        try {
            mkdirSync(RIGHTS_DIR, { recursive: true });
            writeFileSync(RIGHTS_FILE, JSON.stringify(store, null, 2));
        }
        catch {
        }
        return store;
    }
}
let _instance = null;
export function createAgentRightsManager() {
    if (!_instance) {
        _instance = new AgentRightsManagerImpl();
    }
    return _instance;
}
export function resetAgentRightsManager() {
    _instance = null;
}
