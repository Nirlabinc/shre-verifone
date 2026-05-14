export function createTaskMemory(seed) {
    return {
        version: 1,
        tools: seed?.tools ?? [],
        pipes: seed?.pipes ?? [],
        nodes: seed?.nodes ?? [],
        agents: seed?.agents ?? [],
        storage: seed?.storage ?? [],
        notes: seed?.notes ?? [],
        updatedAt: new Date().toISOString(),
    };
}
export function parseTaskMemory(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1)
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
export function serializeTaskMemory(memory) {
    return JSON.stringify({ ...memory, updatedAt: new Date().toISOString() });
}
export function addTool(memory, tool) {
    if (memory.tools.some((t) => t.id === tool.id))
        return memory;
    return { ...memory, tools: [...memory.tools, tool], updatedAt: new Date().toISOString() };
}
export function addPipe(memory, pipe) {
    if (memory.pipes.some((p) => p.id === pipe.id))
        return memory;
    return { ...memory, pipes: [...memory.pipes, pipe], updatedAt: new Date().toISOString() };
}
export function addNode(memory, node) {
    if (memory.nodes.some((n) => n.id === node.id))
        return memory;
    return { ...memory, nodes: [...memory.nodes, node], updatedAt: new Date().toISOString() };
}
export function addAgent(memory, agent) {
    if (memory.agents.some((a) => a.id === agent.id && a.role === agent.role))
        return memory;
    return { ...memory, agents: [...memory.agents, agent], updatedAt: new Date().toISOString() };
}
export function addStorage(memory, storage) {
    if (memory.storage.some((s) => s.id === storage.id))
        return memory;
    return { ...memory, storage: [...memory.storage, storage], updatedAt: new Date().toISOString() };
}
export function addNote(memory, note) {
    return {
        ...memory,
        notes: [...(memory.notes ?? []), note],
        updatedAt: new Date().toISOString(),
    };
}
export function mergeTaskMemory(...memories) {
    const result = createTaskMemory();
    for (const mem of memories) {
        if (!mem)
            continue;
        for (const tool of mem.tools) {
            if (!result.tools.some((t) => t.id === tool.id)) {
                result.tools.push(tool);
            }
        }
        for (const pipe of mem.pipes) {
            if (!result.pipes.some((p) => p.id === pipe.id)) {
                result.pipes.push(pipe);
            }
        }
        for (const node of mem.nodes) {
            if (!result.nodes.some((n) => n.id === node.id)) {
                result.nodes.push(node);
            }
        }
        for (const agent of mem.agents) {
            if (!result.agents.some((a) => a.id === agent.id && a.role === agent.role)) {
                result.agents.push(agent);
            }
        }
        for (const storage of mem.storage) {
            if (!result.storage.some((s) => s.id === storage.id)) {
                result.storage.push(storage);
            }
        }
        if (mem.notes) {
            result.notes = [...(result.notes ?? []), ...mem.notes];
        }
    }
    result.updatedAt = new Date().toISOString();
    return result;
}
export function inheritMemory(current, predecessors) {
    const base = current ?? createTaskMemory();
    const predecessorMemories = predecessors
        .filter((p) => p.memory)
        .map((p) => {
        const mem = { ...p.memory };
        if (p.agent) {
            const agentRef = {
                id: p.agent,
                role: 'predecessor',
                contribution: `Completed task ${p.taskId}`,
            };
            if (!mem.agents.some((a) => a.id === p.agent && a.role === 'predecessor')) {
                mem.agents = [...mem.agents, agentRef];
            }
        }
        return mem;
    });
    return mergeTaskMemory(base, ...predecessorMemories);
}
export function formatMemoryBrief(memory) {
    const sections = ['## Task Memory'];
    if (memory.tools.length > 0) {
        sections.push('### Available Tools', memory.tools
            .map((t) => `- **${t.id}** (${t.type}, ${t.origin})${t.reason ? ` — ${t.reason}` : ''}`)
            .join('\n'));
    }
    if (memory.pipes.length > 0) {
        sections.push('### Data Pipes', memory.pipes.map((p) => `- **${p.id}**: ${p.from} → ${p.to} (${p.dataType})`).join('\n'));
    }
    if (memory.nodes.length > 0) {
        sections.push('### Connected Nodes', memory.nodes
            .map((n) => `- **${n.id}**: ${n.service} [${n.access}]${n.endpoint ? ` @ ${n.endpoint}` : ''}`)
            .join('\n'));
    }
    if (memory.agents.length > 0) {
        sections.push('### Agent Collaborators', memory.agents
            .map((a) => `- **${a.id}** (${a.role})${a.contribution ? ` — ${a.contribution}` : ''}`)
            .join('\n'));
    }
    if (memory.storage.length > 0) {
        sections.push('### Storage', memory.storage
            .map((s) => `- **${s.id}** (${s.type}) — ${s.dataType} [${s.access}]${s.path ? ` @ ${s.path}` : ''}`)
            .join('\n'));
    }
    if (memory.notes && memory.notes.length > 0) {
        sections.push('### Notes', memory.notes.map((n) => `- ${n}`).join('\n'));
    }
    return sections.join('\n\n');
}
function confidenceBand(score) {
    if (score >= 0.85)
        return 'very-high';
    if (score >= 0.7)
        return 'high';
    if (score >= 0.5)
        return 'medium';
    if (score >= 0.3)
        return 'low';
    return 'very-low';
}
const CONFIDENCE_WEIGHTS = {
    skillMatch: 0.3,
    completeness: 0.2,
    historicalFit: 0.25,
    availability: 0.15,
    contextQuality: 0.1,
};
export function computeConfidence(input) {
    const mem = input.memory;
    const skillMatch = Math.min(1, Math.max(0, input.skillMatch));
    const totalSlots = mem.tools.length + mem.pipes.length + mem.nodes.length + mem.storage.length;
    const plannedSlots = mem.tools.filter((t) => t.origin === 'planned').length +
        mem.pipes.length +
        mem.nodes.length +
        mem.storage.length;
    const completeness = totalSlots > 0 ? plannedSlots / totalSlots : 0;
    const historicalFit = input.historicalFit ?? 0.5;
    const availability = 1 - Math.min(1, input.loadRatio ?? 0);
    const contextQuality = input.predecessorsExpected && input.predecessorsExpected > 0
        ? (input.predecessorsInherited ?? 0) / input.predecessorsExpected
        : 1.0;
    const overall = skillMatch * CONFIDENCE_WEIGHTS.skillMatch +
        completeness * CONFIDENCE_WEIGHTS.completeness +
        historicalFit * CONFIDENCE_WEIGHTS.historicalFit +
        availability * CONFIDENCE_WEIGHTS.availability +
        contextQuality * CONFIDENCE_WEIGHTS.contextQuality;
    return {
        overall: Math.round(overall * 1000) / 1000,
        signals: {
            skillMatch: Math.round(skillMatch * 100) / 100,
            completeness: Math.round(completeness * 100) / 100,
            historicalFit: Math.round(historicalFit * 100) / 100,
            availability: Math.round(availability * 100) / 100,
            contextQuality: Math.round(contextQuality * 100) / 100,
        },
        band: confidenceBand(overall),
        computedAt: new Date().toISOString(),
    };
}
export function computeMemorySignature(memory) {
    const parts = [
        ...memory.tools.map((t) => `t:${t.id}`).sort(),
        ...memory.nodes.map((n) => `n:${n.service}`).sort(),
        ...memory.storage.map((s) => `s:${s.type}:${s.dataType}`).sort(),
        ...memory.pipes.map((p) => `p:${p.from}>${p.to}`).sort(),
    ];
    return parts.join('|') || 'empty';
}
export function computeBenchmark(agentId, memory, history) {
    const signature = computeMemorySignature(memory);
    const relevant = history.filter((h) => h.agentId === agentId &&
        (h.memorySignature === signature || signatureSimilarity(h.memorySignature, signature) > 0.5));
    const sampleSize = relevant.length;
    if (sampleSize === 0) {
        return {
            agentId,
            score: 50,
            dimensions: {
                qualityAvg: 50,
                completionRate: 50,
                speedScore: 50,
                resourceDiscovery: 50,
                contextContribution: 50,
            },
            sampleSize: 0,
            signature,
            computedAt: new Date().toISOString(),
        };
    }
    const withQuality = relevant.filter((h) => h.qualityScore != null);
    const qualityAvg = withQuality.length > 0
        ? (withQuality.reduce((sum, h) => sum + h.qualityScore, 0) / withQuality.length / 5) * 100
        : 50;
    const completed = relevant.filter((h) => h.status === 'completed' || h.status === 'done');
    const completionRate = (completed.length / sampleSize) * 100;
    const withDuration = relevant.filter((h) => h.durationMs && h.estimatedDurationMs);
    const speedScore = withDuration.length > 0
        ? Math.min(100, (withDuration.reduce((sum, h) => {
            const ratio = h.estimatedDurationMs / Math.max(h.durationMs, 1);
            return sum + Math.min(ratio, 2);
        }, 0) /
            withDuration.length) *
            50)
        : 50;
    const avgDiscovery = relevant.reduce((sum, h) => sum + h.discoveredToolCount, 0) / sampleSize;
    const resourceDiscovery = Math.min(100, avgDiscovery * 25);
    const avgInheritances = relevant.reduce((sum, h) => sum + h.downstreamInheritances, 0) / sampleSize;
    const contextContribution = Math.min(100, avgInheritances * 33);
    const BENCHMARK_WEIGHTS = {
        qualityAvg: 0.35,
        completionRate: 0.25,
        speedScore: 0.15,
        resourceDiscovery: 0.1,
        contextContribution: 0.15,
    };
    const score = Math.round(qualityAvg * BENCHMARK_WEIGHTS.qualityAvg +
        completionRate * BENCHMARK_WEIGHTS.completionRate +
        speedScore * BENCHMARK_WEIGHTS.speedScore +
        resourceDiscovery * BENCHMARK_WEIGHTS.resourceDiscovery +
        contextContribution * BENCHMARK_WEIGHTS.contextContribution);
    return {
        agentId,
        score,
        dimensions: {
            qualityAvg: Math.round(qualityAvg),
            completionRate: Math.round(completionRate),
            speedScore: Math.round(speedScore),
            resourceDiscovery: Math.round(resourceDiscovery),
            contextContribution: Math.round(contextContribution),
        },
        sampleSize,
        signature,
        computedAt: new Date().toISOString(),
    };
}
export function signatureSimilarity(a, b) {
    if (a === b)
        return 1;
    const setA = new Set(a.split('|'));
    const setB = new Set(b.split('|'));
    const intersection = [...setA].filter((x) => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
}
