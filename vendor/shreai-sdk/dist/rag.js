import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { infraUrl } from './discovery.js';
import { readGatewayToken } from './auth.js';
const ragMetrics = {
    totalQueries: 0,
    hits: 0,
    misses: 0,
    errors: 0,
    totalLatencyMs: 0,
    lastError: null,
    lastErrorTime: null,
};
export function getRAGMetrics() {
    return {
        ...ragMetrics,
        hitRate: ragMetrics.totalQueries > 0
            ? Math.round((ragMetrics.hits / ragMetrics.totalQueries) * 10000) / 100
            : 0,
        avgLatencyMs: ragMetrics.totalQueries > 0
            ? Math.round(ragMetrics.totalLatencyMs / ragMetrics.totalQueries)
            : 0,
    };
}
const RAG_RELEVANCE_FILTER_ENABLED = process.env.RAG_RELEVANCE_FILTER_ENABLED !== 'false';
const RAG_RELEVANCE_THRESHOLD = parseFloat(process.env.RAG_RELEVANCE_THRESHOLD || '0.35');
let _cortexSessionToken = null;
let _cortexTokenExpiry = 0;
async function getCortexSuperAdminToken(cortexUrl) {
    if (_cortexSessionToken && Date.now() < _cortexTokenExpiry)
        return _cortexSessionToken;
    let masterSecret = process.env.CORTEXDB_MASTER_SECRET;
    if (!masterSecret) {
        try {
            const envFile = readFileSync(join(process.env.HOME ?? '', 'Documents/Projects/shreai/cortexdb/.env'), 'utf8');
            const match = envFile.match(/CORTEXDB_MASTER_SECRET=(.+)/);
            if (match?.[1])
                masterSecret = match[1].trim();
        }
        catch (err) {
        }
    }
    if (!masterSecret)
        return null;
    try {
        const res = await fetch(`${cortexUrl}/v1/superadmin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passphrase: masterSecret }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        _cortexSessionToken = data.token ?? null;
        _cortexTokenExpiry = Date.now() + 55 * 60 * 1000;
        return _cortexSessionToken;
    }
    catch (err) {
        return null;
    }
}
export function createRAGClient(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const timeout = opts.timeoutMs ?? 3000;
    const threshold = opts.threshold ?? 0.4;
    const useRerank = opts.rerank ?? false;
    const bus = opts.eventBus;
    let _gatewayToken = null;
    function getUrl() {
        if (opts.url)
            return opts.url;
        try {
            return infraUrl('cortexservice-api');
        }
        catch (err) {
            log.debug('[rag] CortexDB URL discovery failed, using default', {
                error: err.message,
            });
            return process.env.CORTEX_URL ?? 'http://127.0.0.1:5400';
        }
    }
    function getGatewayToken() {
        if (_gatewayToken === null) {
            _gatewayToken = readGatewayToken();
        }
        return _gatewayToken;
    }
    async function superAdminHeaders() {
        const token = await getCortexSuperAdminToken(getUrl());
        if (token) {
            return { 'X-SuperAdmin-Token': token };
        }
        return { Authorization: `Bearer ${getGatewayToken()}` };
    }
    async function retrieve(query, tenantId, limit = 5) {
        ragMetrics.totalQueries++;
        const t0 = Date.now();
        try {
            const params = new URLSearchParams({
                query,
                limit: String(limit),
                threshold: String(threshold),
            });
            if (tenantId)
                params.set('workspace_id', tenantId);
            const res = await fetch(`${getUrl()}/v1/rag/context?${params}`, {
                headers: {
                    Authorization: `Bearer ${getGatewayToken()}`,
                },
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
                ragMetrics.misses++;
                ragMetrics.totalLatencyMs += Date.now() - t0;
                return null;
            }
            const data = (await res.json());
            let results = null;
            if (typeof data.context === 'string')
                results = [data.context];
            else if (Array.isArray(data.results)) {
                results = data.results.map((r) => r.content ?? r.text ?? '').filter(Boolean);
            }
            const latencyMs = Date.now() - t0;
            if (results && results.length > 0) {
                ragMetrics.hits++;
            }
            else {
                ragMetrics.misses++;
            }
            ragMetrics.totalLatencyMs += latencyMs;
            if (bus) {
                bus
                    .publish('rag.retrieved', 'info', {
                    hitCount: results?.length ?? 0,
                    source: serviceName,
                    latencyMs,
                    storeId: tenantId,
                })
                    .catch(() => { });
            }
            return results;
        }
        catch (err) {
            ragMetrics.errors++;
            ragMetrics.lastError = err?.message ?? String(err);
            ragMetrics.lastErrorTime = new Date().toISOString();
            ragMetrics.totalLatencyMs += Date.now() - t0;
            log.warn('RAG retrieve failed', { tenantId }, err);
            return null;
        }
    }
    async function retrieveWithScores(query, tenantId, limit = 5) {
        try {
            const params = new URLSearchParams({
                query,
                limit: String(limit),
                threshold: String(threshold),
            });
            if (tenantId)
                params.set('workspace_id', tenantId);
            params.set('include_scores', 'true');
            const res = await fetch(`${getUrl()}/v1/rag/context?${params}`, {
                headers: {
                    Authorization: `Bearer ${getGatewayToken()}`,
                },
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok)
                return null;
            const data = (await res.json());
            if (Array.isArray(data.results)) {
                return data.results
                    .map((r) => ({ content: r.content ?? r.text ?? '', score: r.score ?? 0 }))
                    .filter((r) => r.content);
            }
            return null;
        }
        catch (err) {
            log.warn('RAG retrieve with scores failed', { tenantId }, err);
            return null;
        }
    }
    async function search(query, tenantId, limit = 5) {
        ragMetrics.totalQueries++;
        const t0 = Date.now();
        try {
            const res = await fetch(`${getUrl()}/v1/rag/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    limit,
                    rerank: useRerank,
                    rerank_top_k: Math.min(limit * 4, 20),
                    dense_threshold: threshold,
                    ...(tenantId ? { tenant_id: tenantId } : {}),
                }),
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) {
                ragMetrics.misses++;
                ragMetrics.totalLatencyMs += Date.now() - t0;
                return null;
            }
            const data = (await res.json());
            if (!Array.isArray(data.results)) {
                ragMetrics.misses++;
                ragMetrics.totalLatencyMs += Date.now() - t0;
                return null;
            }
            const results = data.results
                .filter((r) => r.content)
                .map((r) => ({
                content: r.content,
                score: r.score ?? 0,
                rerankScore: r.rerank_score ?? undefined,
                source: r.metadata?.source ?? 'unknown',
            }));
            const latencyMs = Date.now() - t0;
            if (results.length > 0) {
                ragMetrics.hits++;
            }
            else {
                ragMetrics.misses++;
            }
            ragMetrics.totalLatencyMs += latencyMs;
            if (bus) {
                bus
                    .publish('rag.searched', 'info', {
                    hitCount: results.length,
                    reranked: useRerank,
                    source: serviceName,
                    latencyMs,
                    storeId: tenantId,
                })
                    .catch(() => { });
            }
            return results;
        }
        catch (err) {
            ragMetrics.errors++;
            ragMetrics.lastError = err?.message ?? String(err);
            ragMetrics.lastErrorTime = new Date().toISOString();
            ragMetrics.totalLatencyMs += Date.now() - t0;
            log.warn('RAG search failed', { tenantId }, err);
            return null;
        }
    }
    async function recallMemory(agentId, query, limit = 5) {
        try {
            const params = new URLSearchParams({ query, limit: String(limit) });
            const authHeaders = await superAdminHeaders();
            const res = await fetch(`${getUrl()}/v1/superadmin/bridge/memory/recall/${encodeURIComponent(agentId)}?${params}`, {
                headers: authHeaders,
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok)
                return null;
            const data = (await res.json());
            if (Array.isArray(data.memories)) {
                return data.memories.map((m) => m.content ?? m.fact ?? '').filter(Boolean);
            }
            return null;
        }
        catch (err) {
            log.warn('Memory recall failed', { agentId }, err);
            return null;
        }
    }
    async function storeMemory(agentId, fact, category = 'conversation-insight', importance = 'medium') {
        try {
            const authHeaders = await superAdminHeaders();
            const res = await fetch(`${getUrl()}/v1/superadmin/bridge/memory/store`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                },
                body: JSON.stringify({
                    agent_id: agentId,
                    content: fact,
                    category,
                    importance,
                }),
                signal: AbortSignal.timeout(timeout),
            });
            if (res.ok && bus) {
                bus
                    .publish('rag.insight_stored', 'info', {
                    agentId,
                    fact,
                    category,
                    importance,
                    source: serviceName,
                    storeId: agentId,
                })
                    .catch(() => { });
            }
            return res.ok;
        }
        catch (err) {
            log.warn('Memory store failed', { agentId }, err);
            return false;
        }
    }
    async function ingest(title, content, tenantId, meta = {}) {
        try {
            const authHeaders = await superAdminHeaders();
            const res = await fetch(`${getUrl()}/v1/superadmin/rag/ingest`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                },
                body: JSON.stringify({
                    title,
                    content,
                    source: serviceName,
                    workspace_id: tenantId,
                    scope: tenantId ? 'workspace' : 'platform',
                    metadata: { ...meta, generatedAt: new Date().toISOString() },
                }),
                signal: AbortSignal.timeout(timeout),
            });
            return res.ok;
        }
        catch (err) {
            log.warn('RAG ingest failed', { title }, err);
            return false;
        }
    }
    async function healthy() {
        try {
            const res = await fetch(`${getUrl()}/health`, {
                signal: AbortSignal.timeout(timeout),
            });
            return res.ok;
        }
        catch (err) {
            log.debug('[rag] Health check failed', { error: err.message });
            return false;
        }
    }
    return { retrieve, retrieveWithScores, search, recallMemory, storeMemory, ingest, healthy };
}
export function createRAGMiddleware(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const sources = opts.sources ?? ['vectors', 'memory'];
    const timeoutMs = opts.timeoutMs ?? 3000;
    const rag = createRAGClient(serviceName, {
        timeoutMs,
        logger: log,
        eventBus: opts.eventBus,
        rerank: true,
        threshold: RAG_RELEVANCE_THRESHOLD,
    });
    function withTimeout(promise) {
        return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
    }
    function dedup(items) {
        const seen = new Map();
        for (const item of items) {
            const key = item.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
            const existing = seen.get(key);
            if (!existing || item.score > existing.score) {
                seen.set(key, item);
            }
        }
        return [...seen.values()];
    }
    async function enrich(query, tenantId, agentId) {
        const tasks = [];
        if (sources.includes('vectors')) {
            tasks.push(withTimeout(rag.search(query, tenantId, 8)).then((data) => ({
                label: 'vectors',
                items: (data ?? []).map((r) => ({
                    content: r.content,
                    score: r.rerankScore ?? r.score,
                    source: r.source,
                })),
            })));
        }
        if (sources.includes('memory')) {
            tasks.push(withTimeout(rag.recallMemory(agentId, query, 5)).then((data) => ({
                label: 'memory',
                items: (data ?? []).map((text, i) => ({
                    content: text,
                    score: 0.8 - i * 0.05,
                    source: 'agent-memory',
                })),
            })));
        }
        if (sources.includes('custom') && opts.customSource) {
            tasks.push(withTimeout(opts.customSource(query, tenantId)).then((data) => ({
                label: 'database',
                items: data ? [{ content: data, score: 0.95, source: 'live-query' }] : [],
            })));
        }
        if (sources.includes('keyword') && opts.keywordSource) {
            const keywordResults = opts.keywordSource.search(query, tenantId, 8);
            tasks.push(Promise.resolve({
                label: 'keyword',
                items: keywordResults.map((r) => ({
                    content: r.content,
                    score: r.score,
                    source: `keyword:${r.source}`,
                })),
            }));
        }
        const results = await Promise.allSettled(tasks);
        const allItems = [];
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value.items.length > 0) {
                allItems.push(...r.value.items);
            }
        }
        if (allItems.length === 0) {
            log.debug('RAG enrichment: no results');
            return null;
        }
        const dedupedItems = dedup(allItems).sort((a, b) => b.score - a.score);
        const unique = RAG_RELEVANCE_FILTER_ENABLED
            ? dedupedItems.filter((r) => (r.score ?? 1.0) >= RAG_RELEVANCE_THRESHOLD)
            : dedupedItems;
        const droppedChunks = RAG_RELEVANCE_FILTER_ENABLED
            ? dedupedItems.filter((r) => (r.score ?? 1.0) < RAG_RELEVANCE_THRESHOLD)
            : [];
        if (RAG_RELEVANCE_FILTER_ENABLED && droppedChunks.length > 0) {
            log.info('[rag] Chunks dropped below relevance threshold', {
                query: query.slice(0, 100),
                threshold: RAG_RELEVANCE_THRESHOLD,
                dropped: droppedChunks.length,
                kept: unique.length,
                droppedScores: droppedChunks.map((c) => c.score?.toFixed(2)),
            });
        }
        if (unique.length === 0) {
            log.debug('RAG enrichment: all chunks dropped by relevance filter', {
                totalBeforeFilter: dedupedItems.length,
                threshold: RAG_RELEVANCE_THRESHOLD,
            });
            return null;
        }
        const lines = [];
        for (const item of unique) {
            const priority = item.score >= 0.8 ? 'high' : item.score >= 0.6 ? 'medium' : 'low';
            lines.push(`<context priority="${priority}" source="${item.source}" relevance="${item.score.toFixed(2)}">\n${item.content.trim()}\n</context>`);
        }
        log.debug('RAG enrichment complete', {
            sources: sources.length,
            rawHits: allItems.length,
            afterDedup: unique.length,
            topScore: unique[0]?.score.toFixed(2),
        });
        return lines.join('\n\n');
    }
    return { enrich };
}
function sanitize(text, maxLen = 500) {
    return text
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim()
        .slice(0, maxLen);
}
function classifyImportance(insight) {
    const lower = insight.toLowerCase();
    if (/(?:decided|plan|going to|will change|discontinue|new policy)/i.test(lower))
        return 'high';
    if (/\$[\d,.]+/.test(insight) || /(?:compared|top|best|revenue|profit)/i.test(lower))
        return 'medium';
    if (/(?:like|prefer|about|remember|trained|teach|learn|who is|tell me about)/i.test(lower))
        return 'medium';
    return 'low';
}
function extractInsights(userText, assistantText) {
    const insights = [];
    const uLower = userText.toLowerCase();
    const hasData = /\$[\d,.]+|[\d.]+%|\d+\s+(?:units?|items?|transactions?)/.test(assistantText);
    if (userText.length + assistantText.length < 50)
        return insights;
    if (!hasData && assistantText.length >= 80) {
        const text = sanitize(`Q: ${userText.slice(0, 100)} → A: ${assistantText.slice(0, 200).replace(/\n/g, ' ')}`);
        insights.push({
            text,
            importance: 'low',
            confidence: 0.5,
            source: 'conversation',
            verified: false,
        });
    }
    const taskMatch = uLower.match(/(?:task|issue|bug|todo|remind|create|update|status|progress|deadline)\s*(?:[:.]?\s*)(.+?)(?:\?|$)/);
    if (taskMatch) {
        const text = sanitize(`Task/action discussed: ${taskMatch[1].trim()}`);
        insights.push({
            text,
            importance: 'medium',
            confidence: 0.6,
            source: 'conversation',
            verified: false,
        });
    }
    const productMatch = uLower.match(/(?:how|what|show).*?(?:about|for|is)\s+([a-z\s]+?)(?:\?|$)/);
    if (productMatch && hasData) {
        const amounts = assistantText.match(/\$[\d,.]+/g) || [];
        const text = sanitize(`Owner inquired about ${productMatch[1].trim()}: key figure ${amounts[0] || 'N/A'}`);
        const importance = classifyImportance(text);
        insights.push({ text, importance, confidence: 0.7, source: 'conversation', verified: false });
    }
    const compMatch = uLower.match(/(?:compare|vs|versus|difference between)\s+(.+?)\s+(?:and|vs|versus|to)\s+(.+?)(?:\?|$)/);
    if (compMatch && hasData) {
        const amounts = assistantText.match(/\$[\d,.]+/g) || [];
        const text = sanitize(`Compared ${compMatch[1].trim()} vs ${compMatch[2].trim()}${amounts.length ? ': ' + amounts.slice(0, 2).join(' vs ') : ''}`);
        insights.push({
            text,
            importance: 'medium',
            confidence: 0.8,
            source: 'conversation',
            verified: false,
        });
    }
    const decisionPatterns = [
        /(?:i(?:'m| am) going to|we(?:'re| are) going to|plan(?:ning)? to|decided to|want to)\s+(.+?)(?:\.|$)/i,
        /(?:let(?:'s| us)|should we|thinking (?:of|about))\s+(.+?)(?:\.|$)/i,
    ];
    for (const pat of decisionPatterns) {
        const m = userText.match(pat);
        if (m) {
            const text = sanitize(`Owner mentioned: ${m[1].trim()}`);
            insights.push({
                text,
                importance: 'high',
                confidence: 0.6,
                source: 'conversation',
                verified: false,
            });
            break;
        }
    }
    if (/(?:unusual|spike|drop|anomal)/i.test(uLower) && hasData) {
        const text = sanitize(`Discussed anomaly: ${assistantText.slice(0, 200).replace(/\n/g, ' ')}`);
        insights.push({
            text,
            importance: 'medium',
            confidence: 0.6,
            source: 'conversation',
            verified: false,
        });
    }
    return insights;
}
function computeExpiresAt(importance) {
    const now = Date.now();
    const dayMs = 86_400_000;
    const retentionDays = {
        high: 90,
        medium: 30,
        low: 14,
    };
    return new Date(now + retentionDays[importance] * dayMs).toISOString();
}
export function createConversationLearner(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const minResponseLength = opts.minResponseLength ?? 50;
    const dedupThreshold = opts.dedupThreshold ?? 0.9;
    const bus = opts.eventBus;
    const rag = createRAGClient(serviceName, { logger: log, eventBus: bus });
    async function learn(userText, assistantText, tenantId, agentId) {
        try {
            if (!userText || !assistantText || assistantText.length < minResponseLength) {
                log.debug('Learn skipped — input too short', {
                    userLen: userText?.length ?? 0,
                    assistantLen: assistantText?.length ?? 0,
                    minRequired: minResponseLength,
                });
                return;
            }
            const insights = extractInsights(userText, assistantText);
            if (insights.length === 0) {
                log.debug('Learn skipped — no insights extracted', { userLen: userText.length });
                return;
            }
            const timestamp = new Date().toISOString().slice(0, 10);
            const tasks = [];
            let deduped = 0;
            for (const insight of insights) {
                const existing = await rag.retrieveWithScores(insight.text, tenantId, 1);
                if (existing && existing.length > 0 && existing[0].score > dedupThreshold) {
                    log.debug('Skipping duplicate insight', {
                        score: existing[0].score,
                        threshold: dedupThreshold,
                        tenantId,
                    });
                    deduped++;
                    continue;
                }
                const tagged = `[${timestamp}] [confidence:${insight.confidence}] ${insight.text}`;
                const expiresAt = computeExpiresAt(insight.importance);
                tasks.push(rag.storeMemory(agentId, tagged, 'conversation-insight', insight.importance));
                tasks.push(rag.ingest(`${serviceName} Conversation Insight`, tagged, tenantId, {
                    agentId,
                    type: 'conversation-insight',
                    importance: insight.importance,
                    confidence: insight.confidence,
                    verified: false,
                    source: 'conversation',
                    expiresAt,
                }));
            }
            await Promise.allSettled(tasks);
            log.info('Conversation insights stored', {
                insightCount: insights.length,
                deduped,
                stored: insights.length - deduped,
                agentId,
                tenantId,
            });
        }
        catch (err) {
            log.warn('Conversation learning error', { agentId }, err);
        }
    }
    return { learn };
}
