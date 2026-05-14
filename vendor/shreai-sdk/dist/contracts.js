import { createLogger } from './logger.js';
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
function validateContract(contract) {
    const errors = [];
    if (!contract.blockId || !SNAKE_CASE_RE.test(contract.blockId)) {
        errors.push(`blockId must be non-empty snake_case, got "${contract.blockId}"`);
    }
    if (!contract.version || !SEMVER_RE.test(contract.version)) {
        errors.push(`version must be valid semver, got "${contract.version}"`);
    }
    if (!Array.isArray(contract.owns)) {
        errors.push('owns must be an array');
    }
    if (!Array.isArray(contract.reads)) {
        errors.push('reads must be an array');
    }
    if (!Array.isArray(contract.emits)) {
        errors.push('emits must be an array');
    }
    if (Array.isArray(contract.owns) && Array.isArray(contract.reads)) {
        const readsSet = new Set(contract.reads);
        const missing = contract.owns.filter((k) => !readsSet.has(k));
        if (missing.length > 0) {
            errors.push(`owns keys not in reads: ${missing.join(', ')}`);
        }
    }
    if (typeof contract.maxTtlS !== 'number' || contract.maxTtlS <= 0) {
        errors.push(`maxTtlS must be > 0, got ${contract.maxTtlS}`);
    }
    if (typeof contract.priority !== 'number' || contract.priority < 1 || contract.priority > 10) {
        errors.push(`priority must be 1–10, got ${contract.priority}`);
    }
    if (typeof contract.maxRetries !== 'number' || contract.maxRetries < 0) {
        errors.push(`maxRetries must be >= 0, got ${contract.maxRetries}`);
    }
    if (typeof contract.idempotent !== 'boolean') {
        errors.push('idempotent must be a boolean');
    }
    if (contract.idempotent === false && typeof contract.rollback !== 'function') {
        errors.push('non-idempotent blocks must provide a rollback function');
    }
    if (contract.tenantScope !== 'single' && contract.tenantScope !== 'cross') {
        errors.push(`tenantScope must be "single" or "cross", got "${contract.tenantScope}"`);
    }
    return errors;
}
function detectCollisions(contracts) {
    const collisions = [];
    for (let i = 0; i < contracts.length; i++) {
        const a = contracts[i];
        const ownsA = new Set(a.owns);
        for (let j = i + 1; j < contracts.length; j++) {
            const b = contracts[j];
            const conflicting = b.owns.filter((k) => ownsA.has(k));
            if (conflicting.length > 0) {
                collisions.push({
                    blockIdA: a.blockId,
                    blockIdB: b.blockId,
                    conflictingKeys: conflicting,
                });
            }
        }
    }
    return collisions;
}
function detectCycles(contracts) {
    const ownerOf = new Map();
    for (const c of contracts) {
        for (const key of c.owns) {
            ownerOf.set(key, c.blockId);
        }
    }
    const blockIdArr = contracts.map((c) => c.blockId);
    const blockIds = new Set(blockIdArr);
    const adj = new Map();
    const inDegree = new Map();
    for (const id of blockIdArr) {
        adj.set(id, new Set());
        inDegree.set(id, 0);
    }
    for (const c of contracts) {
        for (const key of c.reads) {
            const owner = ownerOf.get(key);
            if (owner && owner !== c.blockId) {
                const ownerAdj = adj.get(owner);
                if (ownerAdj && !ownerAdj.has(c.blockId)) {
                    ownerAdj.add(c.blockId);
                    inDegree.set(c.blockId, (inDegree.get(c.blockId) ?? 0) + 1);
                }
            }
        }
    }
    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
        if (deg === 0)
            queue.push(id);
    }
    const sorted = [];
    while (queue.length > 0) {
        const node = queue.shift();
        sorted.push(node);
        const neighbors = adj.get(node);
        if (neighbors) {
            for (const neighbor of neighbors) {
                const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
                inDegree.set(neighbor, newDeg);
                if (newDeg === 0)
                    queue.push(neighbor);
            }
        }
    }
    if (sorted.length === blockIds.size)
        return [];
    const sortedSet = new Set(sorted);
    const cycleNodes = blockIdArr.filter((id) => !sortedSet.has(id));
    return traceCycles(cycleNodes, adj);
}
function traceCycles(cycleNodes, adj) {
    const cycles = [];
    const cycleSet = new Set(cycleNodes);
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const n of cycleNodes)
        color.set(n, WHITE);
    const parent = new Map();
    for (const start of cycleNodes) {
        if (color.get(start) !== WHITE)
            continue;
        const stack = [start];
        parent.set(start, null);
        while (stack.length > 0) {
            const node = stack[stack.length - 1];
            if (color.get(node) === WHITE) {
                color.set(node, GRAY);
                const neighbors = adj.get(node);
                if (neighbors) {
                    for (const neighbor of neighbors) {
                        if (!cycleSet.has(neighbor))
                            continue;
                        if (color.get(neighbor) === WHITE) {
                            parent.set(neighbor, node);
                            stack.push(neighbor);
                        }
                        else if (color.get(neighbor) === GRAY) {
                            const cycle = [neighbor];
                            let cur = node;
                            while (cur != null && cur !== neighbor) {
                                cycle.push(cur);
                                cur = parent.get(cur);
                            }
                            cycle.reverse();
                            cycles.push(cycle);
                        }
                    }
                }
            }
            else {
                color.set(node, BLACK);
                stack.pop();
            }
        }
    }
    return cycles.length > 0 ? cycles : [cycleNodes];
}
function computeWaves(contracts) {
    if (contracts.length === 0)
        return [];
    const ownerOf = new Map();
    for (const c of contracts) {
        for (const key of c.owns) {
            ownerOf.set(key, c.blockId);
        }
    }
    const blockIds = contracts.map((c) => c.blockId);
    const adj = new Map();
    const inDegree = new Map();
    for (const id of blockIds) {
        adj.set(id, new Set());
        inDegree.set(id, 0);
    }
    for (const c of contracts) {
        for (const key of c.reads) {
            const owner = ownerOf.get(key);
            if (owner && owner !== c.blockId) {
                const ownerAdj = adj.get(owner);
                if (ownerAdj && !ownerAdj.has(c.blockId)) {
                    ownerAdj.add(c.blockId);
                    inDegree.set(c.blockId, (inDegree.get(c.blockId) ?? 0) + 1);
                }
            }
        }
    }
    const waves = [];
    let currentWave = blockIds.filter((id) => inDegree.get(id) === 0);
    const priorityMap = new Map(contracts.map((c) => [c.blockId, c.priority]));
    while (currentWave.length > 0) {
        currentWave.sort((a, b) => (priorityMap.get(b) ?? 0) - (priorityMap.get(a) ?? 0));
        waves.push([...currentWave]);
        const nextWave = [];
        for (const node of currentWave) {
            const neighbors = adj.get(node);
            if (neighbors) {
                for (const neighbor of neighbors) {
                    const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
                    inDegree.set(neighbor, newDeg);
                    if (newDeg === 0)
                        nextWave.push(neighbor);
                }
            }
        }
        currentWave = nextWave;
    }
    const placed = new Set(waves.flat());
    const remaining = blockIds.filter((id) => !placed.has(id));
    if (remaining.length > 0) {
        remaining.sort((a, b) => (priorityMap.get(b) ?? 0) - (priorityMap.get(a) ?? 0));
        waves.push(remaining);
    }
    return waves;
}
export function createBlockRegistry(serviceName, opts) {
    const log = opts?.logger ?? createLogger(`${serviceName}:contracts`);
    const rejectOnCollision = opts?.rejectOnCollision ?? true;
    const rejectOnCycle = opts?.rejectOnCycle ?? true;
    const contracts = new Map();
    let cachedCollisionCount = 0;
    function allContracts() {
        return Array.from(contracts.values());
    }
    function runAnalysis() {
        const all = allContracts();
        const collisions = detectCollisions(all);
        const cycles = detectCycles(all);
        const waves = computeWaves(all);
        return {
            collisions,
            waves,
            cycles,
            isClean: collisions.length === 0 && cycles.length === 0,
        };
    }
    const registry = {
        register(contract) {
            const errors = validateContract(contract);
            if (errors.length > 0) {
                const msg = `Invalid contract "${contract.blockId}": ${errors.join('; ')}`;
                log.error(msg);
                throw new Error(msg);
            }
            if (contracts.has(contract.blockId)) {
                const msg = `Duplicate blockId: "${contract.blockId}" is already registered`;
                log.error(msg);
                throw new Error(msg);
            }
            contracts.set(contract.blockId, Object.freeze({ ...contract }));
            const report = runAnalysis();
            if (rejectOnCollision && report.collisions.length > 0) {
                const involving = report.collisions.filter((c) => c.blockIdA === contract.blockId || c.blockIdB === contract.blockId);
                if (involving.length > 0) {
                    contracts.delete(contract.blockId);
                    const desc = involving
                        .map((c) => `${c.blockIdA} <-> ${c.blockIdB} on [${c.conflictingKeys.join(', ')}]`)
                        .join('; ');
                    const msg = `Collision detected, rejecting "${contract.blockId}": ${desc}`;
                    log.error(msg);
                    throw new Error(msg);
                }
            }
            if (rejectOnCycle && report.cycles.length > 0) {
                const involving = report.cycles.filter((cycle) => cycle.includes(contract.blockId));
                if (involving.length > 0) {
                    contracts.delete(contract.blockId);
                    const desc = involving.map((c) => c.join(' -> ')).join('; ');
                    const msg = `Dependency cycle detected, rejecting "${contract.blockId}": ${desc}`;
                    log.error(msg);
                    throw new Error(msg);
                }
            }
            cachedCollisionCount = report.collisions.length;
            log.info('Block registered', {
                blockId: contract.blockId,
                version: contract.version,
                owns: contract.owns.length,
                reads: contract.reads.length,
                emits: contract.emits.length,
                priority: contract.priority,
            });
        },
        unregister(blockId) {
            const existed = contracts.delete(blockId);
            if (existed) {
                cachedCollisionCount = detectCollisions(allContracts()).length;
                log.info('Block unregistered', { blockId });
            }
            return existed;
        },
        getContract(blockId) {
            return contracts.get(blockId);
        },
        listBlockIds() {
            return Array.from(contracts.keys());
        },
        analyze() {
            return runAnalysis();
        },
        get collisionCount() {
            return cachedCollisionCount;
        },
    };
    return registry;
}
function flattenKeys(obj, prefix = '') {
    const result = new Map();
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const [nestedKey, nestedVal] of flattenKeys(value, fullKey)) {
                result.set(nestedKey, nestedVal);
            }
        }
        else {
            result.set(fullKey, value);
        }
    }
    return result;
}
function isOwnedKey(key, owns) {
    for (const ownedKey of owns) {
        if (key === ownedKey)
            return true;
        if (ownedKey.endsWith('.*')) {
            const globPrefix = ownedKey.slice(0, -2);
            if (key === globPrefix || key.startsWith(globPrefix + '.'))
                return true;
        }
        if (key.startsWith(ownedKey + '.'))
            return true;
    }
    return false;
}
export function createStateMutationAuditor(serviceName, opts) {
    const log = opts?.logger ?? createLogger(`${serviceName}:mutation-auditor`);
    const throwOnViolation = opts?.throwOnViolation ?? false;
    return {
        validate(contract, tenantId, before, after) {
            const flatBefore = flattenKeys(before);
            const flatAfter = flattenKeys(after);
            const allKeys = new Set([...flatBefore.keys(), ...flatAfter.keys()]);
            const changedKeys = [];
            for (const key of allKeys) {
                const bVal = flatBefore.get(key);
                const aVal = flatAfter.get(key);
                if (bVal !== aVal) {
                    if (typeof bVal === 'object' &&
                        typeof aVal === 'object' &&
                        bVal !== null &&
                        aVal !== null) {
                        try {
                            if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
                                changedKeys.push(key);
                            }
                        }
                        catch (err) {
                            changedKeys.push(key);
                        }
                    }
                    else {
                        changedKeys.push(key);
                    }
                }
            }
            const violations = changedKeys.filter((k) => !isOwnedKey(k, contract.owns));
            const audit = {
                blockId: contract.blockId,
                tenantId,
                allowed: violations.length === 0,
                attemptedKeys: changedKeys,
                ownedKeys: [...contract.owns],
                violations,
                timestamp: new Date().toISOString(),
            };
            if (violations.length > 0) {
                log.warn('State mutation violation', {
                    blockId: contract.blockId,
                    tenantId,
                    violations,
                    attemptedKeys: changedKeys,
                });
                if (throwOnViolation) {
                    throw new Error(`State mutation violation in block "${contract.blockId}": ` +
                        `keys [${violations.join(', ')}] are not in declared owns ` +
                        `[${contract.owns.join(', ')}]`);
                }
            }
            else {
                log.debug('State mutation audit passed', {
                    blockId: contract.blockId,
                    tenantId,
                    changedKeys,
                });
            }
            return audit;
        },
    };
}
