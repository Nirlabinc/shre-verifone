import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
const noop = async () => { };
const noopSub = () => { };
function makeMessage(from, to, type, payload, priority = 'normal', correlationId) {
    return {
        id: randomUUID(),
        from,
        to,
        type,
        priority,
        payload,
        correlationId,
        timestamp: new Date().toISOString(),
    };
}
export function createCollaborationBus(serviceName, options) {
    const { agentId, publishFn = noop, subscribeFn = noopSub, intentTtlMs = 5 * 60_000 } = options;
    const log = options.logger ?? createLogger(`shre-sdk/collab:${serviceName}`);
    const fileIntents = new Map();
    const pendingReplies = new Map();
    const capabilityRequests = new Map();
    const activeAgents = new Map();
    const messageHandlers = [];
    const capabilityHandlers = [];
    const activityHandlers = [];
    const helpHandlers = [];
    subscribeFn(`agent.message.${agentId}`, (data) => {
        const msg = data;
        log.debug('Message received', { from: msg.from, type: msg.type, id: msg.id });
        if (msg.type === 'reply' && msg.correlationId && pendingReplies.has(msg.correlationId)) {
            const pending = pendingReplies.get(msg.correlationId);
            clearTimeout(pending.timer);
            pendingReplies.delete(msg.correlationId);
            pending.resolve(msg);
            return;
        }
        for (const handler of messageHandlers) {
            try {
                handler(msg);
            }
            catch (err) {
                log.error('Message handler error', {}, err);
            }
        }
    });
    subscribeFn('capability.requested', (data) => {
        const req = data;
        capabilityRequests.set(req.id, req);
        for (const handler of capabilityHandlers) {
            try {
                handler(req);
            }
            catch (err) {
                log.error('Capability handler error', {}, err);
            }
        }
    });
    subscribeFn('capability.fulfilled', (data) => {
        const { requestId, toolName, fulfilledBy } = data;
        const req = capabilityRequests.get(requestId);
        if (req) {
            req.status = 'fulfilled';
            req.toolName = toolName;
            req.fulfilledBy = fulfilledBy;
        }
    });
    subscribeFn('agent.activity', (data) => {
        const activity = data;
        activeAgents.set(activity.agentId, activity);
        for (const handler of activityHandlers) {
            try {
                handler(activity);
            }
            catch (err) {
                log.error('Activity handler error', {}, err);
            }
        }
    });
    subscribeFn(`agent.help.${agentId}`, (data) => {
        const msg = data;
        for (const handler of helpHandlers) {
            try {
                handler(msg);
            }
            catch (err) {
                log.error('Help handler error', {}, err);
            }
        }
    });
    function pruneExpiredIntents() {
        const now = Date.now();
        for (const [key, intent] of fileIntents) {
            if (now > new Date(intent.expiresAt).getTime())
                fileIntents.delete(key);
        }
    }
    const bus = {
        async send(to, type, payload, priority = 'normal') {
            const msg = makeMessage(agentId, to, type, payload, priority);
            log.debug('Sending message', { to, type, id: msg.id });
            await publishFn(`agent.message.${to}`, 'info', msg);
        },
        async request(to, payload, timeoutMs = 30_000) {
            const msg = makeMessage(agentId, to, 'request', payload, 'normal');
            msg.correlationId = msg.id;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pendingReplies.delete(msg.id);
                    reject(new Error(`Request to ${to} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                pendingReplies.set(msg.id, { resolve, timer });
                publishFn(`agent.message.${to}`, 'info', msg).catch((err) => {
                    clearTimeout(timer);
                    pendingReplies.delete(msg.id);
                    reject(err);
                });
            });
        },
        onMessage(handler) {
            messageHandlers.push(handler);
        },
        declareIntent(declareAgentId, files, taskId) {
            pruneExpiredIntents();
            const now = new Date();
            const intent = {
                agentId: declareAgentId,
                files,
                taskId,
                declaredAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + intentTtlMs).toISOString(),
            };
            fileIntents.set(declareAgentId, intent);
            log.debug('Intent declared', { agent: declareAgentId, files: files.length });
            const conflicts = bus.checkConflicts(declareAgentId, files);
            for (const conflict of conflicts) {
                const overlapping = files.filter((f) => conflict.files.includes(f));
                publishFn(`agent.message.${declareAgentId}`, 'warn', makeMessage('collaboration-bus', declareAgentId, 'conflict-warning', {
                    conflictingAgent: conflict.agentId,
                    overlappingFiles: overlapping,
                    taskId: conflict.taskId,
                }, 'high')).catch(() => { });
            }
        },
        checkConflicts(checkAgentId, files) {
            pruneExpiredIntents();
            const conflicts = [];
            for (const [intentAgent, intent] of fileIntents) {
                if (intentAgent === checkAgentId)
                    continue;
                if (files.some((f) => intent.files.includes(f)))
                    conflicts.push(intent);
            }
            return conflicts;
        },
        clearIntent(clearAgentId) {
            fileIntents.delete(clearAgentId);
            log.debug('Intent cleared', { agent: clearAgentId });
        },
        async requestCapability(reqAgentId, description, urgency = 'medium') {
            const req = {
                id: randomUUID(),
                agentId: reqAgentId,
                description,
                urgency,
                status: 'pending',
                requestedAt: new Date().toISOString(),
            };
            capabilityRequests.set(req.id, req);
            log.info('Capability requested', { id: req.id, agent: reqAgentId, urgency });
            await publishFn('capability.requested', 'info', req);
            return req.id;
        },
        onCapabilityRequest(handler) {
            capabilityHandlers.push(handler);
        },
        fulfillCapability(requestId, toolName, fulfilledBy) {
            const req = capabilityRequests.get(requestId);
            if (!req) {
                log.warn('Capability request not found', { requestId });
                return;
            }
            req.status = 'fulfilled';
            req.toolName = toolName;
            req.fulfilledBy = fulfilledBy;
            log.info('Capability fulfilled', { requestId, toolName, fulfilledBy });
            publishFn('capability.fulfilled', 'info', { requestId, toolName, fulfilledBy }).catch(() => { });
        },
        announceActivity(actAgentId, taskId, description) {
            const now = new Date().toISOString();
            const existing = activeAgents.get(actAgentId);
            const activity = {
                agentId: actAgentId,
                taskId,
                description,
                startedAt: existing?.startedAt ?? now,
                lastPingAt: now,
            };
            activeAgents.set(actAgentId, activity);
            publishFn('agent.activity', 'info', activity).catch(() => { });
        },
        getActiveAgents() {
            return new Map(activeAgents);
        },
        onAgentActivity(handler) {
            activityHandlers.push(handler);
        },
        async requestHelp(from, to, description, context) {
            const msg = makeMessage(from, to, 'help', { description, context: context ?? {} }, 'high');
            log.info('Help requested', { from, to, description: description.slice(0, 80) });
            await publishFn(`agent.help.${to}`, 'warn', msg);
        },
        onHelpRequest(handler) {
            helpHandlers.push(handler);
        },
    };
    log.info('Collaboration bus created', { service: serviceName, agent: agentId });
    return bus;
}
function inferProperties(description) {
    const lower = description.toLowerCase();
    const properties = {};
    const required = [];
    if (lower.includes('query') || lower.includes('search')) {
        properties.query = { type: 'string' };
        required.push('query');
    }
    if (lower.includes('service') || lower.includes('name')) {
        properties.name = { type: 'string' };
        required.push('name');
    }
    if (lower.includes('data') || lower.includes('list')) {
        properties.limit = { type: 'number' };
    }
    if (lower.includes('id')) {
        properties.id = { type: 'string' };
        required.push('id');
    }
    return { properties, required };
}
function generateExecutor(toolName, description, properties) {
    const inputType = Object.keys(properties).length > 0
        ? `{ ${Object.entries(properties)
            .map(([k, v]) => `${k}?: ${v.type}`)
            .join('; ')} }`
        : 'Record<string, unknown>';
    return [
        `/**`,
        ` * Auto-scaffolded tool: ${toolName}`,
        ` * ${description}`,
        ` *`,
        ` * @generated — review before deploying`,
        ` */`,
        ``,
        `export default async (input: ${inputType}) => {`,
        `  return { content: 'Not yet implemented', is_error: true };`,
        `};`,
        ``,
    ].join('\n');
}
export function createCapabilityScaffolder(options) {
    const { toolsDir } = options;
    const log = options.logger ?? createLogger('shre-sdk/capability-scaffolder');
    const publishFn = options.publishFn ?? noop;
    const scaffolded = new Map();
    const scaffolder = {
        scaffold(description, toolName) {
            const { properties, required } = inferProperties(description);
            const definition = {
                name: toolName,
                description,
                input_schema: { type: 'object', properties, required },
            };
            const executor = generateExecutor(toolName, description, properties);
            const filePath = `${toolsDir}/${toolName}.ts`;
            scaffolded.set(toolName, {
                toolName,
                description,
                scaffoldedAt: new Date().toISOString(),
                status: 'draft',
                definition,
                executor,
                filePath,
            });
            log.info('Tool scaffolded', {
                toolName,
                filePath,
                propertyCount: Object.keys(properties).length,
            });
            publishFn('capability.scaffolded', 'info', { toolName, description, filePath }).catch(() => { });
            return { definition, executor, filePath };
        },
        getScaffolded() {
            return Array.from(scaffolded.values()).map(({ toolName, description, scaffoldedAt, status }) => ({
                toolName,
                description,
                scaffoldedAt,
                status,
            }));
        },
        updateStatus(toolName, status) {
            const entry = scaffolded.get(toolName);
            if (!entry) {
                log.warn('Scaffolded tool not found', { toolName });
                return;
            }
            entry.status = status;
            log.info('Scaffolded tool status updated', { toolName, status });
            publishFn('capability.scaffold.status', 'info', { toolName, status }).catch(() => { });
        },
    };
    log.info('Capability scaffolder created', { toolsDir });
    return scaffolder;
}
