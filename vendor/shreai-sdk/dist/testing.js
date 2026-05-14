export { TEST_LAYERS } from './testing-types.js';
export { INJECTION_CORPUS, UNSAFE_PATTERNS, checkSafetyViolations, checkTenantIsolation, FAULT_SCENARIOS, createFaultInjector, } from './testing-adversarial.js';
export function validateContract(contract) {
    const errors = [];
    const warnings = [];
    if (!contract.id || typeof contract.id !== 'string') {
        errors.push('id must be a non-empty string');
    }
    if (!contract.name || typeof contract.name !== 'string') {
        errors.push('name must be a non-empty string');
    }
    if (!Array.isArray(contract.owns) || contract.owns.length === 0) {
        errors.push('owns must be a non-empty array — every block must own at least one state key');
    }
    if (!Array.isArray(contract.tools) || contract.tools.length === 0) {
        errors.push('tools must be a non-empty array — every block must declare at least one tool');
    }
    if (!Array.isArray(contract.reads)) {
        errors.push('reads must be an array');
    }
    const ownsDupes = findDuplicates(contract.owns ?? []);
    if (ownsDupes.length > 0) {
        errors.push(`duplicate entries in owns: ${ownsDupes.join(', ')}`);
    }
    const readsDupes = findDuplicates(contract.reads ?? []);
    if (readsDupes.length > 0) {
        errors.push(`duplicate entries in reads: ${readsDupes.join(', ')}`);
    }
    const toolsDupes = findDuplicates(contract.tools ?? []);
    if (toolsDupes.length > 0) {
        errors.push(`duplicate entries in tools: ${toolsDupes.join(', ')}`);
    }
    const ownsSet = new Set(contract.owns ?? []);
    const overlap = (contract.reads ?? []).filter((r) => ownsSet.has(r));
    if (overlap.length > 0) {
        warnings.push(`reads overlaps with owns (self-read): ${overlap.join(', ')}`);
    }
    if (!contract.hasRollback && (contract.owns ?? []).length > 0) {
        warnings.push('block owns state keys but has no rollback — consider adding one');
    }
    return { valid: errors.length === 0, errors, warnings };
}
export function computeCollisionMatrix(contracts) {
    const ownershipMap = {};
    for (const c of contracts) {
        for (const key of c.owns) {
            if (!ownershipMap[key])
                ownershipMap[key] = [];
            ownershipMap[key].push(c.id);
        }
    }
    const collisions = [];
    for (const [key, owners] of Object.entries(ownershipMap)) {
        if (!owners || owners.length < 2)
            continue;
        for (let i = 0; i < owners.length; i++) {
            for (let j = i + 1; j < owners.length; j++) {
                collisions.push({ key, blockA: owners[i], blockB: owners[j] });
            }
        }
    }
    return { hasCollisions: collisions.length > 0, collisions, ownershipMap };
}
export function detectCycles(deps) {
    const nodes = new Set();
    const adj = new Map();
    const inDegree = new Map();
    for (const { from, to } of deps) {
        nodes.add(from);
        nodes.add(to);
        if (!adj.has(from))
            adj.set(from, []);
        adj.get(from).push(to);
        inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
        if (!inDegree.has(from))
            inDegree.set(from, 0);
    }
    const queue = [];
    for (const node of Array.from(nodes)) {
        if ((inDegree.get(node) ?? 0) === 0)
            queue.push(node);
    }
    const sorted = [];
    while (queue.length > 0) {
        const node = queue.shift();
        sorted.push(node);
        for (const neighbor of adj.get(node) ?? []) {
            const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
            inDegree.set(neighbor, newDeg);
            if (newDeg === 0)
                queue.push(neighbor);
        }
    }
    if (sorted.length === nodes.size)
        return null;
    const sortedSet = new Set(sorted);
    const cycleNodes = Array.from(nodes).filter((n) => !sortedSet.has(n));
    const cycles = [];
    const visited = new Set();
    for (const start of cycleNodes) {
        if (visited.has(start))
            continue;
        const path = [];
        const pathSet = new Set();
        const stack = [{ node: start, neighborIdx: 0 }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const { node } = frame;
            if (!pathSet.has(node)) {
                path.push(node);
                pathSet.add(node);
            }
            const neighbors = (adj.get(node) ?? []).filter((n) => cycleNodes.includes(n));
            if (frame.neighborIdx >= neighbors.length) {
                stack.pop();
                path.pop();
                pathSet.delete(node);
                continue;
            }
            const next = neighbors[frame.neighborIdx];
            frame.neighborIdx++;
            if (pathSet.has(next)) {
                const cycleStart = path.indexOf(next);
                const cycle = path.slice(cycleStart);
                const key = Array.from(cycle).sort().join(',');
                if (!cycles.some((c) => Array.from(c).sort().join(',') === key)) {
                    cycles.push(cycle);
                }
                for (const n of cycle)
                    visited.add(n);
            }
            else if (!visited.has(next)) {
                stack.push({ node: next, neighborIdx: 0 });
            }
        }
    }
    return cycles.length > 0 ? cycles : null;
}
export function computeWaves(contracts, deps) {
    const ids = new Set(contracts.map((c) => c.id));
    const adj = new Map();
    const inDegree = new Map();
    for (const id of Array.from(ids)) {
        adj.set(id, []);
        inDegree.set(id, 0);
    }
    for (const { from, to } of deps) {
        if (!ids.has(from) || !ids.has(to))
            continue;
        adj.get(to).push(from);
        inDegree.set(from, (inDegree.get(from) ?? 0) + 1);
    }
    const waves = [];
    const remaining = new Set(ids);
    while (remaining.size > 0) {
        const wave = Array.from(remaining).filter((id) => (inDegree.get(id) ?? 0) === 0);
        if (wave.length === 0) {
            waves.push(Array.from(remaining));
            break;
        }
        waves.push(wave.sort());
        for (const id of wave) {
            remaining.delete(id);
            for (const dependent of adj.get(id) ?? []) {
                if (remaining.has(dependent)) {
                    inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
                }
            }
        }
    }
    return waves;
}
export function validateRollbacks(contracts) {
    return contracts.map((c) => {
        const ownsKeys = c.owns.length > 0;
        const missingRollback = ownsKeys && !c.hasRollback;
        return {
            blockId: c.id,
            hasRollback: c.hasRollback,
            ownsKeys,
            missingRollback,
            warning: missingRollback
                ? `Block "${c.id}" owns ${c.owns.length} state key(s) but has no rollback implementation`
                : null,
        };
    });
}
export function aggregateNRuns(runs) {
    if (runs.length === 0) {
        return {
            runs: 0,
            consistentToolCalls: true,
            confidenceRange: [0, 0],
            tierConsistent: true,
            allPassed: false,
        };
    }
    const firstToolSeq = JSON.stringify(runs[0].toolCalls);
    const consistentToolCalls = runs.every((r) => JSON.stringify(r.toolCalls) === firstToolSeq);
    const confidences = runs.map((r) => r.confidence);
    const confidenceRange = [Math.min(...confidences), Math.max(...confidences)];
    const firstTier = runs[0].tier;
    const tierConsistent = runs.every((r) => r.tier === firstTier);
    return {
        runs: runs.length,
        consistentToolCalls,
        confidenceRange,
        tierConsistent,
        allPassed: consistentToolCalls && tierConsistent,
    };
}
export function diffStateMutation(before, after, owns) {
    const ownsSet = new Set(owns);
    const beforeKeys = new Set(Object.keys(before));
    const afterKeys = new Set(Object.keys(after));
    const changedKeys = [];
    const addedKeys = [];
    const removedKeys = [];
    const violations = [];
    for (const key of Array.from(afterKeys)) {
        if (!beforeKeys.has(key)) {
            addedKeys.push(key);
            if (!ownsSet.has(key))
                violations.push(key);
        }
        else if (!deepEqual(before[key], after[key])) {
            changedKeys.push(key);
            if (!ownsSet.has(key))
                violations.push(key);
        }
    }
    for (const key of Array.from(beforeKeys)) {
        if (!afterKeys.has(key)) {
            removedKeys.push(key);
            if (!ownsSet.has(key))
                violations.push(key);
        }
    }
    return {
        changedKeys: changedKeys.sort(),
        addedKeys: addedKeys.sort(),
        removedKeys: removedKeys.sort(),
        violations: violations.sort(),
    };
}
export function validateToolCalls(calls, expectations) {
    const matches = [];
    const matchedCallIndices = new Set();
    const matchedExpectationIndices = new Set();
    for (let ei = 0; ei < expectations.length; ei++) {
        const exp = expectations[ei];
        let bestMatch = null;
        for (let ci = 0; ci < calls.length; ci++) {
            if (matchedCallIndices.has(ci))
                continue;
            const call = calls[ci];
            if (call.name !== exp.toolName)
                continue;
            const paramKeys = new Set(Object.keys(call.params));
            const missingParams = (exp.requiredParams ?? []).filter((p) => !paramKeys.has(p));
            const forbiddenParamsFound = (exp.forbiddenParams ?? []).filter((p) => paramKeys.has(p));
            const matched = missingParams.length === 0 && forbiddenParamsFound.length === 0;
            bestMatch = { toolName: exp.toolName, matched, missingParams, forbiddenParamsFound };
            if (matched) {
                matchedCallIndices.add(ci);
                matchedExpectationIndices.add(ei);
                break;
            }
        }
        matches.push(bestMatch ?? {
            toolName: exp.toolName,
            matched: false,
            missingParams: exp.requiredParams ?? [],
            forbiddenParamsFound: [],
        });
    }
    const unexpectedCalls = calls.filter((_, i) => !matchedCallIndices.has(i)).map((c) => c.name);
    const unmatchedExpectations = expectations
        .filter((_, i) => !matchedExpectationIndices.has(i))
        .map((e) => e.toolName);
    return {
        valid: matches.every((m) => m.matched) && unmatchedExpectations.length === 0,
        matches,
        unexpectedCalls,
        unmatchedExpectations,
    };
}
export function createRubric(name, criteria) {
    return { name, criteria };
}
export function validateRubricWeights(rubric) {
    const sum = rubric.criteria.reduce((acc, c) => acc + c.weight, 0);
    return Math.abs(sum - 1.0) < 0.001;
}
export function computeRubricScore(rubric, scores) {
    let total = 0;
    for (const criterion of rubric.criteria) {
        const score = scores[criterion.name];
        if (score === undefined)
            return null;
        total += score * criterion.weight;
    }
    return total;
}
export function checkRubricThresholds(rubric, scores) {
    const failures = [];
    for (const criterion of rubric.criteria) {
        const score = scores[criterion.name];
        if (score === undefined || score < criterion.minScore) {
            failures.push(criterion.name);
        }
    }
    return failures;
}
export const HALLUCINATION_PROBES = [
    {
        name: 'fabricated-url',
        pattern: /https?:\/\/(?!(?:localhost|127\.0\.0\.1|example\.com))[a-z0-9.-]+\.(?:com|org|net|io|dev)\/[a-z0-9/_-]{40,}/gi,
        description: 'Suspiciously specific URL that may be fabricated — verify against source context',
    },
    {
        name: 'fabricated-api-key',
        pattern: /(?:sk|pk|api[_-]?key|token)[_-][a-zA-Z0-9]{20,}/g,
        description: 'String resembling an API key — agent should never generate credentials',
    },
    {
        name: 'fabricated-version',
        pattern: /(?:version|v)\s*(?:\d+\.){2}\d+(?:-(?:alpha|beta|rc)\.\d+)?/gi,
        description: 'Specific version number that may be hallucinated — verify against actual releases',
    },
    {
        name: 'fabricated-statistic',
        pattern: /\b(?:approximately|about|roughly|around|nearly)\s+\d{2,}(?:\.\d+)?%/gi,
        description: 'Hedged statistic that may be fabricated — agent should cite sources for numeric claims',
    },
    {
        name: 'confident-nonexistent-feature',
        pattern: /(?:built-in|native|out-of-the-box)\s+(?:support|integration|module|feature)\s+for\s+\w+/gi,
        description: 'Claim of built-in functionality that may not exist — verify against actual capabilities',
    },
];
export function probeForHallucinations(output, context) {
    const findings = [];
    const contextLower = context.toLowerCase();
    for (const probe of HALLUCINATION_PROBES) {
        probe.pattern.lastIndex = 0;
        let match;
        while ((match = probe.pattern.exec(output)) !== null) {
            const matchText = match[0];
            if (!contextLower.includes(matchText.toLowerCase())) {
                findings.push({
                    probe: probe.name,
                    match: matchText,
                    index: match.index,
                    description: probe.description,
                });
            }
        }
    }
    return findings;
}
function findDuplicates(arr) {
    const seen = new Set();
    const dupes = new Set();
    for (const item of arr) {
        if (seen.has(item))
            dupes.add(item);
        seen.add(item);
    }
    return Array.from(dupes);
}
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
        return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
