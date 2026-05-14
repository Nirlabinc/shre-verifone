import { type Logger } from './logger.js';
import type { ShreEvent, EventSeverity } from './types.js';
import { type LamportClock } from './lamport-clock.js';
export type EventPriority = 'critical' | 'normal' | 'background';
export declare const SHRE_STREAM = "shre:stream";
export declare const EventTypes: {
    readonly TASK_COMPLETE: "task.complete";
    readonly TASK_DEGRADED: "fleet.task.degraded";
    readonly EVALUATION_COMPLETE: "evaluation.complete";
    readonly EVALUATION_STARTED: "evaluation.started";
    readonly EVALUATION_PROGRESS: "evaluation.progress";
    readonly SKILL_UPDATED: "skill.updated";
    readonly SKILL_GAP_DETECTED: "skill.gap_detected";
    readonly SKILL_DECAYED: "skill.decayed";
    readonly COST_RECORDED: "cost.recorded";
    readonly BUDGET_WARNING: "budget.warning";
    readonly BUDGET_EXCEEDED: "budget.exceeded";
    readonly FINETUNE_COMPLETE: "finetune.complete";
    readonly SERVICE_STARTED: "service.started";
    readonly SERVICE_STOPPING: "service.stopping";
    readonly SERVICE_HEALTH: "service.health";
    readonly FLEET_AGENT_CRASH: "fleet.agent.crash_unrecoverable";
    readonly FEED_POST: "feed.post";
    readonly AUDIT_AGENT_SPAWN: "audit.agent.spawn";
    readonly AUDIT_AGENT_DELEGATE: "audit.agent.delegate";
    readonly AUDIT_SKILL_EXECUTE: "audit.skill.execute";
    readonly AUDIT_CONFIG_CHANGE: "audit.config.change";
    readonly AUDIT_AUTH_EVENT: "audit.auth.event";
    readonly AUDIT_WRITE_OP: "audit.write.operation";
    readonly AUDIT_SYSTEM: "audit.system";
    readonly DEGRADATION_DETECTED: "degradation.detected";
    readonly REGISTRY_TENANT_SYNCED: "registry.tenant.synced";
    readonly REGISTRY_APP_ENABLED: "registry.app.enabled";
    readonly REGISTRY_APP_DISABLED: "registry.app.disabled";
    readonly REGISTRY_AGENT_ASSIGNED: "registry.agent.assigned";
    readonly REGISTRY_AGENT_UNASSIGNED: "registry.agent.unassigned";
    readonly REGISTRY_AGENT_DEACTIVATED: "registry.agent.deactivated";
    readonly REGISTRY_SOURCE_ADDED: "registry.source.added";
    readonly REGISTRY_SOURCE_REMOVED: "registry.source.removed";
    readonly REGISTRY_USER_ADDED: "registry.user.added";
    readonly BILLING_STOPPED: "billing.stopped";
    readonly BILLING_RESUMED: "billing.resumed";
    readonly NODE_SCHEMA_PROVISIONED: "node.schema_provisioned";
    readonly BLOCK_MINED: "block.mined";
    readonly BLOCK_REJECTED: "block.rejected";
    readonly MINING_REWARD: "mining.reward";
    readonly SALE_COMPLETED: "sale.completed";
    readonly SALE_VOIDED: "sale.voided";
    readonly SALE_REFUNDED: "sale.refunded";
    readonly TRANSACTION_RECORDED: "transaction.recorded";
    readonly INVENTORY_UPDATED: "inventory.updated";
    readonly INVENTORY_LOW_STOCK: "inventory.low_stock";
    readonly INVENTORY_RECEIVED: "inventory.received";
    readonly ORDER_RECEIVED: "order.received";
    readonly ORDER_CONFIRMED: "order.confirmed";
    readonly ORDER_FAILED: "order.failed";
    readonly ORDER_COMPLETED: "order.completed";
    readonly DATA_SYNC_STARTED: "data.sync.started";
    readonly DATA_SYNC_COMPLETED: "data.sync.completed";
    readonly DATA_SYNC_FAILED: "data.sync.failed";
    readonly DATA_CLEANING_COMPLETED: "data.cleaning.completed";
    readonly PIPE_EXECUTION_COMPLETED: "pipe.execution.completed";
    readonly PIPE_EXECUTION_FAILED: "pipe.execution.failed";
    readonly WEBHOOK_RECEIVED: "webhook.received";
    readonly PREDICTION_GENERATED: "prediction.generated";
    readonly PREDICTION_ALERT: "prediction.alert";
    readonly CODE_COMMITTED: "code.committed";
    readonly DEPLOY_COMPLETED: "deploy.completed";
    readonly LOOP_COMPLETE: "loop.complete";
    readonly LOOP_FAILED: "loop.failed";
    readonly LOOP_SLOW: "loop.slow";
    readonly ERROR_OCCURRED: "error.occurred";
    readonly ERROR_RESOLVED: "error.resolved";
    readonly ERROR_ESCALATED: "error.escalated";
    readonly CRON_JOB_FIRED: "cron.job.fired";
    readonly CRON_JOB_COMPLETED: "cron.job.completed";
    readonly CRON_JOB_FAILED: "cron.job.failed";
    readonly AUTOMATION_RULE_FIRED: "automation.rule.fired";
    readonly AUTOMATION_RULE_COMPLETED: "automation.rule.completed";
    readonly AUTOMATION_RULE_FAILED: "automation.rule.failed";
    readonly AUTOMATION_ESCALATED: "automation.escalated";
    readonly AUTOMATION_ESCALATION_RESOLVED: "automation.escalation.resolved";
    readonly AUTOMATION_ESCALATION_MAXED: "automation.escalation.maxed";
    readonly AUTOMATION_GATEWAY_ERROR: "automation.gateway.error";
    readonly PUSH_SENT: "push.notification.sent";
    readonly PUSH_FAILED: "push.notification.failed";
    readonly DEVICE_REGISTERED: "device.registered";
    readonly DEVICE_UNREGISTERED: "device.unregistered";
    readonly SERVICE_DOWN: "service.down";
    readonly SERVICE_CRITICAL: "service.critical";
    readonly CANCEL_OPERATIONS: "cancel.operations";
    readonly PREEMPT_TASK: "preempt.task";
};
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
export type EventHandler = (event: ShreEvent) => void | Promise<void>;
export type CancellationCallback = (reason: string, event: ShreEvent) => void | Promise<void>;
export interface CancellationToken {
    id: string;
    cancel: (reason: string) => void;
    onCancel: (cb: CancellationCallback) => void;
    isCancelled: () => boolean;
}
export interface EventSchema {
    required?: string[];
    types?: Record<string, 'string' | 'number' | 'boolean'>;
}
export declare function registerEventSchema(eventType: string, schema: EventSchema): void;
export interface EventBusOptions {
    redisHost?: string;
    redisPort?: number;
    redisPassword?: string;
    logger?: Logger;
    consumerGroup?: string;
    consumerId?: string;
    enableDedup?: boolean;
    dedupTtlSeconds?: number;
    dedupMaxSetSize?: number;
    strictValidation?: boolean;
    orderedDomains?: string[];
    orderBufferSize?: number;
    orderFlushIntervalMs?: number;
}
export interface EventBus {
    publish(type: string, severity: EventSeverity, data: Record<string, unknown>, correlationId?: string): Promise<void>;
    subscribe(typePattern: string, handler: EventHandler): () => void;
    broadcast(type: string, severity: EventSeverity, data: Record<string, unknown>): Promise<void>;
    connected(): boolean;
    bufferSize(): number;
    shutdown(): Promise<void>;
    publishPriority(type: string, severity: EventSeverity, priority: EventPriority, data: Record<string, unknown>, correlationId?: string): Promise<void>;
    createCancellationToken(correlationId: string): CancellationToken;
    cancelCorrelated(correlationId: string, reason: string): Promise<void>;
    clock(): LamportClock;
    walStats(): {
        pendingCount: number;
        lastReplayAt: string | null;
        lastReplayResult: {
            replayed: number;
            failed: number;
        };
    };
    metrics(): {
        published: number;
        delivered: number;
        dlq: number;
        dedupSkipped: number;
        bufferSize: number;
    };
}
export declare function createEventBus(serviceName: string, opts?: EventBusOptions): EventBus;
export interface LifecycleEmitter {
    started(): void;
    healthy(metrics?: Record<string, unknown>): void;
    stopping(reason?: string): void;
}
export declare function createLifecycleEmitter(bus: EventBus, serviceName: string, meta?: {
    port?: number;
    version?: string;
}): LifecycleEmitter;
