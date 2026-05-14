export async function postToFeed(bus, post) {
    await bus.publish('feed.post', post.severity ?? 'info', {
        agentId: post.agentId,
        agentEmoji: post.agentEmoji,
        agentName: post.agentName,
        category: post.category,
        severity: post.severity ?? 'info',
        title: post.title,
        body: post.body,
        data: post.data ?? {},
        skillId: post.skillId,
        storeId: post.storeId,
        storeName: post.storeName,
        tenantId: post.tenantId,
        nodeApp: post.nodeApp,
        toolName: post.toolName,
        workspaceId: post.workspaceId,
        tags: post.tags ?? [],
        parentId: post.parentId,
        expiresAt: post.expiresAt,
    });
}
export async function audit(bus, entryType, payload, actor) {
    await bus.publish(`audit.${entryType}`, 'info', {
        entryType,
        payload,
        actor: actor ?? 'system',
        auditTimestamp: new Date().toISOString(),
    });
}
