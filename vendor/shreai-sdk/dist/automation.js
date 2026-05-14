import { serviceUrl } from './discovery.js';
export function createAutomationClient(serviceName, opts) {
    let baseUrl;
    try {
        baseUrl = opts?.url || serviceUrl('shre-auto');
    }
    catch {
        baseUrl = 'http://127.0.0.1:5513';
    }
    async function request(method, path, body) {
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Channel': serviceName,
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(err.error || `shre-auto ${res.status}`);
        }
        return res.json();
    }
    return {
        async createRule(rule) {
            return request('POST', '/v1/rules', rule);
        },
        async triggerRule(ruleId, context) {
            return request('POST', `/v1/rules/${ruleId}/trigger`, context || {});
        },
        async resolveEscalation(chainId, resolvedBy, note) {
            const result = await request('POST', `/v1/escalations/${chainId}/resolve`, {
                resolved_by: resolvedBy,
                note,
            });
            return result.ok;
        },
        async listRules(workspaceId, filters) {
            const params = new URLSearchParams({ workspace_id: workspaceId });
            if (filters?.org_node_id)
                params.set('org_node_id', filters.org_node_id);
            if (filters?.trigger_type)
                params.set('trigger_type', filters.trigger_type);
            if (filters?.status)
                params.set('status', filters.status);
            if (filters?.limit)
                params.set('limit', String(filters.limit));
            if (filters?.offset)
                params.set('offset', String(filters.offset));
            const result = await request('GET', `/v1/rules?${params}`);
            return result.rules;
        },
        async getTemplates(category) {
            const params = category ? `?category=${category}` : '';
            const result = await request('GET', `/v1/templates${params}`);
            return result.templates;
        },
    };
}
