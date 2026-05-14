import { createLogger } from './logger.js';
import { infraUrl } from './discovery.js';
const STOPWORDS = new Set([
    'a',
    'about',
    'above',
    'after',
    'again',
    'against',
    'all',
    'am',
    'an',
    'and',
    'any',
    'are',
    'aren',
    'arent',
    'as',
    'at',
    'be',
    'because',
    'been',
    'before',
    'being',
    'below',
    'between',
    'both',
    'but',
    'by',
    'can',
    'could',
    'did',
    'didn',
    'do',
    'does',
    'doesn',
    'doing',
    'don',
    'down',
    'during',
    'each',
    'few',
    'for',
    'from',
    'further',
    'get',
    'got',
    'had',
    'hadn',
    'has',
    'hasn',
    'have',
    'haven',
    'having',
    'he',
    'her',
    'here',
    'hers',
    'herself',
    'him',
    'himself',
    'his',
    'how',
    'i',
    'if',
    'in',
    'into',
    'is',
    'isn',
    'it',
    'its',
    'itself',
    'just',
    'let',
    'll',
    'me',
    'might',
    'more',
    'most',
    'must',
    'mustn',
    'my',
    'myself',
    'need',
    'no',
    'nor',
    'not',
    'now',
    'of',
    'off',
    'on',
    'once',
    'only',
    'or',
    'other',
    'our',
    'ours',
    'ourselves',
    'out',
    'over',
    'own',
    'quite',
    're',
    's',
    'same',
    'shan',
    'she',
    'should',
    'shouldn',
    'so',
    'some',
    'such',
    't',
    'than',
    'that',
    'the',
    'their',
    'theirs',
    'them',
    'themselves',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'to',
    'too',
    'under',
    'until',
    'up',
    'us',
    've',
    'very',
    'was',
    'wasn',
    'we',
    'were',
    'weren',
    'what',
    'when',
    'where',
    'which',
    'while',
    'who',
    'whom',
    'why',
    'will',
    'with',
    'won',
    'would',
    'wouldn',
    'you',
    'your',
    'yours',
    'yourself',
    'yourselves',
]);
function stem(word) {
    if (word.length < 4)
        return word;
    if (word.endsWith('ation'))
        return word.slice(0, -5);
    if (word.endsWith('ment'))
        return word.slice(0, -4);
    if (word.endsWith('ness'))
        return word.slice(0, -4);
    if (word.endsWith('tion'))
        return word.slice(0, -4);
    if (word.endsWith('sion'))
        return word.slice(0, -4);
    if (word.endsWith('able'))
        return word.slice(0, -4);
    if (word.endsWith('ible'))
        return word.slice(0, -4);
    if (word.endsWith('ment'))
        return word.slice(0, -4);
    if (word.endsWith('ful'))
        return word.slice(0, -3);
    if (word.endsWith('ing') && word.length > 5)
        return word.slice(0, -3);
    if (word.endsWith('ous'))
        return word.slice(0, -3);
    if (word.endsWith('ive'))
        return word.slice(0, -3);
    if (word.endsWith('ity'))
        return word.slice(0, -3);
    if (word.endsWith('ize'))
        return word.slice(0, -3);
    if (word.endsWith('ise'))
        return word.slice(0, -3);
    if (word.endsWith('ly') && word.length > 4)
        return word.slice(0, -2);
    if (word.endsWith('ed') && word.length > 4)
        return word.slice(0, -2);
    if (word.endsWith('er') && word.length > 4)
        return word.slice(0, -2);
    if (word.endsWith('es') && word.length > 4)
        return word.slice(0, -2);
    if (word.endsWith('al') && word.length > 4)
        return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3)
        return word.slice(0, -1);
    return word;
}
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w))
        .map(stem);
}
function buildPostings(docs) {
    const postings = new Map();
    for (const doc of docs) {
        const freq = new Map();
        for (const t of doc.tokens) {
            freq.set(t, (freq.get(t) ?? 0) + 1);
        }
        for (const [term, count] of freq) {
            let list = postings.get(term);
            if (!list) {
                list = new Map();
                postings.set(term, list);
            }
            list.set(doc.id, count);
        }
    }
    return postings;
}
function computeIDF(totalDocs, docsWithTerm) {
    return Math.log((totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1);
}
function scoreBM25(queryTokens, docId, docLength, postings, avgDocLen, totalDocs, config) {
    let score = 0;
    for (const qt of queryTokens) {
        const list = postings.get(qt);
        if (!list)
            continue;
        const tf = list.get(docId) ?? 0;
        if (tf === 0)
            continue;
        const df = list.size;
        const idf = computeIDF(totalDocs, df);
        const numerator = tf * (config.k1 + 1);
        const denominator = tf + config.k1 * (1 - config.b + config.b * (docLength / avgDocLen));
        score += idf * (numerator / denominator);
    }
    return score;
}
export function createVectorlessRAG(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const dataTypes = opts.dataTypes ?? ['training_data', 'rag_knowledge'];
    const refreshIntervalMs = opts.refreshIntervalMs ?? 300_000;
    const maxDocsPerType = opts.maxDocsPerType ?? 5000;
    const scoreMultiplier = opts.scoreMultiplier ?? 0.7;
    const bm25 = { k1: opts.bm25?.k1 ?? 1.2, b: opts.bm25?.b ?? 0.75 };
    const bus = opts.eventBus;
    const docs = new Map();
    let postings = new Map();
    let avgDocLen = 0;
    let lastRefreshAt = null;
    let refreshTimer = null;
    function getCortexUrl() {
        if (opts.cortexUrl)
            return opts.cortexUrl;
        try {
            return infraUrl('cortexservice-api');
        }
        catch {
            return process.env.CORTEX_URL ?? 'http://127.0.0.1:5400';
        }
    }
    function rebuildIndex() {
        const allDocs = [...docs.values()];
        postings = buildPostings(allDocs);
        avgDocLen =
            allDocs.length > 0
                ? allDocs.reduce((sum, d) => sum + d.tokens.length, 0) / allDocs.length
                : 0;
    }
    async function refresh() {
        const t0 = Date.now();
        const cortexUrl = getCortexUrl();
        let newDocs = 0;
        for (const dataType of dataTypes) {
            try {
                const params = new URLSearchParams({
                    data_type: dataType,
                    limit: String(maxDocsPerType),
                });
                if (lastRefreshAt) {
                    params.set('after', lastRefreshAt);
                }
                const res = await fetch(`${cortexUrl}/v1/query?${params}`, {
                    signal: AbortSignal.timeout(10_000),
                });
                if (!res.ok) {
                    log.debug('CortexDB query failed for vectorless-rag', {
                        dataType,
                        status: res.status,
                    });
                    continue;
                }
                const data = (await res.json());
                const results = data.results ?? [];
                for (const r of results) {
                    const id = r.id ?? r._id ?? `${dataType}-${newDocs}`;
                    const content = r.content ?? r.text ?? (r.data ? JSON.stringify(r.data) : null);
                    if (!content || content.length < 10)
                        continue;
                    const tokens = tokenize(content);
                    if (tokens.length < 2)
                        continue;
                    docs.set(id, {
                        id,
                        content,
                        tokens,
                        tenantId: r.tenant_id ?? r.workspace_id ?? null,
                        source: r.source ?? dataType,
                    });
                    newDocs++;
                }
            }
            catch (err) {
                log.warn('Vectorless RAG refresh failed for type', {
                    dataType,
                    error: err.message,
                });
            }
        }
        rebuildIndex();
        lastRefreshAt = new Date().toISOString();
        const latencyMs = Date.now() - t0;
        log.info('Vectorless RAG index refreshed', {
            totalDocs: docs.size,
            newDocs,
            terms: postings.size,
            avgDocLen: Math.round(avgDocLen),
            latencyMs,
        });
        if (bus) {
            bus
                .publish('rag.keyword.indexed', 'info', {
                service: serviceName,
                totalDocs: docs.size,
                terms: postings.size,
                latencyMs,
            })
                .catch(() => { });
        }
        return { docsIndexed: docs.size, terms: postings.size, latencyMs };
    }
    function search(query, tenantId, limit = 5) {
        const t0 = Date.now();
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0)
            return [];
        const totalDocs = docs.size;
        if (totalDocs === 0)
            return [];
        const scored = [];
        for (const doc of docs.values()) {
            if (tenantId && doc.tenantId && doc.tenantId !== tenantId)
                continue;
            const raw = scoreBM25(queryTokens, doc.id, doc.tokens.length, postings, avgDocLen, totalDocs, bm25);
            if (raw > 0) {
                scored.push({ doc, score: raw });
            }
        }
        if (scored.length === 0)
            return [];
        scored.sort((a, b) => b.score - a.score);
        const maxScore = scored[0].score;
        const results = scored.slice(0, limit).map((s) => ({
            content: s.doc.content,
            score: (s.score / maxScore) * scoreMultiplier,
            source: s.doc.source,
            docId: s.doc.id,
        }));
        const latencyMs = Date.now() - t0;
        if (bus) {
            bus
                .publish('rag.keyword.searched', 'info', {
                service: serviceName,
                query: query.slice(0, 100),
                hitCount: results.length,
                topScore: results[0]?.score,
                latencyMs,
                tenantId,
            })
                .catch(() => { });
        }
        return results;
    }
    function ingest(docId, content, source = 'direct', tenantId = null) {
        const tokens = tokenize(content);
        if (tokens.length < 2)
            return;
        docs.set(docId, { id: docId, content, tokens, tenantId, source });
        rebuildIndex();
    }
    function stats() {
        const allDocs = [...docs.values()];
        const indexSizeEstimate = allDocs.reduce((sum, d) => sum + d.tokens.length * 20, 0);
        return {
            totalDocs: docs.size,
            totalTerms: postings.size,
            avgDocLength: Math.round(avgDocLen),
            lastRefreshAt,
            indexSizeEstimate,
        };
    }
    function shutdown() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        docs.clear();
        postings.clear();
        avgDocLen = 0;
        log.info('Vectorless RAG shutdown');
    }
    if (refreshIntervalMs > 0) {
        refresh().catch((err) => {
            log.warn('Initial vectorless RAG refresh failed', { error: err.message });
        });
        refreshTimer = setInterval(() => {
            refresh().catch((err) => {
                log.warn('Periodic vectorless RAG refresh failed', { error: err.message });
            });
        }, refreshIntervalMs);
        if (refreshTimer && typeof refreshTimer === 'object' && 'unref' in refreshTimer) {
            refreshTimer.unref();
        }
    }
    return { search, refresh, stats, ingest, shutdown };
}
