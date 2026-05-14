import { getService } from './discovery.js';
const VAULT_BASE = `http://127.0.0.1:${(() => {
    try {
        return getService('shre-secrets').port;
    }
    catch {
        return 5473;
    }
})()}`;
async function vaultFetch(path, opts, attempt = 0) {
    try {
        const res = await fetch(`${VAULT_BASE}${path}`, {
            ...opts,
            headers: {
                'Content-Type': 'application/json',
                ...opts?.headers,
            },
        });
        if (!res.ok) {
            if (attempt < 3 && (res.status >= 500 || res.status === 429)) {
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise((r) => setTimeout(r, delay));
                return vaultFetch(path, opts, attempt + 1);
            }
            return null;
        }
        return (await res.json());
    }
    catch {
        if (attempt < 3) {
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise((r) => setTimeout(r, delay));
            return vaultFetch(path, opts, attempt + 1);
        }
        return null;
    }
}
export async function getMasked(name, agentId) {
    return vaultFetch(`/v1/credential/${encodeURIComponent(name)}`, {
        headers: { 'x-agent-id': agentId },
    });
}
export async function decrypt(name, passcodeHash, agentId) {
    return vaultFetch(`/v1/credential/${encodeURIComponent(name)}/decrypt`, {
        method: 'POST',
        headers: {
            'x-agent-id': agentId,
            'x-shre-passcode-hash': passcodeHash,
        },
    });
}
export async function getOrEnv(name, envVar, agentId, passcodeHash) {
    if (passcodeHash) {
        const decrypted = await decrypt(name, passcodeHash, agentId);
        if (decrypted?.value)
            return decrypted.value;
    }
    const masked = await getMasked(name, agentId);
    if (masked?.stored) {
        return null;
    }
    return process.env[envVar] ?? null;
}
export async function store(name, value, agentId) {
    const result = await vaultFetch('/v1/credential', {
        method: 'POST',
        headers: { 'x-agent-id': agentId },
        body: JSON.stringify({ name, value }),
    });
    return result?.stored ?? false;
}
export async function list(agentId) {
    const result = await vaultFetch('/v1/credentials', {
        headers: { 'x-agent-id': agentId },
    });
    return result?.credentials ?? [];
}
export async function storeScoped(scope, scopeId, name, value, agentId) {
    const result = await vaultFetch('/v1/scoped/credential', {
        method: 'POST',
        headers: { 'x-agent-id': agentId },
        body: JSON.stringify({ scope, scopeId, name, value }),
    });
    return result?.stored ?? false;
}
export async function listScoped(scope, scopeId, agentId) {
    const result = await vaultFetch(`/v1/scoped/credentials/${encodeURIComponent(scope)}/${encodeURIComponent(scopeId)}`, { headers: { 'x-agent-id': agentId } });
    return result?.credentials ?? [];
}
export async function getMaskedScoped(scope, scopeId, name, agentId) {
    return vaultFetch(`/v1/scoped/credential/${encodeURIComponent(scope)}/${encodeURIComponent(scopeId)}/${encodeURIComponent(name)}`, { headers: { 'x-agent-id': agentId } });
}
export async function deleteScoped(scope, scopeId, name, agentId) {
    const result = await vaultFetch(`/v1/scoped/credential/${encodeURIComponent(scope)}/${encodeURIComponent(scopeId)}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'x-agent-id': agentId } });
    return result?.deleted ?? false;
}
export async function issueTicket(agentId, scope, scopeId, credentials, issuerId, ttlMs) {
    return vaultFetch('/v1/ticket', {
        method: 'POST',
        headers: { 'x-agent-id': issuerId },
        body: JSON.stringify({ agentId, scope, scopeId, credentials, ttlMs }),
    });
}
export async function redeemTicket(ticketId, credential, agentId) {
    const result = await vaultFetch(`/v1/ticket/${encodeURIComponent(ticketId)}/redeem`, {
        method: 'POST',
        headers: { 'x-agent-id': agentId },
        body: JSON.stringify({ credential }),
    });
    return result?.value ?? null;
}
