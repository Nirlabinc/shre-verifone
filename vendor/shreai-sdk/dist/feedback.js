import { createCortexClient } from './cortex.js';
import { createEventBus } from './events.js';
import { createLogger } from './logger.js';
export function createFeedbackPipeline(config) {
    const log = createLogger(`feedback:${config.agentId}`);
    const cortex = createCortexClient(`feedback:${config.agentId}`, { url: config.cortexUrl });
    const bus = createEventBus(`feedback:${config.agentId}`);
    const buffer = [];
    const BATCH_SIZE = config.batchSize || 10;
    const INTERVAL = config.reportingIntervalMs || 30_000;
    let flushTimer = null;
    async function report(type, data) {
        const report = {
            agentId: config.agentId,
            workspaceId: config.workspaceId,
            type,
            data,
            timestamp: new Date().toISOString(),
            upstream: { shre: true, aros: true, ellie: true, mib: true },
        };
        buffer.push(report);
        try {
            await bus.publish(`feedback.${type}`, 'info', {
                agentId: config.agentId,
                workspace: config.workspaceId,
                type,
                data,
            });
        }
        catch (e) {
            log.warn('Event bus publish failed, buffered for batch', { error: e.message });
        }
        if (buffer.length >= BATCH_SIZE) {
            await flush();
        }
    }
    async function flush() {
        if (buffer.length === 0)
            return;
        const batch = buffer.splice(0, buffer.length);
        try {
            await cortex.writeBatch(batch.map((r) => ({
                dataType: 'agent_feedback',
                payload: {
                    agent_id: r.agentId,
                    workspace_id: r.workspaceId,
                    report_type: r.type,
                    data: r.data,
                    reported_at: r.timestamp,
                },
            })));
            log.info(`Flushed ${batch.length} reports to CortexDB`, {
                agentId: config.agentId,
                types: [...new Set(batch.map((r) => r.type))],
            });
        }
        catch (e) {
            buffer.unshift(...batch);
            log.error('Flush failed, re-buffered', { error: e.message, count: batch.length });
        }
    }
    function reportSkillExecution(skillId, result) {
        return report('skill_execution', { skillId, ...result });
    }
    function reportKnowledgeLearned(topic, insight, source) {
        return report('knowledge_learned', { topic, insight, source });
    }
    function reportMemoryUpdate(memoryType, key, action) {
        return report('memory_updated', { memoryType, key, action });
    }
    function reportTaskComplete(taskId, result) {
        return report('task_completed', { taskId, ...result });
    }
    function reportHealth(status, details) {
        return report('agent_health', { status, ...details });
    }
    function reportSkillGap(skillId, gapType, severity) {
        return report('skill_gap', { skillId, gapType, severity });
    }
    function start() {
        flushTimer = setInterval(() => flush(), INTERVAL);
        log.info('Feedback pipeline started', { agentId: config.agentId, intervalMs: INTERVAL });
    }
    function stop() {
        if (flushTimer)
            clearInterval(flushTimer);
        return flush();
    }
    return {
        report,
        flush,
        start,
        stop,
        reportSkillExecution,
        reportKnowledgeLearned,
        reportMemoryUpdate,
        reportTaskComplete,
        reportHealth,
        reportSkillGap,
        bufferSize: () => buffer.length,
    };
}
