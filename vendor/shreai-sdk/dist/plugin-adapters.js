export function registerNode(registry, node) {
    const manifest = {
        id: node.id,
        type: 'node',
        version: '1.0.0',
        name: node.name,
        description: node.description,
        provides: [`node:${node.id}`],
        metadata: {
            category: node.category,
            authType: node.authType,
            provisioning: node.provisioning,
            ...node.metadata,
        },
    };
    registry.register(manifest);
}
export function registerTool(registry, tool) {
    const requires = (tool.requiredNodes ?? []).map((n) => `node:${n}`);
    const optional = (tool.optionalNodes ?? []).map((n) => `node:${n}`);
    const manifest = {
        id: tool.id,
        type: 'tool',
        version: '1.0.0',
        name: tool.name,
        description: tool.description,
        requires,
        optional,
        provides: [`tool:${tool.id}`],
        metadata: {
            appId: tool.appId,
            category: tool.category,
            skillKey: tool.skillKey,
            minSkillLevel: tool.minSkillLevel,
            mutating: tool.mutating,
            ...tool.metadata,
        },
    };
    registry.register(manifest);
}
export function registerApp(registry, app) {
    const requires = [
        ...(app.tools ?? []).map((t) => `tool:${t}`),
        ...(app.requiredNodes ?? []).map((n) => `node:${n}`),
    ];
    const manifest = {
        id: app.id,
        type: 'app',
        version: '1.0.0',
        name: app.name,
        description: app.description,
        requires,
        provides: [`app:${app.id}`],
        metadata: app.metadata,
    };
    registry.register(manifest);
}
export function registerPipe(registry, pipe) {
    const manifest = {
        id: pipe.id,
        type: 'pipe',
        version: '1.0.0',
        name: pipe.name,
        requires: [`node:${pipe.sourceNode}`, `node:${pipe.targetNode}`],
        provides: [`pipe:${pipe.id}`],
        metadata: {
            direction: pipe.direction,
            schedule: pipe.schedule,
            ...pipe.metadata,
        },
    };
    registry.register(manifest);
}
export function registerBlockContract(registry, block) {
    const manifest = {
        id: block.blockId,
        type: 'agent-block',
        version: block.version ?? '1.0.0',
        owns: block.owns,
        reads: block.reads,
        emits: block.emits,
        provides: [`block:${block.blockId}`],
        metadata: {
            tenantScope: block.tenantScope,
            priority: block.priority,
            ...block.metadata,
        },
    };
    registry.register(manifest);
}
export function registerAgent(registry, agent) {
    const requires = (agent.tools ?? []).map((t) => `tool:${t}`);
    const manifest = {
        id: agent.id,
        type: 'agent',
        version: '1.0.0',
        name: agent.name,
        requires,
        provides: [`agent:${agent.id}`],
        trust: agent.tier ? { minTier: agent.tier } : undefined,
        metadata: {
            tier: agent.tier,
            skills: agent.skills,
            ...agent.metadata,
        },
    };
    registry.register(manifest);
}
export function registerAll(registry, items) {
    for (const node of items.nodes ?? [])
        registerNode(registry, node);
    for (const tool of items.tools ?? [])
        registerTool(registry, tool);
    for (const app of items.apps ?? [])
        registerApp(registry, app);
    for (const pipe of items.pipes ?? [])
        registerPipe(registry, pipe);
    for (const block of items.blocks ?? [])
        registerBlockContract(registry, block);
    for (const agent of items.agents ?? [])
        registerAgent(registry, agent);
}
