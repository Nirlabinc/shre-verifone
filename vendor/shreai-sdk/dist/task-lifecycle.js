import { serviceUrl } from './discovery.js';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
export function createTaskLifecycle(opts) {
    const { service, token, defaultTtlMs = 4 * 60 * 60 * 1000, defaultPriority = 'medium', log = (msg) => process.stderr.write(`[task-lifecycle:${service}] ${msg}\n`), } = opts;
    const tasksUrl = serviceUrl('shre-tasks');
    const openIssues = new Map();
    const walDir = join(process.env.HOME || '/tmp', '.shre', 'wal');
    const walPath = join(walDir, `task-lifecycle-${service}.jsonl`);
    try {
        mkdirSync(walDir, { recursive: true });
    }
    catch {
    }
    function walAppend(entry) {
        try {
            appendFileSync(walPath, JSON.stringify({ ...entry, ts: Date.now() }) + '\n');
        }
        catch {
        }
    }
    async function walReplay() {
        if (!existsSync(walPath))
            return;
        let lines;
        try {
            lines = readFileSync(walPath, 'utf-8').trim().split('\n').filter(Boolean);
        }
        catch {
            return;
        }
        if (lines.length === 0)
            return;
        const remaining = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (Date.now() - (entry.ts || 0) > defaultTtlMs)
                    continue;
                if (entry.action === 'create') {
                    await fetchJSON(`${tasksUrl}/v1/intake`, {
                        method: 'POST',
                        body: JSON.stringify(entry.body),
                    });
                }
                else if (entry.action === 'resolve') {
                    await fetchJSON(`${tasksUrl}/v1/tasks/${entry.taskId}`, {
                        method: 'PATCH',
                        body: JSON.stringify(entry.body),
                    });
                }
            }
            catch {
                remaining.push(line);
            }
        }
        try {
            if (remaining.length === 0) {
                writeFileSync(walPath, '');
            }
            else {
                writeFileSync(walPath, remaining.join('\n') + '\n');
            }
        }
        catch {
        }
    }
    walReplay().catch(() => { });
    async function fetchJSON(url, init) {
        const res = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...init.headers,
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`${res.status} ${res.statusText}: ${text}`);
        }
        return res.json();
    }
    async function findOpenByTag(tag) {
        const cached = openIssues.get(tag);
        if (cached)
            return cached;
        try {
            const data = (await fetchJSON(`${tasksUrl}/v1/tasks?status=created,todo,queued,in_progress,blocked,on_hold,started&tags=${encodeURIComponent(tag)}&limit=1`, { method: 'GET' }));
            const task = data.tasks?.[0];
            if (task) {
                const record = { id: task.id, status: task.status, version: task.version };
                openIssues.set(tag, record);
                return record;
            }
        }
        catch {
            try {
                const data = (await fetchJSON(`${tasksUrl}/v1/tasks?status=created,todo,queued,in_progress,blocked,on_hold,started&search=${encodeURIComponent(`[${tag}]`)}&limit=1`, { method: 'GET' }));
                const task = data.tasks?.[0];
                if (task) {
                    const record = { id: task.id, status: task.status, version: task.version };
                    openIssues.set(tag, record);
                    return record;
                }
            }
            catch {
            }
        }
        return null;
    }
    return {
        async createIssue(issueOpts) {
            const { tag, title, description, priority, tags = [], category, ttlMs } = issueOpts;
            const existing = await findOpenByTag(tag);
            if (existing) {
                log(`Issue [${tag}] already open (task ${existing.id}), skipping`, {
                    tag,
                    taskId: existing.id,
                });
                return null;
            }
            const ttl = ttlMs ?? defaultTtlMs;
            const now = Date.now();
            try {
                const data = (await fetchJSON(`${tasksUrl}/v1/intake`, {
                    method: 'POST',
                    body: JSON.stringify({
                        title: `[${tag}] ${title}`,
                        description: description ?? title,
                        priority: priority ?? defaultPriority,
                        source: service,
                        category: category ?? 'automated',
                        created_by: service,
                        tags: [tag, service, ...tags],
                        dedupe_tag: tag,
                        skip_decompose: true,
                        due_at: now + ttl,
                    }),
                }));
                if (data.deduplicated) {
                    log(`Issue [${tag}] deduplicated by intake`, { tag });
                    return null;
                }
                const taskId = data.id ?? data.task?.id;
                if (taskId) {
                    openIssues.set(tag, { id: taskId, status: 'created', version: 0 });
                    log(`Issue [${tag}] created → ${taskId}`, { tag, taskId, ttlMs: ttl });
                    return taskId;
                }
                return null;
            }
            catch (err) {
                log(`Failed to create issue [${tag}]: ${err.message} — writing to WAL`, { tag });
                walAppend({
                    action: 'create',
                    body: {
                        title: `[${tag}] ${title}`,
                        description: description ?? title,
                        priority: priority ?? defaultPriority,
                        source: service,
                        category: category ?? 'automated',
                        created_by: service,
                        tags: [tag, service, ...tags],
                        dedupe_tag: tag,
                        skip_decompose: true,
                        due_at: now + ttl,
                    },
                });
                return null;
            }
        },
        async resolveIssue(tag, reason) {
            const existing = await findOpenByTag(tag);
            if (!existing) {
                log(`No open issue for [${tag}], nothing to resolve`, { tag });
                openIssues.delete(tag);
                return false;
            }
            try {
                await fetchJSON(`${tasksUrl}/v1/tasks/${existing.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        status: 'done',
                        expected_status: existing.status,
                        expected_version: existing.version,
                        result_summary: `Auto-resolved by ${service}: ${reason}`,
                    }),
                });
                openIssues.delete(tag);
                log(`Issue [${tag}] resolved (task ${existing.id}): ${reason}`, {
                    tag,
                    taskId: existing.id,
                });
                return true;
            }
            catch (err) {
                log(`Failed to resolve issue [${tag}]: ${err.message} — writing to WAL`, {
                    tag,
                });
                walAppend({
                    action: 'resolve',
                    taskId: existing.id,
                    body: {
                        status: 'done',
                        result_summary: `Auto-resolved by ${service}: ${reason}`,
                    },
                });
                return false;
            }
        },
        async isOpen(tag) {
            const existing = await findOpenByTag(tag);
            return existing !== null;
        },
        getOpenIssues() {
            const map = new Map();
            for (const [tag, record] of openIssues) {
                map.set(tag, record.id);
            }
            return map;
        },
    };
}
