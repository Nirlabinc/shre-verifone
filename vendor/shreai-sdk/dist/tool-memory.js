function exactKey(intent, domain, agentId) {
    return `exact:${intent}:${domain}:${agentId}`;
}
function domainKey(intent, domain) {
    return `domain:${intent}:${domain}`;
}
function structuralKey(intent) {
    return `structural:${intent}`;
}
export function createToolMemory(_service, opts = {}) {
    const minQuality = opts.minQuality ?? 3.5;
    const learnThreshold = opts.learnThreshold ?? 3;
    const maxPatterns = opts.maxPatterns ?? 1000;
    const patterns = [];
    const exactCounts = new Map();
    const domainCounts = new Map();
    const structuralCounts = new Map();
    function addCount(map, key, tools) {
        const toolKey = tools.sort().join(',');
        let inner = map.get(key);
        if (!inner) {
            inner = new Map();
            map.set(key, inner);
        }
        inner.set(toolKey, (inner.get(toolKey) ?? 0) + 1);
    }
    function bestMatch(map, key) {
        const inner = map.get(key);
        if (!inner || inner.size === 0)
            return null;
        let bestTools = '';
        let bestCount = 0;
        for (const [tools, count] of inner) {
            if (count > bestCount) {
                bestTools = tools;
                bestCount = count;
            }
        }
        return bestTools ? { tools: bestTools.split(','), count: bestCount } : null;
    }
    function computeSharedTools(intent) {
        const sKey = structuralKey(intent);
        const inner = structuralCounts.get(sKey);
        if (!inner)
            return [];
        const toolFreq = new Map();
        let totalSets = 0;
        for (const [toolSet, count] of inner) {
            totalSets += count;
            for (const tool of toolSet.split(',')) {
                toolFreq.set(tool, (toolFreq.get(tool) ?? 0) + count);
            }
        }
        const threshold = totalSets * 0.6;
        return [...toolFreq.entries()]
            .filter(([, freq]) => freq >= threshold)
            .map(([tool]) => tool)
            .sort();
    }
    async function learn(pattern) {
        if (pattern.quality < minQuality)
            return;
        if (pattern.toolsUsed.length === 0)
            return;
        const full = {
            ...pattern,
            shared: false,
            ts: new Date().toISOString(),
        };
        if (patterns.length >= maxPatterns)
            patterns.shift();
        patterns.push(full);
        const eKey = exactKey(pattern.intent, pattern.domain, pattern.agentId);
        const dKey = domainKey(pattern.intent, pattern.domain);
        const sKey = structuralKey(pattern.intent);
        addCount(exactCounts, eKey, pattern.toolsUsed);
        addCount(domainCounts, dKey, pattern.toolsUsed);
        addCount(structuralCounts, sKey, pattern.toolsUsed);
        const sMatch = bestMatch(structuralCounts, sKey);
        if (sMatch && sMatch.count >= learnThreshold) {
            full.shared = true;
        }
        if (opts.cortexWrite) {
            try {
                await opts.cortexWrite('tool_selection_pattern', {
                    intent: pattern.intent,
                    domain: pattern.domain,
                    tools_used: pattern.toolsUsed,
                    agent_id: pattern.agentId,
                    store_id: pattern.storeId ?? null,
                    quality: pattern.quality,
                    shared: full.shared,
                });
            }
            catch {
            }
        }
        if (opts.publishFn) {
            opts.publishFn('tool_memory.learned', 'info', {
                intent: pattern.intent,
                domain: pattern.domain,
                tools: pattern.toolsUsed,
                agentId: pattern.agentId,
                quality: pattern.quality,
                shared: full.shared,
            });
        }
    }
    function lookup(intent, domain, agentId) {
        if (agentId) {
            const eKey = exactKey(intent, domain, agentId);
            const exact = bestMatch(exactCounts, eKey);
            if (exact && exact.count >= learnThreshold) {
                return {
                    tools: exact.tools,
                    agentId,
                    confidence: exact.count,
                    source: 'exact',
                };
            }
        }
        const dKey = domainKey(intent, domain);
        const domainMatch = bestMatch(domainCounts, dKey);
        if (domainMatch && domainMatch.count >= learnThreshold) {
            const agentFreq = new Map();
            for (const p of patterns) {
                if (p.intent === intent && p.domain === domain) {
                    agentFreq.set(p.agentId, (agentFreq.get(p.agentId) ?? 0) + 1);
                }
            }
            let bestAgent;
            let bestAgentCount = 0;
            for (const [agent, count] of agentFreq) {
                if (count > bestAgentCount) {
                    bestAgent = agent;
                    bestAgentCount = count;
                }
            }
            return {
                tools: domainMatch.tools,
                agentId: bestAgent,
                confidence: domainMatch.count,
                source: 'domain',
            };
        }
        const sKey = structuralKey(intent);
        const structural = bestMatch(structuralCounts, sKey);
        if (structural && structural.count >= learnThreshold) {
            return {
                tools: structural.tools,
                confidence: structural.count,
                source: 'structural',
            };
        }
        return null;
    }
    function getSharedTools(intent) {
        return computeSharedTools(intent);
    }
    function getStats() {
        const intentCounts = new Map();
        const toolCounts = new Map();
        const agentCounts = {};
        let learned = 0;
        let shared = 0;
        for (const p of patterns) {
            intentCounts.set(p.intent, (intentCounts.get(p.intent) ?? 0) + 1);
            for (const t of p.toolsUsed) {
                toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
            }
            agentCounts[p.agentId] = (agentCounts[p.agentId] ?? 0) + 1;
            if (p.shared)
                shared++;
        }
        for (const [, inner] of exactCounts) {
            for (const [, count] of inner) {
                if (count >= learnThreshold)
                    learned++;
            }
        }
        return {
            totalPatterns: patterns.length,
            learnedPatterns: learned,
            sharedPatterns: shared,
            topIntents: [...intentCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([intent, count]) => ({ intent, count })),
            topTools: [...toolCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([tool, count]) => ({ tool, count })),
            agentCoverage: agentCounts,
        };
    }
    async function flush() {
        if (!opts.cortexWrite)
            return;
        const unsynced = patterns.filter((p) => !p.shared);
        for (const p of unsynced) {
            try {
                await opts.cortexWrite('tool_selection_pattern', {
                    intent: p.intent,
                    domain: p.domain,
                    tools_used: p.toolsUsed,
                    agent_id: p.agentId,
                    store_id: p.storeId ?? null,
                    quality: p.quality,
                    shared: p.shared,
                });
            }
            catch {
            }
        }
    }
    return { learn, lookup, getSharedTools, getStats, flush };
}
