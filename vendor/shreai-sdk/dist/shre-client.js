export class ShreClient {
    apiKey;
    baseUrl;
    workspaceId;
    defaultAgentId;
    timeoutMs;
    constructor(opts) {
        if (!opts.apiKey)
            throw new Error('ShreClient: apiKey is required');
        this.apiKey = opts.apiKey;
        this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:5438').replace(/\/+$/, '');
        this.workspaceId = opts.workspaceId;
        this.defaultAgentId = opts.defaultAgentId || 'support';
        this.timeoutMs = opts.timeoutMs || 30_000;
    }
    async request(method, path, body, extraHeaders) {
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
        };
        if (this.workspaceId) {
            headers['X-Workspace-ID'] = this.workspaceId;
        }
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ShreClient ${method} ${path} failed (${res.status}): ${text}`);
        }
        return res.json();
    }
    async chat(opts) {
        const messages = [...opts.messages];
        if (opts.systemPrompt && messages[0]?.role !== 'system') {
            messages.unshift({ role: 'system', content: opts.systemPrompt });
        }
        const data = await this.request('POST', '/v1/chat', {
            messages,
            agentId: opts.agentId || this.defaultAgentId,
            tenantId: opts.tenantId || this.workspaceId,
            model: opts.model || 'auto',
            stream: false,
            metadata: opts.metadata,
        });
        const content = data.content ||
            data.content?.[0]?.text ||
            data.message?.content ||
            data.choices?.[0]?.message?.content ||
            '';
        return {
            content,
            model: data.model,
            tokenCount: data.tokenCount,
            costUsd: data.costUsd,
        };
    }
    async *chatStream(opts) {
        const messages = [...opts.messages];
        if (opts.systemPrompt && messages[0]?.role !== 'system') {
            messages.unshift({ role: 'system', content: opts.systemPrompt });
        }
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        };
        if (this.workspaceId)
            headers['X-Workspace-ID'] = this.workspaceId;
        const res = await fetch(`${this.baseUrl}/v1/chat`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                messages,
                agentId: opts.agentId || this.defaultAgentId,
                tenantId: opts.tenantId || this.workspaceId,
                model: opts.model || 'auto',
                stream: true,
                metadata: opts.metadata,
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ShreClient chatStream failed (${res.status}): ${text}`);
        }
        if (!res.body)
            throw new Error('ShreClient: no response body for stream');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                let eventType = 'delta';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                        continue;
                    }
                    if (line.startsWith('data: ')) {
                        const raw = line.slice(6);
                        if (raw === '[DONE]')
                            return;
                        if (eventType === 'delta') {
                            yield { type: 'delta', data: raw };
                        }
                        else {
                            try {
                                yield { type: eventType, data: JSON.parse(raw) };
                            }
                            catch {
                                yield { type: eventType, data: raw };
                            }
                        }
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    async indexKB(articles) {
        return this.request('POST', '/v1/support/kb/index', { articles });
    }
    async deleteKBArticle(articleId) {
        return this.request('DELETE', `/v1/support/kb/articles/${encodeURIComponent(articleId)}`);
    }
    async enrich(identifier, device) {
        return this.request('POST', '/v1/support/enrich', { identifier, device });
    }
    async health() {
        return this.request('GET', '/health');
    }
    setWorkspace(workspaceId) {
        this.workspaceId = workspaceId;
    }
}
export default ShreClient;
