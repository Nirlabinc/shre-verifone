export function createAckTracker(opts = {}) {
    const ackTimeout = opts.ackTimeoutMs ?? 30_000;
    const completionTimeout = opts.completionTimeoutMs ?? 5 * 60_000;
    const maxAckRetries = opts.maxAckRetries ?? 2;
    const maxAltAgents = opts.maxAlternativeAgents ?? 1;
    const tasks = new Map();
    let completedCount = 0;
    let failedCount = 0;
    let remediatedCount = 0;
    function assigned(taskId, agentId, assignedBy, title) {
        const now = Date.now();
        tasks.set(taskId, {
            taskId,
            agentId,
            assignedBy,
            assignedAt: now,
            lastAckAt: now,
            currentStatus: 'received',
            acks: [],
            ackRetries: 0,
            triedAgents: [agentId],
            title,
        });
        publishAck({
            taskId,
            agentId,
            assignedBy,
            status: 'received',
            timestamp: new Date(now).toISOString(),
        });
    }
    function ack(taskId, agentId, status, details) {
        const tracked = tasks.get(taskId);
        if (!tracked) {
            assigned(taskId, agentId, details?.assignedBy ?? 'unknown');
        }
        const task = tasks.get(taskId);
        const now = Date.now();
        task.lastAckAt = now;
        task.currentStatus = status;
        const ackRecord = {
            taskId,
            agentId,
            assignedBy: task.assignedBy,
            status,
            timestamp: new Date(now).toISOString(),
            ...details,
        };
        task.acks.push(ackRecord);
        publishAck(ackRecord);
        if (status === 'completed' || status === 'failed' || status === 'escalated') {
            completedCount += status === 'completed' ? 1 : 0;
            failedCount += status === 'failed' || status === 'escalated' ? 1 : 0;
            if (opts.onTerminal)
                opts.onTerminal(ackRecord);
            if ((status === 'failed' || status === 'rejected') && details?.diagnosis) {
                escalate(task, details.diagnosis).catch(() => { });
            }
            setTimeout(() => tasks.delete(taskId), 5 * 60_000);
        }
    }
    async function escalate(task, diagnosis) {
        if (diagnosis.retryable && task.ackRetries < maxAckRetries) {
            task.ackRetries++;
            task.currentStatus = 'received';
            task.lastAckAt = Date.now();
            publishAck({
                taskId: task.taskId,
                agentId: task.agentId,
                assignedBy: task.assignedBy,
                status: 'received',
                timestamp: new Date().toISOString(),
                metadata: { retry: task.ackRetries, reason: 'ack_retry' },
            });
            if (opts.publishFn) {
                opts.publishFn('task.ack.retry', 'info', {
                    taskId: task.taskId,
                    agentId: task.agentId,
                    retryCount: task.ackRetries,
                    reason: diagnosis.reason,
                });
            }
            return;
        }
        if (opts.getAlternativeAgent && task.triedAgents.length <= maxAltAgents) {
            const altAgent = opts.getAlternativeAgent(task.taskId, task.agentId);
            if (altAgent && !task.triedAgents.includes(altAgent)) {
                task.triedAgents.push(altAgent);
                task.agentId = altAgent;
                task.currentStatus = 'received';
                task.lastAckAt = Date.now();
                task.ackRetries = 0;
                publishAck({
                    taskId: task.taskId,
                    agentId: altAgent,
                    assignedBy: task.assignedBy,
                    status: 'received',
                    timestamp: new Date().toISOString(),
                    metadata: {
                        rerouted: true,
                        previousAgent: task.triedAgents[0],
                        reason: diagnosis.reason,
                    },
                });
                if (opts.publishFn) {
                    opts.publishFn('task.ack.rerouted', 'info', {
                        taskId: task.taskId,
                        fromAgent: task.triedAgents[0],
                        toAgent: altAgent,
                        reason: diagnosis.reason,
                    });
                }
                return;
            }
        }
        if (opts.createTask && opts.updateTask) {
            const remTitle = buildRemediationTitle(task, diagnosis);
            const remDesc = buildRemediationDescription(task, diagnosis);
            const remTaskId = await opts.createTask({
                title: remTitle,
                description: remDesc,
                priority: 'high',
                source: 'ack-tracker-auto',
                parent_id: task.taskId,
                tags: ['remediation', `blocked:${task.taskId}`, diagnosis.category],
            });
            if (remTaskId) {
                task.remediationTaskId = remTaskId;
                remediatedCount++;
                await opts
                    .updateTask(task.taskId, {
                    status: 'blocked',
                    depends_on: [remTaskId],
                    queue_reason: `ack_failed: waiting on remediation task ${remTaskId}`,
                })
                    .catch(() => { });
                task.currentStatus = 'blocked';
                if (opts.publishFn) {
                    opts.publishFn('task.ack.remediation_created', 'warn', {
                        originalTaskId: task.taskId,
                        remediationTaskId: remTaskId,
                        agentId: task.agentId,
                        diagnosis: diagnosis.reason,
                        category: diagnosis.category,
                        recommendation: diagnosis.recommendation,
                    });
                }
            }
        }
    }
    async function checkTimeouts() {
        const now = Date.now();
        const overdue = [];
        for (const [, task] of tasks) {
            const elapsed = now - task.lastAckAt;
            if (task.currentStatus === 'received' && elapsed > ackTimeout) {
                const diag = {
                    reason: `Agent ${task.agentId} did not acknowledge task within ${ackTimeout / 1000}s`,
                    category: 'timeout',
                    recommendation: 'Re-assign to a different agent or check agent health',
                    retryable: true,
                    retriesAttempted: task.ackRetries,
                    maxRetries: maxAckRetries,
                };
                task.currentStatus = 'failed';
                const timeoutAck = {
                    taskId: task.taskId,
                    agentId: task.agentId,
                    assignedBy: task.assignedBy,
                    status: 'failed',
                    timestamp: new Date(now).toISOString(),
                    diagnosis: diag,
                };
                task.acks.push(timeoutAck);
                overdue.push(timeoutAck);
                publishAck(timeoutAck);
                await escalate(task, diag);
            }
            if ((task.currentStatus === 'accepted' || task.currentStatus === 'in_progress') &&
                elapsed > completionTimeout) {
                const diag = {
                    reason: `Agent ${task.agentId} timed out after ${completionTimeout / 1000}s without completing`,
                    category: 'timeout',
                    recommendation: 'Check agent health, then re-queue task',
                    retryable: true,
                    retriesAttempted: task.ackRetries,
                    maxRetries: maxAckRetries,
                };
                task.currentStatus = 'failed';
                const timeoutAck = {
                    taskId: task.taskId,
                    agentId: task.agentId,
                    assignedBy: task.assignedBy,
                    status: 'failed',
                    timestamp: new Date(now).toISOString(),
                    diagnosis: diag,
                };
                task.acks.push(timeoutAck);
                overdue.push(timeoutAck);
                publishAck(timeoutAck);
                await escalate(task, diag);
            }
        }
        return overdue;
    }
    function publishAck(ackRecord) {
        if (opts.cortexWrite) {
            opts
                .cortexWrite('task_ack', {
                task_id: ackRecord.taskId,
                agent_id: ackRecord.agentId,
                assigned_by: ackRecord.assignedBy,
                status: ackRecord.status,
                plan: ackRecord.plan ?? null,
                progress: ackRecord.progress ?? null,
                phase: ackRecord.phase ?? null,
                result: ackRecord.result ?? null,
                diagnosis: ackRecord.diagnosis ? JSON.stringify(ackRecord.diagnosis) : null,
            })
                .catch(() => { });
        }
        if (opts.publishFn) {
            const severity = ackRecord.status === 'failed' || ackRecord.status === 'escalated' ? 'warn' : 'info';
            opts.publishFn(`task.ack.${ackRecord.status}`, severity, {
                taskId: ackRecord.taskId,
                agentId: ackRecord.agentId,
                assignedBy: ackRecord.assignedBy,
                status: ackRecord.status,
                plan: ackRecord.plan,
                progress: ackRecord.progress,
                phase: ackRecord.phase,
                result: ackRecord.result,
                diagnosis: ackRecord.diagnosis,
            });
        }
    }
    function getState(taskId) {
        return tasks.get(taskId);
    }
    function getOverdue() {
        const now = Date.now();
        return Array.from(tasks.values()).filter((t) => {
            if (t.currentStatus === 'completed' ||
                t.currentStatus === 'failed' ||
                t.currentStatus === 'escalated')
                return false;
            const elapsed = now - t.lastAckAt;
            if (t.currentStatus === 'received')
                return elapsed > ackTimeout;
            return elapsed > completionTimeout;
        });
    }
    function getStats() {
        const overdue = getOverdue();
        return {
            tracked: tasks.size,
            overdue: overdue.length,
            completed: completedCount,
            failed: failedCount,
            remediated: remediatedCount,
        };
    }
    return { assigned, ack, checkTimeouts, getState, getOverdue, getStats };
}
function buildRemediationTitle(task, diagnosis) {
    const prefix = {
        missing_data: 'Fix: Missing data for',
        missing_tool: 'Fix: Missing tool for',
        permission_denied: 'Fix: Permission denied for',
        timeout: 'Fix: Agent timeout on',
        quality_low: 'Fix: Quality below threshold for',
        dependency_failed: 'Fix: Dependency failure on',
        unknown: 'Fix: Unresolved failure on',
    }[diagnosis.category] ?? 'Fix:';
    return `${prefix} "${task.title ?? task.taskId}"`;
}
function buildRemediationDescription(task, diagnosis) {
    return [
        `## Remediation Task (auto-created by ACK tracker)`,
        ``,
        `**Original task:** ${task.taskId}`,
        `**Failed agent:** ${task.agentId}`,
        `**Agents tried:** ${task.triedAgents.join(', ')}`,
        `**ACK retries:** ${task.ackRetries}`,
        ``,
        `### Failure Diagnosis`,
        `- **Reason:** ${diagnosis.reason}`,
        `- **Category:** ${diagnosis.category}`,
        `- **Retryable:** ${diagnosis.retryable}`,
        diagnosis.errorDetail ? `- **Error:** ${diagnosis.errorDetail}` : '',
        ``,
        `### Recommendation`,
        diagnosis.recommendation,
        ``,
        `### Resolution Criteria`,
        `When this task completes, the original task (${task.taskId}) will automatically unblock and resume execution.`,
    ]
        .filter(Boolean)
        .join('\n');
}
