const ML_PATTERNS = [
    {
        patternId: 'ml-model-drift',
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
        patternId: 'ml-data-pipeline-stale',
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
        patternId: 'ml-inference-latency-spike',
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
        patternId: 'ml-gpu-oom',
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
        patternId: 'ml-training-divergence',
        errorSignature: 'loss is NaN|training diverged|gradient explosion|loss inf',
        rootCause: 'Training divergence — learning rate too high, data corruption, or numerical instability',
        fixDescription: 'Abort run, reduce learning rate by 10x, enable gradient clipping, resume from last good checkpoint',
        fixType: 'config_change',
        autoRemediable: false,
        risk: 'medium',
        occurrences: 0,
        lastSeen: '',
    },
    {
        patternId: 'ml-checkpoint-corrupt',
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
        patternId: 'ml-tokenizer-error',
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
        patternId: 'ml-embedding-dim-mismatch',
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
export function registerMLDiagnosticPatterns(engine) {
    const existing = new Set(engine.getPatterns().map((p) => p.patternId));
    for (const pattern of ML_PATTERNS) {
        if (!existing.has(pattern.patternId)) {
            engine.registerPattern(pattern);
        }
    }
}
export async function enrichDiagnosticWithRAG(report, ragClient) {
    const enriched = {
        ...report,
        mlSystemsContext: [],
        textbookRemediationSteps: [],
    };
    try {
        const query = `${report.rootCauseHypothesis} ${report.suggestedFix.description}`;
        const results = await ragClient.search(query, null, 5);
        if (!results || results.length === 0)
            return enriched;
        const mlResults = results.filter((r) => {
            const meta = r.metadata;
            return meta?.type === 'ml_systems_knowledge' || (r.score && r.score > 0.5);
        });
        enriched.mlSystemsContext = mlResults.map((r) => ({
            content: r.content.slice(0, 500),
            chapter: r.metadata?.chapter,
            category: r.metadata?.category,
            relevance: r.score ?? 0,
        }));
        const steps = [];
        for (const ctx of enriched.mlSystemsContext) {
            const lines = ctx.content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('- **') || trimmed.startsWith('- ')) {
                    const step = trimmed.replace(/^-\s+\*\*([^*]+)\*\*:?\s*/, '$1: ').trim();
                    if (step.length > 20 && step.length < 200) {
                        steps.push(`[MLSys Ch${ctx.chapter || '?'}] ${step}`);
                    }
                }
            }
        }
        enriched.textbookRemediationSteps = steps.slice(0, 5);
        if (enriched.mlSystemsContext.length > 0) {
            enriched.evidence = [
                ...enriched.evidence,
                {
                    source: 'pattern',
                    description: `ML Systems textbook knowledge (${enriched.mlSystemsContext.length} relevant sections)`,
                    data: {
                        chapters: enriched.mlSystemsContext.map((c) => c.chapter).filter(Boolean),
                        categories: [
                            ...new Set(enriched.mlSystemsContext.map((c) => c.category).filter(Boolean)),
                        ],
                        textbookSteps: enriched.textbookRemediationSteps,
                    },
                },
            ];
        }
    }
    catch {
    }
    return enriched;
}
export const ML_DIAGNOSTIC_PATTERNS = ML_PATTERNS;
