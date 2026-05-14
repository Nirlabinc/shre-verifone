import { createLogger } from './logger.js';
class HealActionRunnerImpl {
    log;
    actions = new Map();
    history = [];
    cooldowns = new Map();
    hourlyBudget = [];
    maxPerHour;
    maxHistorySize;
    publishFn;
    onApprovalRequired;
    totalAttempts = 0;
    successCount = 0;
    failureCount = 0;
    escalatedCount = 0;
    constructor(serviceName, opts = {}) {
        this.log = createLogger(`${serviceName}:heal-actions`);
        this.maxPerHour = opts.maxHealsPerHour ?? 10;
        this.maxHistorySize = opts.maxHistorySize ?? 500;
        this.publishFn = opts.publishFn;
        this.onApprovalRequired = opts.onApprovalRequired;
        this.log.info('Heal action runner initialized', { maxHealsPerHour: this.maxPerHour });
    }
    register(action) {
        this.actions.set(action.id, action);
        this.log.info('Heal action registered', {
            id: action.id,
            risk: action.risk,
            autoApprove: action.autoApprove,
        });
    }
    unregister(actionId) {
        this.actions.delete(actionId);
    }
    async heal(actionId, params = {}) {
        const action = this.actions.get(actionId);
        if (!action) {
            return this.makeResult(actionId, params, {
                executed: false,
                success: false,
                verified: false,
                autoApproved: false,
                error: `Unknown heal action: ${actionId}`,
                risk: 'never',
            });
        }
        this.totalAttempts++;
        const lastExec = this.cooldowns.get(actionId) || 0;
        const cooldown = action.cooldownMs ?? 60_000;
        if (Date.now() - lastExec < cooldown) {
            return this.makeResult(actionId, params, {
                executed: false,
                success: false,
                verified: false,
                autoApproved: action.autoApprove,
                error: `Action on cooldown (${Math.ceil((cooldown - (Date.now() - lastExec)) / 1000)}s remaining)`,
                risk: action.risk,
            });
        }
        if (!this.hasBudget()) {
            return this.makeResult(actionId, params, {
                executed: false,
                success: false,
                verified: false,
                autoApproved: action.autoApprove,
                error: 'Hourly heal budget exhausted',
                risk: action.risk,
            });
        }
        if (!action.autoApprove || action.risk === 'never') {
            this.escalatedCount++;
            this.log.info('Heal action requires approval — escalating', {
                id: actionId,
                risk: action.risk,
                params,
            });
            if (this.onApprovalRequired) {
                await this.onApprovalRequired(action, params).catch((err) => {
                    this.log.warn('Approval callback failed', {
                        id: actionId,
                        error: err.message,
                    });
                });
            }
            await this.publish('heal-actions.approval-required', 'warning', {
                actionId,
                risk: action.risk,
                label: action.label,
                params,
            });
            return this.makeResult(actionId, params, {
                executed: false,
                success: false,
                verified: false,
                autoApproved: false,
                error: `Requires ${action.risk}-risk approval`,
                risk: action.risk,
            });
        }
        this.log.info('Executing heal action', { id: actionId, risk: action.risk, params });
        let success = false;
        let verified = false;
        let error;
        try {
            const timeout = action.timeoutMs ?? 30_000;
            success = await Promise.race([
                action.execute(params),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Heal action timed out')), timeout)),
            ]);
        }
        catch (err) {
            success = false;
            error = err instanceof Error ? err.message : String(err);
            this.log.error('Heal action execution failed', { id: actionId, error });
        }
        if (success) {
            try {
                await new Promise((r) => setTimeout(r, 3000));
                verified = await action.verify(params);
                if (!verified) {
                    this.log.warn('Heal action executed but verification failed', { id: actionId, params });
                    error = 'Verification failed after execution';
                }
            }
            catch (err) {
                verified = false;
                error = `Verification error: ${err instanceof Error ? err.message : String(err)}`;
                this.log.warn('Heal action verification threw', { id: actionId, error });
            }
        }
        this.cooldowns.set(actionId, Date.now());
        this.hourlyBudget.push(Date.now());
        if (success && verified)
            this.successCount++;
        else
            this.failureCount++;
        const result = this.makeResult(actionId, params, {
            executed: true,
            success: success && verified,
            verified,
            autoApproved: true,
            error,
            risk: action.risk,
        });
        await this.publish(result.success ? 'heal-actions.success' : 'heal-actions.failed', result.success ? 'info' : 'warning', {
            actionId,
            risk: action.risk,
            success: result.success,
            verified,
            durationMs: result.durationMs,
            params,
            error,
        });
        return result;
    }
    findActions(tag) {
        const results = [];
        for (const action of this.actions.values()) {
            if (action.matchTags?.some((t) => tag.startsWith(t) || tag === t)) {
                results.push(action);
            }
        }
        return results;
    }
    async autoHeal(tag, params = {}) {
        const actions = this.findActions(tag);
        if (actions.length === 0)
            return null;
        const autoAction = actions.find((a) => a.autoApprove) ?? actions[0];
        if (!autoAction)
            return null;
        return this.heal(autoAction.id, params);
    }
    getHistory(limit = 50) {
        return this.history.slice(-limit);
    }
    getActions() {
        return Array.from(this.actions.values());
    }
    getBudget() {
        this.pruneHourlyBudget();
        return {
            used: this.hourlyBudget.length,
            remaining: Math.max(0, this.maxPerHour - this.hourlyBudget.length),
            max: this.maxPerHour,
        };
    }
    stats() {
        return {
            totalAttempts: this.totalAttempts,
            successCount: this.successCount,
            failureCount: this.failureCount,
            escalatedCount: this.escalatedCount,
            registeredActions: this.actions.size,
        };
    }
    makeResult(actionId, params, data) {
        const result = {
            actionId,
            params,
            durationMs: data.durationMs ?? 0,
            completedAt: new Date().toISOString(),
            ...data,
        };
        this.history.push(result);
        if (this.history.length > this.maxHistorySize) {
            this.history.splice(0, this.history.length - this.maxHistorySize);
        }
        return result;
    }
    hasBudget() {
        this.pruneHourlyBudget();
        return this.hourlyBudget.length < this.maxPerHour;
    }
    pruneHourlyBudget() {
        const cutoff = Date.now() - 3_600_000;
        while (this.hourlyBudget.length > 0 && this.hourlyBudget[0] < cutoff) {
            this.hourlyBudget.shift();
        }
    }
    async publish(event, severity, data) {
        if (this.publishFn) {
            await this.publishFn(event, severity, data).catch((err) => {
                this.log.warn('Failed to publish heal event', { event, error: err.message });
            });
        }
    }
}
export function createHealActionRunner(serviceName, opts) {
    return new HealActionRunnerImpl(serviceName, opts);
}
export function createBuiltinHealActions(platform) {
    const { execSync: exec, fetch: fetchFn, portsJson } = platform;
    const getPort = (svc) => {
        const services = portsJson.services || {};
        return services[svc]?.port || 0;
    };
    return [
        {
            id: 'restart-service',
            label: 'Restart Service via LaunchAgent',
            risk: 'low',
            autoApprove: true,
            description: 'Restarts a service using launchctl kickstart. Safe — launchd manages the lifecycle.',
            matchTags: ['svc-down-'],
            timeoutMs: 15_000,
            cooldownMs: 120_000,
            execute: async (params) => {
                const label = params.launchLabel;
                if (!label)
                    return false;
                try {
                    const uid = exec('id -u', { encoding: 'utf-8' }).trim();
                    exec(`launchctl kickstart -k gui/${uid}/${label}`, { timeout: 10_000 });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const svc = params.service;
                const port = getPort(svc);
                if (!port)
                    return false;
                try {
                    const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
                        signal: AbortSignal.timeout(5_000),
                    });
                    return res.ok;
                }
                catch {
                    try {
                        const res = await fetchFn(`https://127.0.0.1:${port}/health`, {
                            signal: AbortSignal.timeout(5_000),
                        });
                        return res.ok;
                    }
                    catch {
                        return false;
                    }
                }
            },
        },
        {
            id: 'remount-nas',
            label: 'Remount NAS Volume',
            risk: 'low',
            autoApprove: true,
            description: 'Force-unmounts and remounts a stale NAS volume. Safe — only affects file mounts.',
            matchTags: ['nas-readonly-', 'nas-dangling-', 'nas-missing-'],
            timeoutMs: 30_000,
            cooldownMs: 300_000,
            execute: async (params) => {
                const mount = params.mountPath;
                const smbUrl = params.smbUrl;
                if (!mount || !smbUrl)
                    return false;
                try {
                    try {
                        exec(`umount -f "${mount}"`, { timeout: 10_000 });
                    }
                    catch {
                    }
                    exec(`open "${smbUrl}"`, { timeout: 15_000 });
                    await new Promise((r) => setTimeout(r, 5000));
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const mount = params.mountPath;
                try {
                    const { existsSync, writeFileSync } = await import('fs');
                    if (!existsSync(mount))
                        return false;
                    writeFileSync(`${mount}/.heal-probe`, new Date().toISOString());
                    return true;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'clear-redis-cache',
            label: 'Clear Redis Cache Namespace',
            risk: 'low',
            autoApprove: true,
            description: 'Flushes a specific Redis key pattern. Safe — cache data is regenerable.',
            matchTags: ['redis-memory-', 'cache-stale-'],
            timeoutMs: 10_000,
            cooldownMs: 300_000,
            execute: async (params) => {
                const pattern = params.pattern || '*:cache:*';
                const password = params.redisPassword || '';
                try {
                    const authFlag = password ? `-a "${password}" --no-auth-warning` : '';
                    exec(`redis-cli -p 6379 ${authFlag} --scan --pattern "${pattern}" | xargs -r redis-cli -p 6379 ${authFlag} DEL`, { timeout: 10_000, encoding: 'utf-8' });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async () => {
                try {
                    exec('redis-cli -p 6379 PING', { timeout: 5_000, encoding: 'utf-8' });
                    return true;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'rotate-spillover',
            label: 'Rotate & Truncate Cortex Spillover',
            risk: 'low',
            autoApprove: true,
            description: 'Clears the local ~/.shre/cortex-spill/<service>-pending.jsonl(.1)? files for a service whose spillover queue is growing unbounded, then kickstarts the service so it reopens the append fd cleanly. Data in the files is already lost if CortexDB has been down long enough to trigger this — the action prevents the router from dying with ENFILE and dropping in-flight requests too. Safe: only touches local .jsonl files + uses the same launchctl kickstart the OS already does via KeepAlive.',
            matchTags: ['spillover-growth', 'fd-pressure'],
            timeoutMs: 20_000,
            cooldownMs: 300_000,
            execute: async (params) => {
                const service = params.service || '';
                const launchLabel = params.launchLabel || '';
                try {
                    const { existsSync, readdirSync, unlinkSync, writeFileSync } = await import('fs');
                    const { join } = await import('path');
                    const { homedir } = await import('os');
                    const spillDir = join(homedir(), '.shre', 'cortex-spill');
                    if (!existsSync(spillDir))
                        return true;
                    const all = readdirSync(spillDir);
                    const files = service
                        ? all.filter((f) => f === `${service}-pending.jsonl` || f === `${service}-pending.jsonl.1`)
                        : all.filter((f) => f.endsWith('-pending.jsonl') || f.endsWith('-pending.jsonl.1'));
                    for (const f of files) {
                        const p = join(spillDir, f);
                        try {
                            if (f.endsWith('.1')) {
                                unlinkSync(p);
                            }
                            else {
                                writeFileSync(p, '');
                            }
                        }
                        catch {
                        }
                    }
                    if (launchLabel) {
                        try {
                            const uid = exec('id -u', { encoding: 'utf-8' }).trim();
                            exec(`launchctl kickstart -k gui/${uid}/${launchLabel}`, { timeout: 10_000 });
                        }
                        catch {
                        }
                    }
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const service = params.service || '';
                try {
                    const { existsSync, statSync } = await import('fs');
                    const { join } = await import('path');
                    const { homedir } = await import('os');
                    const spillDir = join(homedir(), '.shre', 'cortex-spill');
                    if (!existsSync(spillDir))
                        return true;
                    const main = join(spillDir, `${service}-pending.jsonl`);
                    const rotated = main + '.1';
                    const mainBytes = existsSync(main) ? statSync(main).size : 0;
                    const rotBytes = existsSync(rotated) ? statSync(rotated).size : 0;
                    return mainBytes + rotBytes < 10 * 1024 * 1024;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'kill-runaway-process',
            label: 'Kill Runaway Process',
            risk: 'low',
            autoApprove: true,
            description: 'Sends SIGTERM to a process consuming excessive CPU. Launchd will restart it.',
            matchTags: ['cpu-runaway-', 'process-hung-'],
            timeoutMs: 5_000,
            cooldownMs: 120_000,
            execute: async (params) => {
                const pid = params.pid;
                if (!pid)
                    return false;
                try {
                    exec(`kill ${pid}`, { timeout: 5_000 });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const pid = params.pid;
                try {
                    exec(`kill -0 ${pid}`, { timeout: 5_000 });
                    return false;
                }
                catch {
                    return true;
                }
            },
        },
        {
            id: 'vacuum-table',
            label: 'VACUUM FULL on Database Table',
            risk: 'medium',
            autoApprove: false,
            description: 'Runs VACUUM FULL on a specific table to reclaim disk space. Locks table during operation.',
            matchTags: ['db-table-bloat-', 'db-size-'],
            timeoutMs: 300_000,
            cooldownMs: 3_600_000,
            execute: async (params) => {
                const table = params.table;
                const schema = params.schema || 'rapidrms';
                if (!table)
                    return false;
                try {
                    exec(`docker exec cortex-relational psql -U postgres -d cortexdb -c "VACUUM FULL ${schema}.${table}"`, { timeout: 300_000, encoding: 'utf-8' });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const table = params.table;
                const schema = params.schema || 'rapidrms';
                try {
                    const result = exec(`docker exec cortex-relational psql -U postgres -d cortexdb -t -c "SELECT pg_size_pretty(pg_total_relation_size('${schema}.${table}'))"`, { timeout: 10_000, encoding: 'utf-8' });
                    return result.trim().length > 0;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'purge-stale-data',
            label: 'Purge Stale Raw Data',
            risk: 'medium',
            autoApprove: false,
            description: 'Deletes raw data older than N days from a specific table. Structured data is source of truth.',
            matchTags: ['db-table-bloat-data_', 'db-changelog-runaway'],
            timeoutMs: 120_000,
            cooldownMs: 3_600_000,
            execute: async (params) => {
                const table = params.table;
                const days = params.days || 14;
                const schema = params.schema || 'rapidrms';
                if (!table)
                    return false;
                try {
                    exec(`docker exec cortex-relational psql -U postgres -d cortexdb -c "DELETE FROM ${schema}.${table} WHERE synced_at < NOW() - INTERVAL '${days} days'"`, { timeout: 120_000, encoding: 'utf-8' });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const table = params.table;
                const schema = params.schema || 'rapidrms';
                try {
                    const result = exec(`docker exec cortex-relational psql -U postgres -d cortexdb -t -c "SELECT count(*) FROM ${schema}.${table}"`, { timeout: 10_000, encoding: 'utf-8' });
                    return parseInt(result.trim(), 10) >= 0;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'restart-docker-container',
            label: 'Restart Docker Container',
            risk: 'medium',
            autoApprove: false,
            description: 'Restarts a Docker container (CortexDB stack components). Causes brief downtime.',
            matchTags: ['docker-unhealthy-', 'cortex-'],
            timeoutMs: 60_000,
            cooldownMs: 300_000,
            execute: async (params) => {
                const container = params.container;
                if (!container)
                    return false;
                try {
                    exec(`docker restart ${container}`, { timeout: 60_000 });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const container = params.container;
                try {
                    const status = exec(`docker inspect --format='{{.State.Status}}' ${container}`, {
                        timeout: 10_000,
                        encoding: 'utf-8',
                    });
                    return status.trim() === 'running';
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'inference-cache-warm',
            label: 'Warm Inference Cache',
            risk: 'low',
            autoApprove: true,
            description: 'Pre-populates the inference cache with common queries to reduce cold-start latency. Safe — only writes to cache.',
            matchTags: ['inference-latency-', 'cache-cold-'],
            timeoutMs: 30_000,
            cooldownMs: 300_000,
            execute: async (params) => {
                const port = getPort(params.service) || 11434;
                try {
                    const res = await fetchFn(`http://127.0.0.1:${port}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: params.model || 'default',
                            prompt: 'hello',
                            stream: false,
                        }),
                        signal: AbortSignal.timeout(25_000),
                    });
                    return res.ok;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const port = getPort(params.service) || 11434;
                try {
                    const start = Date.now();
                    const res = await fetchFn(`http://127.0.0.1:${port}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: params.model || 'default',
                            prompt: 'test',
                            stream: false,
                        }),
                        signal: AbortSignal.timeout(10_000),
                    });
                    return res.ok && Date.now() - start < 5000;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'training-checkpoint-recovery',
            label: 'Recover from Last Valid Training Checkpoint',
            risk: 'low',
            autoApprove: true,
            description: 'Restores training state from the most recent valid checkpoint. Safe — only affects training state, not serving model.',
            matchTags: ['training-diverged-', 'checkpoint-corrupt-'],
            timeoutMs: 60_000,
            cooldownMs: 600_000,
            execute: async (params) => {
                const checkpointDir = params.checkpointDir ||
                    `${process.env.HOME || '/Users/aibot'}/.shre/training/checkpoints`;
                try {
                    const files = exec(`ls -t "${checkpointDir}"/*.safetensors 2>/dev/null || ls -t "${checkpointDir}"/*.pt 2>/dev/null || echo ""`, {
                        timeout: 5_000,
                        encoding: 'utf-8',
                    }).trim();
                    if (!files)
                        return false;
                    const latest = files.split('\n')[0];
                    exec(`echo "${latest}" > "${checkpointDir}/.recovery-target"`, { timeout: 5_000 });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const checkpointDir = params.checkpointDir ||
                    `${process.env.HOME || '/Users/aibot'}/.shre/training/checkpoints`;
                try {
                    const marker = exec(`cat "${checkpointDir}/.recovery-target" 2>/dev/null`, {
                        timeout: 5_000,
                        encoding: 'utf-8',
                    }).trim();
                    return marker.length > 0;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'gpu-memory-cleanup',
            label: 'Clear GPU Memory Cache',
            risk: 'low',
            autoApprove: true,
            description: 'Forces garbage collection and cache clearing on GPU processes. Safe — only releases unused memory.',
            matchTags: ['gpu-oom-', 'gpu-memory-'],
            timeoutMs: 15_000,
            cooldownMs: 120_000,
            execute: async (params) => {
                try {
                    const service = params.service;
                    if (service === 'ollama') {
                        exec('pkill -f "ollama runner" || true', { timeout: 5_000 });
                        return true;
                    }
                    const pid = params.pid;
                    if (pid) {
                        exec(`kill -USR1 ${pid} || true`, { timeout: 5_000 });
                        return true;
                    }
                    return false;
                }
                catch {
                    return false;
                }
            },
            verify: async () => {
                try {
                    const res = await fetchFn('http://127.0.0.1:11434/api/tags', {
                        signal: AbortSignal.timeout(5_000),
                    });
                    return res.ok;
                }
                catch {
                    return true;
                }
            },
        },
        {
            id: 'model-rollback',
            label: 'Rollback to Previous Model Version',
            risk: 'medium',
            autoApprove: false,
            description: 'Reverts the active model to the previous version. Requires approval because it changes inference behavior.',
            matchTags: ['model-drift-', 'model-degraded-'],
            timeoutMs: 60_000,
            cooldownMs: 3_600_000,
            execute: async (params) => {
                const model = params.model;
                const previousVersion = params.previousVersion;
                if (!model || !previousVersion)
                    return false;
                try {
                    const configPath = `${process.env.HOME || '/Users/aibot'}/.shre/models/${model}/active-version`;
                    exec(`echo "${previousVersion}" > "${configPath}"`, { timeout: 5_000 });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const model = params.model;
                const previousVersion = params.previousVersion;
                try {
                    const active = exec(`cat "${process.env.HOME || '/Users/aibot'}/.shre/models/${model}/active-version"`, {
                        timeout: 5_000,
                        encoding: 'utf-8',
                    }).trim();
                    return active === previousVersion;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'reduce-inference-batch',
            label: 'Reduce Inference Batch Size',
            risk: 'medium',
            autoApprove: false,
            description: 'Halves the inference batch size to reduce memory pressure and latency. Requires approval because it reduces throughput.',
            matchTags: ['gpu-oom-', 'inference-latency-'],
            timeoutMs: 10_000,
            cooldownMs: 1_800_000,
            execute: async (params) => {
                const service = params.service;
                const port = getPort(service);
                if (!port)
                    return false;
                try {
                    const res = await fetchFn(`http://127.0.0.1:${port}/v1/config/batch-size`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'halve' }),
                        signal: AbortSignal.timeout(5_000),
                    });
                    return res.ok;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const service = params.service;
                const port = getPort(service);
                if (!port)
                    return false;
                try {
                    const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
                        signal: AbortSignal.timeout(5_000),
                    });
                    return res.ok;
                }
                catch {
                    return false;
                }
            },
        },
        {
            id: 'truncate-table',
            label: 'Truncate Database Table',
            risk: 'high',
            autoApprove: false,
            description: 'TRUNCATES a table — all data is permanently deleted. Use only for redundant raw data tables.',
            matchTags: ['db-table-bloat-'],
            timeoutMs: 60_000,
            cooldownMs: 86_400_000,
            execute: async (params) => {
                const table = params.table;
                const schema = params.schema || 'rapidrms';
                if (!table)
                    return false;
                try {
                    exec(`docker exec cortex-relational psql -U postgres -d cortexdb -c "TRUNCATE ${schema}.${table}"`, { timeout: 60_000, encoding: 'utf-8' });
                    return true;
                }
                catch {
                    return false;
                }
            },
            verify: async (params) => {
                const table = params.table;
                const schema = params.schema || 'rapidrms';
                try {
                    const result = exec(`docker exec cortex-relational psql -U postgres -d cortexdb -t -c "SELECT count(*) FROM ${schema}.${table}"`, { timeout: 10_000, encoding: 'utf-8' });
                    return parseInt(result.trim(), 10) === 0;
                }
                catch {
                    return false;
                }
            },
        },
    ];
}
