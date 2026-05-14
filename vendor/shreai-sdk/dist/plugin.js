import { createLogger } from './logger.js';
function validateManifest(m) {
    const errors = [];
    if (!m.id || typeof m.id !== 'string')
        errors.push('id is required');
    if (!m.type || typeof m.type !== 'string')
        errors.push('type is required');
    if (!m.version || typeof m.version !== 'string')
        errors.push('version is required');
    if (m.owns && m.reads) {
        const readsSet = new Set(m.reads);
        const missing = m.owns.filter((k) => !readsSet.has(k));
        if (missing.length > 0) {
            errors.push(`owns keys not in reads: ${missing.join(', ')}`);
        }
    }
    return errors;
}
export function createPluginRegistry(config = {}) {
    const log = config.logger ?? createLogger('plugin-registry');
    const rejectOnCollision = config.rejectOnCollision ?? true;
    const plugins = new Map();
    const capabilityIndex = new Map();
    function indexCapabilities(manifest) {
        for (const cap of manifest.provides ?? []) {
            let providers = capabilityIndex.get(cap);
            if (!providers) {
                providers = new Set();
                capabilityIndex.set(cap, providers);
            }
            providers.add(manifest.id);
        }
    }
    function removeCapabilities(manifest) {
        for (const cap of manifest.provides ?? []) {
            const providers = capabilityIndex.get(cap);
            if (providers) {
                providers.delete(manifest.id);
                if (providers.size === 0)
                    capabilityIndex.delete(cap);
            }
        }
    }
    function checkOwnershipCollisions(manifest) {
        const newOwns = new Set(manifest.owns ?? []);
        if (newOwns.size === 0)
            return [];
        const collisions = [];
        for (const [id, existing] of plugins) {
            if (id === manifest.id)
                continue;
            for (const key of existing.owns ?? []) {
                if (newOwns.has(key)) {
                    collisions.push(`"${manifest.id}" and "${id}" both own "${key}"`);
                }
            }
        }
        return collisions;
    }
    function register(manifest) {
        const errors = validateManifest(manifest);
        if (errors.length > 0) {
            throw new Error(`Invalid plugin manifest "${manifest.id}": ${errors.join('; ')}`);
        }
        const collisions = checkOwnershipCollisions(manifest);
        if (collisions.length > 0) {
            const msg = `Ownership collision: ${collisions.join('; ')}`;
            if (rejectOnCollision)
                throw new Error(msg);
            log.warn(`[plugin] ${msg}`);
        }
        const existing = plugins.get(manifest.id);
        if (existing)
            removeCapabilities(existing);
        plugins.set(manifest.id, manifest);
        indexCapabilities(manifest);
        log.info('[plugin] Registered', {
            id: manifest.id,
            type: manifest.type,
            provides: manifest.provides,
        });
    }
    function unregister(id) {
        const existing = plugins.get(id);
        if (!existing)
            return false;
        removeCapabilities(existing);
        plugins.delete(id);
        return true;
    }
    function get(id) {
        return plugins.get(id);
    }
    function list() {
        return Array.from(plugins.keys());
    }
    function listByType(type) {
        return Array.from(plugins.values()).filter((p) => p.type === type);
    }
    function providers(capability) {
        const ids = capabilityIndex.get(capability);
        if (!ids)
            return [];
        return Array.from(ids)
            .map((id) => plugins.get(id))
            .filter(Boolean);
    }
    function dependents(capability) {
        return Array.from(plugins.values()).filter((p) => (p.requires ?? []).includes(capability) || (p.optional ?? []).includes(capability));
    }
    function resolve(id) {
        const plugin = plugins.get(id);
        if (!plugin)
            throw new Error(`Plugin "${id}" not registered`);
        const dependencies = [];
        const missing = [];
        const missingOptional = [];
        const visited = new Set([id]);
        function walk(manifest) {
            for (const cap of manifest.requires ?? []) {
                const providerIds = capabilityIndex.get(cap);
                if (!providerIds || providerIds.size === 0) {
                    missing.push(cap);
                    continue;
                }
                for (const pid of providerIds) {
                    if (visited.has(pid))
                        continue;
                    visited.add(pid);
                    const dep = plugins.get(pid);
                    dependencies.push(dep);
                    walk(dep);
                    break;
                }
            }
            for (const cap of manifest.optional ?? []) {
                const providerIds = capabilityIndex.get(cap);
                if (!providerIds || providerIds.size === 0) {
                    missingOptional.push(cap);
                    continue;
                }
                for (const pid of providerIds) {
                    if (visited.has(pid))
                        continue;
                    visited.add(pid);
                    const dep = plugins.get(pid);
                    dependencies.push(dep);
                    walk(dep);
                    break;
                }
            }
        }
        walk(plugin);
        return {
            plugin,
            dependencies,
            missing,
            missingOptional,
            ready: missing.length === 0,
        };
    }
    function graph() {
        const edges = [];
        const inDegree = new Map();
        const adjacency = new Map();
        for (const id of plugins.keys()) {
            inDegree.set(id, 0);
            adjacency.set(id, []);
        }
        for (const [id, manifest] of plugins) {
            for (const cap of manifest.requires ?? []) {
                const providerIds = capabilityIndex.get(cap);
                if (providerIds) {
                    for (const pid of providerIds) {
                        if (pid === id)
                            continue;
                        edges.push({ from: id, to: pid, capability: cap, optional: false });
                        adjacency.get(pid)?.push(id);
                        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
                    }
                }
            }
            for (const cap of manifest.optional ?? []) {
                const providerIds = capabilityIndex.get(cap);
                if (providerIds) {
                    for (const pid of providerIds) {
                        if (pid === id)
                            continue;
                        edges.push({ from: id, to: pid, capability: cap, optional: true });
                    }
                }
            }
        }
        const queue = [];
        for (const [id, deg] of inDegree) {
            if (deg === 0)
                queue.push(id);
        }
        const activationOrder = [];
        const visited = new Set();
        while (queue.length > 0) {
            const current = queue.shift();
            activationOrder.push(current);
            visited.add(current);
            for (const dependent of adjacency.get(current) ?? []) {
                const newDeg = (inDegree.get(dependent) ?? 1) - 1;
                inDegree.set(dependent, newDeg);
                if (newDeg === 0)
                    queue.push(dependent);
            }
        }
        const unresolved = Array.from(plugins.keys()).filter((id) => !visited.has(id));
        const roots = Array.from(plugins.keys()).filter((id) => {
            const m = plugins.get(id);
            return (m.requires ?? []).length === 0;
        });
        return { edges, roots, unresolved, activationOrder };
    }
    return {
        register,
        unregister,
        get,
        list,
        listByType,
        resolve,
        graph,
        providers,
        dependents,
        get size() {
            return plugins.size;
        },
    };
}
