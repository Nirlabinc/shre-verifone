import { randomUUID } from 'node:crypto';
const BUILTIN_PATTERNS = [
    {
        patternId: 'builtin-eaddrinuse',
        errorSignature: 'EADDRINUSE',
        rootCause: 'Port already in use — another process holds the port',
        fixDescription: 'Kill the conflicting process or wait for it to release the port',
        fixType: 'resource_cleanup',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-econnrefused',
        errorSignature: 'ECONNREFUSED',
        rootCause: 'Downstream service is not accepting connections',
        fixDescription: 'Check and restart the dependency service',
        fixType: 'dependency_fix',
        autoRemediable: false,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-oom',
        errorSignature: 'JavaScript heap out of memory',
        rootCause: 'Node.js out of memory — likely a memory leak or excessive data processing',
        fixDescription: 'Restart with increased --max-old-space-size or investigate memory leak',
        fixType: 'restart',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-noauth',
        errorSignature: 'NOAUTH Authentication required',
        rootCause: 'Redis connection missing authentication — REDIS_PASSWORD not set in environment',
        fixDescription: 'Ensure REDIS_PASSWORD is exported via vault-env.mjs in the launch script',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-tls-reject',
        errorSignature: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        rootCause: 'TLS certificate verification failed — missing NODE_EXTRA_CA_CERTS or self-signed cert',
        fixDescription: 'Add NODE_EXTRA_CA_CERTS to the launch script pointing to mkcert rootCA.pem',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-module-not-found',
        errorSignature: 'MODULE_NOT_FOUND',
        rootCause: 'Missing dependency — node_modules out of sync with package.json',
        fixDescription: 'Run npm install in the service directory',
        fixType: 'resource_cleanup',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-uncaught-exception',
        errorSignature: 'UNCAUGHT EXCEPTION',
        rootCause: 'Unhandled exception crashed the process',
        fixDescription: 'Check logs for the exception stack trace and fix the root cause',
        fixType: 'code_change',
        autoRemediable: false,
        risk: 'medium',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-socket-hang-up',
        errorSignature: 'socket hang up',
        rootCause: 'Upstream server closed the connection unexpectedly — likely a timeout or crash',
        fixDescription: 'Check the upstream service health and increase timeout if needed',
        fixType: 'dependency_fix',
        autoRemediable: false,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-disk-full',
        errorSignature: 'ENOSPC',
        rootCause: 'Disk space exhausted — no space left on device',
        fixDescription: 'Free disk space: prune Docker images, rotate logs, clear temp files',
        fixType: 'resource_cleanup',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-model-drift',
        errorSignature: 'model drift detected|accuracy degradation|prediction shift',
        rootCause: 'Model predictions have drifted from expected distribution — data distribution shift or concept drift',
        fixDescription: 'Investigate data distribution changes, retrain on recent data, or roll back to previous model version',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'medium',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-data-pipeline-stale',
        errorSignature: 'stale data|pipeline delay|data freshness|ETL timeout',
        rootCause: 'Data pipeline delivering stale or delayed data — upstream source lag or transform failure',
        fixDescription: 'Check upstream data sources, verify ETL job status, inspect pipeline logs for errors',
        fixType: 'dependency_fix',
        autoRemediable: false,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-inference-latency-spike',
        errorSignature: 'inference latency|prediction timeout|model response slow|serving deadline exceeded',
        rootCause: 'Inference latency spike — model too large for available compute, request queue saturated, or cold cache',
        fixDescription: 'Warm inference cache, reduce batch size, check GPU utilization, scale serving replicas',
        fixType: 'resource_cleanup',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-gpu-oom',
        errorSignature: 'CUDA out of memory|GPU memory exhausted|cuDNN allocation failed|torch.cuda.OutOfMemoryError',
        rootCause: 'GPU memory exhausted — batch size too large, memory leak, KV cache growth, or model exceeds GPU VRAM',
        fixDescription: 'Reduce batch size, enable gradient checkpointing, clear GPU cache, use model quantization',
        fixType: 'restart',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-training-divergence',
        errorSignature: 'loss is NaN|training diverged|gradient explosion|loss inf',
        rootCause: 'Training divergence — learning rate too high, data corruption, or numerical instability',
        fixDescription: 'Abort run, reduce learning rate by 10x, enable gradient clipping, check recent data for corruption, resume from last good checkpoint',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'medium',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-checkpoint-corrupt',
        errorSignature: 'checkpoint corrupt|model load failed|state_dict mismatch|safetensors error',
        rootCause: 'Model checkpoint corrupted or incompatible — interrupted save, version mismatch, or file system error',
        fixDescription: 'Locate latest valid checkpoint, verify loadability, resume training from valid state',
        fixType: 'resource_cleanup',
        autoRemediable: true,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-tokenizer-error',
        errorSignature: 'tokenizer error|vocab mismatch|encoding failed|BPE merge',
        rootCause: 'Tokenizer misconfiguration — model-tokenizer version mismatch or corrupted vocab file',
        fixDescription: 'Verify tokenizer version matches model, re-download vocab file, check tokenizer config',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'low',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'builtin-embedding-dim-mismatch',
        errorSignature: 'dimension mismatch|embedding size|vector dimension|incompatible shapes',
        rootCause: 'Embedding dimension mismatch between model output and vector store configuration',
        fixDescription: 'Verify embedding model version matches Qdrant collection config, re-index vectors if model changed',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'medium',
        occurrences: 0,
        lastSeen: '',
    },
];
function checkDependencyCascade(input) {
    const downDeps = Object.entries(input.dependencyHealth)
        .filter(([, status]) => status === 'down')
        .map(([name]) => name);
    if (downDeps.length === 0)
        return null;
    return {
        reportId: randomUUID(),
        service: input.service,
        timestamp: new Date().toISOString(),
        rootCauseHypothesis: `Dependency cascade failure — ${downDeps.join(', ')} ${downDeps.length === 1 ? 'is' : 'are'} down`,
        confidence: 'high',
        evidence: [
            {
                source: 'dependency',
                description: `${downDeps.length} dependencies are unreachable`,
                data: { downDependencies: downDeps, allDependencies: Object.keys(input.dependencyHealth) },
            },
        ],
        cascadeImpact: input.upstreamDependents || [],
        suggestedFix: {
            type: 'dependency_fix',
            description: `Fix the upstream dependency: ${downDeps.join(', ')}. Restarting ${input.service} won't help until dependencies are restored.`,
            autoRemediable: false,
            risk: 'low',
            steps: downDeps.map((d) => `Check and restart ${d}`),
        },
        matchedPattern: null,
    };
}
function checkResourceExhaustion(input) {
    const { systemMetrics } = input;
    const issues = [];
    const evidence = [];
    if (systemMetrics.memoryPercent > 90) {
        issues.push('memory > 90%');
        evidence.push({
            source: 'metrics',
            description: `System memory at ${systemMetrics.memoryPercent.toFixed(1)}%`,
            data: { memoryPercent: systemMetrics.memoryPercent },
        });
    }
    if (systemMetrics.diskPercent > 95) {
        issues.push('disk > 95%');
        evidence.push({
            source: 'metrics',
            description: `Disk usage at ${systemMetrics.diskPercent.toFixed(1)}%`,
            data: { diskPercent: systemMetrics.diskPercent },
        });
    }
    if (systemMetrics.cpuPercent > 85 && systemMetrics.loadAvg1m > 8) {
        issues.push('CPU saturated');
        evidence.push({
            source: 'metrics',
            description: `CPU at ${systemMetrics.cpuPercent.toFixed(1)}%, load avg ${systemMetrics.loadAvg1m.toFixed(1)}`,
            data: { cpuPercent: systemMetrics.cpuPercent, loadAvg1m: systemMetrics.loadAvg1m },
        });
    }
    if (issues.length === 0)
        return null;
    const isMemory = systemMetrics.memoryPercent > 90;
    const isDisk = systemMetrics.diskPercent > 95;
    return {
        reportId: randomUUID(),
        service: input.service,
        timestamp: new Date().toISOString(),
        rootCauseHypothesis: `Resource exhaustion: ${issues.join(', ')}`,
        confidence: 'high',
        evidence,
        cascadeImpact: input.upstreamDependents || [],
        suggestedFix: {
            type: 'resource_cleanup',
            description: isDisk
                ? 'Free disk space: prune Docker images, rotate logs, clear temp files'
                : isMemory
                    ? 'Reduce memory pressure: restart memory-heavy services, check for leaks'
                    : 'Reduce system load: defer non-critical work, check for runaway processes',
            autoRemediable: isDisk || isMemory,
            risk: 'low',
            steps: [
                ...(isDisk ? ['docker system prune -f', 'find /tmp -name "*.log" -mtime +7 -delete'] : []),
                ...(isMemory
                    ? [
                        'Restart the heaviest service by RSS',
                        'Check for memory leaks in shre-health /v1/memory',
                    ]
                    : []),
            ],
        },
        matchedPattern: null,
    };
}
function checkCrashLoop(input) {
    const recentRestarts = input.recoveryHistory.filter((r) => {
        const age = Date.now() - new Date(r.timestamp).getTime();
        return age < 3600_000;
    });
    if (recentRestarts.length < 3)
        return null;
    const failedRestarts = recentRestarts.filter((r) => !r.success);
    return {
        reportId: randomUUID(),
        service: input.service,
        timestamp: new Date().toISOString(),
        rootCauseHypothesis: `Crash loop detected — ${recentRestarts.length} restarts in the last hour (${failedRestarts.length} failed)`,
        confidence: 'high',
        evidence: [
            {
                source: 'history',
                description: `${recentRestarts.length} restart attempts in last hour`,
                data: {
                    totalRestarts: recentRestarts.length,
                    failedRestarts: failedRestarts.length,
                    recentTimestamps: recentRestarts.slice(-5).map((r) => r.timestamp),
                },
            },
        ],
        cascadeImpact: input.upstreamDependents || [],
        suggestedFix: {
            type: 'escalate',
            description: `Stop restarting — investigate root cause. Service has been restarted ${recentRestarts.length} times without stabilizing.`,
            autoRemediable: false,
            risk: 'high',
            steps: [
                `Check logs: tail -100 ~/Library/Logs/shre-services/${input.service}.log`,
                'Look for recurring error pattern in the last 100 lines',
                'Check if a dependency is flapping',
                'Check system resources (memory, disk)',
            ],
        },
        matchedPattern: null,
    };
}
function checkKnownPatterns(input) {
    const allPatterns = [...BUILTIN_PATTERNS, ...input.knownPatterns];
    const errorLogs = input.recentLogs.filter((l) => l.level === 'error' || l.level === 'warn');
    for (const pattern of allPatterns) {
        const match = errorLogs.find((log) => {
            try {
                return (log.message.includes(pattern.errorSignature) ||
                    new RegExp(pattern.errorSignature).test(log.message));
            }
            catch {
                return log.message.includes(pattern.errorSignature);
            }
        });
        if (match) {
            return {
                reportId: randomUUID(),
                service: input.service,
                timestamp: new Date().toISOString(),
                rootCauseHypothesis: pattern.rootCause,
                confidence: pattern.occurrences > 3 ? 'high' : pattern.occurrences > 0 ? 'medium' : 'medium',
                evidence: [
                    {
                        source: 'pattern',
                        description: `Matched known error pattern: ${pattern.errorSignature}`,
                        data: {
                            patternId: pattern.patternId,
                            matchedLog: match.message.slice(0, 500),
                            matchedAt: match.timestamp,
                            priorOccurrences: pattern.occurrences,
                        },
                    },
                    {
                        source: 'logs',
                        description: `${errorLogs.length} error/warn log entries in recent window`,
                        data: {
                            errorCount: errorLogs.filter((l) => l.level === 'error').length,
                            warnCount: errorLogs.filter((l) => l.level === 'warn').length,
                        },
                    },
                ],
                cascadeImpact: input.upstreamDependents || [],
                suggestedFix: {
                    type: pattern.fixType,
                    description: pattern.fixDescription,
                    autoRemediable: pattern.autoRemediable,
                    risk: pattern.risk,
                    steps: [pattern.fixDescription],
                },
                matchedPattern: pattern.patternId,
            };
        }
    }
    return null;
}
function buildFallbackReport(input) {
    const errorLogs = input.recentLogs.filter((l) => l.level === 'error');
    const lastError = errorLogs.length > 0 ? errorLogs[errorLogs.length - 1] : null;
    return {
        reportId: randomUUID(),
        service: input.service,
        timestamp: new Date().toISOString(),
        rootCauseHypothesis: lastError
            ? `Unknown failure — last error: ${lastError.message.slice(0, 200)}`
            : `Service ${input.service} is unhealthy with no clear error signal`,
        confidence: 'low',
        evidence: [
            {
                source: 'health_state',
                description: `Service status: ${input.healthState.status}, consecutive failures: ${input.healthState.consecutiveFailures}`,
                data: { ...input.healthState },
            },
            ...(errorLogs.length > 0
                ? [
                    {
                        source: 'logs',
                        description: `${errorLogs.length} error log entries`,
                        data: { lastErrors: errorLogs.slice(-3).map((l) => l.message.slice(0, 200)) },
                    },
                ]
                : []),
        ],
        cascadeImpact: input.upstreamDependents || [],
        suggestedFix: {
            type: 'escalate',
            description: `Low confidence diagnosis — escalate to engineering for manual investigation`,
            autoRemediable: false,
            risk: 'medium',
            steps: [
                `Review logs: tail -200 ~/Library/Logs/shre-services/${input.service}.log | grep error`,
                `Check dependencies: curl http://127.0.0.1:5485/v1/heartbeat`,
                `Check system: curl http://127.0.0.1:5485/v1/diagnostics`,
            ],
        },
        matchedPattern: null,
    };
}
export function createDiagnosticEngine() {
    const customPatterns = [];
    let totalDiagnoses = 0;
    let patternMatches = 0;
    let autoRemediableCount = 0;
    return {
        diagnose(input) {
            totalDiagnoses++;
            const crashLoop = checkCrashLoop(input);
            if (crashLoop)
                return crashLoop;
            const cascade = checkDependencyCascade(input);
            if (cascade)
                return cascade;
            const resource = checkResourceExhaustion(input);
            if (resource)
                return resource;
            const patternMatch = checkKnownPatterns({
                ...input,
                knownPatterns: [...customPatterns, ...input.knownPatterns],
            });
            if (patternMatch) {
                patternMatches++;
                if (patternMatch.suggestedFix.autoRemediable)
                    autoRemediableCount++;
                return patternMatch;
            }
            return buildFallbackReport(input);
        },
        registerPattern(pattern) {
            const existing = customPatterns.findIndex((p) => p.patternId === pattern.patternId);
            if (existing >= 0) {
                customPatterns[existing] = pattern;
            }
            else {
                customPatterns.push(pattern);
            }
        },
        getPatterns() {
            return [...BUILTIN_PATTERNS, ...customPatterns];
        },
        stats() {
            return { totalDiagnoses, patternMatches, autoRemediable: autoRemediableCount };
        },
    };
}
