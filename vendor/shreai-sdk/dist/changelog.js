import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from './logger.js';
const TYPE_LABELS = {
    feature: 'Added',
    fix: 'Fixed',
    refactor: 'Changed',
    docs: 'Docs',
    test: 'Tests',
    security: 'Security',
    performance: 'Performance',
    architecture: 'Architecture',
    deprecation: 'Deprecated',
    breaking: 'BREAKING',
};
function findRepoRoot() {
    let dir = process.cwd();
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, 'ports.json')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return process.cwd();
}
function formatMarkdownEntry(record) {
    const tag = TYPE_LABELS[record.type] || record.type;
    const agentTag = `\`${record.agent}\``;
    const taskRef = record.taskId ? ` (${record.taskId.slice(0, 8)})` : '';
    const files = record.filesChanged?.length
        ? `\n  - Files: ${record.filesChanged.map((f) => `\`${f}\``).join(', ')}`
        : '';
    const breaking = record.breaking ? `\n  - **BREAKING:** ${record.breaking}` : '';
    const arch = record.architectureNotes
        ? `\n  - **Architecture:** ${record.architectureNotes}`
        : '';
    const knowledge = record.knowledgeLearned ? `\n  - **Learned:** ${record.knowledgeLearned}` : '';
    return `- **[${tag}]** ${record.title} — ${agentTag}${taskRef}\n  ${record.summary}${files}${breaking}${arch}${knowledge}`;
}
function getDateHeader(date) {
    return `## ${date}`;
}
export function createChangelogWriter(serviceName, options = {}) {
    const log = options.logger ?? createLogger('changelog');
    const repoRoot = options.repoRoot ?? findRepoRoot();
    const maxBuffer = options.maxBuffer ?? 200;
    const writeFiles = options.writeFiles ?? true;
    const buffer = [];
    async function record(entry) {
        const record = {
            ...entry,
            timestamp: new Date().toISOString(),
            source: serviceName,
        };
        buffer.unshift(record);
        if (buffer.length > maxBuffer)
            buffer.pop();
        if (writeFiles) {
            writeToServiceChangelog(record);
            writeToGlobalChangelog(record);
        }
        if (options.cortexWrite) {
            options
                .cortexWrite('changelog_entry', {
                agent: record.agent,
                task_id: record.taskId,
                title: record.title,
                type: record.type,
                summary: record.summary,
                service: record.service ?? serviceName,
                files_changed: record.filesChanged?.join(',') ?? '',
                model: record.model ?? '',
                quality: record.quality ?? null,
                duration_ms: record.durationMs ?? null,
                breaking: record.breaking ?? null,
                architecture_notes: record.architectureNotes ?? null,
                knowledge_learned: record.knowledgeLearned ?? null,
                timestamp: record.timestamp,
                source: record.source,
            })
                .catch((err) => log.debug('CortexDB changelog write failed', { error: String(err) }));
        }
        if (options.publishFn) {
            const severity = record.type === 'breaking' || record.type === 'security' ? 'warn' : 'info';
            options
                .publishFn('changelog.entry', severity, {
                agent: record.agent,
                taskId: record.taskId,
                title: record.title,
                type: record.type,
                summary: record.summary,
                service: record.service ?? serviceName,
                filesChanged: record.filesChanged,
                timestamp: record.timestamp,
            })
                .catch((err) => log.debug('Event publish failed for changelog', { error: String(err) }));
        }
        log.info(`[changelog] ${TYPE_LABELS[record.type]}: ${record.title}`, {
            agent: record.agent,
            service: record.service,
            type: record.type,
            taskId: record.taskId?.slice(0, 8),
        });
    }
    function writeToServiceChangelog(record) {
        const serviceDir = record.service ?? serviceName;
        const changelogPath = join(repoRoot, serviceDir, 'CHANGELOG.md');
        try {
            const today = record.timestamp.slice(0, 10);
            const entry = formatMarkdownEntry(record);
            let content;
            if (existsSync(changelogPath)) {
                const existing = readFileSync(changelogPath, 'utf-8');
                const dateHeader = getDateHeader(today);
                if (existing.includes(dateHeader)) {
                    content = existing.replace(dateHeader, `${dateHeader}\n\n${entry}`);
                }
                else {
                    const titleEnd = existing.indexOf('\n');
                    if (titleEnd > 0) {
                        content =
                            existing.slice(0, titleEnd + 1) +
                                `\n${dateHeader}\n\n${entry}\n` +
                                existing.slice(titleEnd + 1);
                    }
                    else {
                        content = existing + `\n\n${dateHeader}\n\n${entry}\n`;
                    }
                }
            }
            else {
                mkdirSync(dirname(changelogPath), { recursive: true });
                content = `# ${serviceDir} Changelog\n\n${getDateHeader(today)}\n\n${entry}\n`;
            }
            writeFileSync(changelogPath, content);
        }
        catch (err) {
            log.debug('Failed to write service changelog', {
                path: changelogPath,
                error: String(err),
            });
        }
    }
    function writeToGlobalChangelog(record) {
        const globalPath = join(repoRoot, 'CHANGELOG.md');
        try {
            const today = record.timestamp.slice(0, 10);
            const serviceTag = record.service ? `**${record.service}** — ` : '';
            const entry = `- ${serviceTag}${formatMarkdownEntry(record).slice(2)}`;
            let content;
            if (existsSync(globalPath)) {
                const existing = readFileSync(globalPath, 'utf-8');
                const dateHeader = getDateHeader(today);
                if (existing.includes(dateHeader)) {
                    content = existing.replace(dateHeader, `${dateHeader}\n\n${entry}`);
                }
                else {
                    const titleEnd = existing.indexOf('\n');
                    if (titleEnd > 0) {
                        content =
                            existing.slice(0, titleEnd + 1) +
                                `\n${dateHeader}\n\n${entry}\n` +
                                existing.slice(titleEnd + 1);
                    }
                    else {
                        content = existing + `\n\n${dateHeader}\n\n${entry}\n`;
                    }
                }
            }
            else {
                content = `# Shre AI Platform Changelog\n\n${getDateHeader(today)}\n\n${entry}\n`;
            }
            writeFileSync(globalPath, content);
        }
        catch (err) {
            log.debug('Failed to write global changelog', { error: String(err) });
        }
    }
    function getRecent(limit = 50) {
        return buffer.slice(0, limit);
    }
    function getByService(service, limit = 50) {
        return buffer.filter((r) => r.service === service).slice(0, limit);
    }
    function getByAgent(agent, limit = 50) {
        return buffer.filter((r) => r.agent === agent).slice(0, limit);
    }
    return { record, getRecent, getByService, getByAgent };
}
export function createAuditWriter(service, opts) {
    const log = opts.logger ?? createLogger(`${service}:audit`);
    const patterns = opts.patterns ?? [
        '*.completed',
        '*.created',
        '*.updated',
        '*.deleted',
        '*.failed',
        '*.started',
        '*.rejected',
    ];
    const maxBuffer = opts.maxBuffer ?? 1000;
    const buffer = [];
    const unsubscribers = [];
    function addEntry(entry) {
        buffer.unshift(entry);
        if (buffer.length > maxBuffer) {
            buffer.length = maxBuffer;
        }
        if (opts.cortexWrite) {
            opts.cortexWrite('audit_trail', entry).catch((err) => {
                log.warn('Audit trail CortexDB write failed', { error: err.message });
            });
        }
    }
    function start() {
        for (const pattern of patterns) {
            const unsub = opts.subscribeFn(pattern, async (event) => {
                addEntry({
                    timestamp: event.ts ?? new Date().toISOString(),
                    eventType: event.type,
                    source: event.source ?? service,
                    data: event.data ?? {},
                    correlationId: event.correlationId,
                });
            });
            unsubscribers.push(unsub);
        }
        log.info('Audit writer started', { patterns: patterns.length });
    }
    function stop() {
        for (const unsub of unsubscribers) {
            unsub();
        }
        unsubscribers.length = 0;
        log.info('Audit writer stopped');
    }
    function record(entry) {
        addEntry({ ...entry, timestamp: new Date().toISOString() });
    }
    function query(filter) {
        let results = buffer;
        if (filter?.service) {
            results = results.filter((e) => e.source === filter.service);
        }
        if (filter?.eventType) {
            results = results.filter((e) => e.eventType === filter.eventType);
        }
        if (filter?.since) {
            results = results.filter((e) => e.timestamp >= filter.since);
        }
        return results.slice(0, filter?.limit ?? 100);
    }
    return { start, stop, record, query };
}
