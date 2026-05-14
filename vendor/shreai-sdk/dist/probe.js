import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createLogger } from './logger.js';
import { detectPlatform } from './platform.js';
const log = createLogger('shre-sdk:probe');
export function createNetworkProbe() {
    const info = detectPlatform();
    return {
        connections() {
            return parseNetstat(info.os, false);
        },
        listeners() {
            return parseNetstat(info.os, true);
        },
        isPortInUse(port) {
            const listeners = this.listeners();
            return listeners.some((l) => l.localPort === port);
        },
        whosOnPort(port) {
            try {
                if (info.os === 'macos' || info.os === 'linux') {
                    const output = execSync(`lsof -i :${port} -P -n 2>/dev/null || true`, {
                        encoding: 'utf-8',
                        timeout: 5000,
                    });
                    const lines = output.trim().split('\n').slice(1);
                    if (lines.length === 0 || !lines[0])
                        return null;
                    const parts = lines[0].split(/\s+/);
                    return { process: parts[0] ?? 'unknown', pid: parseInt(parts[1] ?? '') || 0 };
                }
                return null;
            }
            catch (err) {
                return null;
            }
        },
    };
}
function parseNetstat(os, listenersOnly) {
    try {
        let cmd;
        if (os === 'macos') {
            cmd = listenersOnly
                ? 'netstat -an -p tcp 2>/dev/null | grep LISTEN'
                : "netstat -an -p tcp 2>/dev/null | grep -v 'CLOSED'";
        }
        else if (os === 'linux') {
            cmd = listenersOnly ? 'ss -tlnp 2>/dev/null' : 'ss -tnp 2>/dev/null';
        }
        else if (os === 'windows') {
            cmd = listenersOnly ? 'netstat -an -p TCP | findstr "LISTENING"' : 'netstat -an -p TCP';
        }
        else {
            return [];
        }
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
        return parseNetstatOutput(output, os);
    }
    catch (err) {
        return [];
    }
}
function parseNetstatOutput(output, os) {
    const connections = [];
    const lines = output.trim().split('\n');
    for (const line of lines) {
        try {
            if (os === 'macos' || os === 'windows') {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4)
                    continue;
                const proto = (parts[0] ?? '').toLowerCase();
                if (proto !== 'tcp' && proto !== 'tcp4' && proto !== 'tcp6')
                    continue;
                const local = parseAddress(parts[3] ?? '');
                const remote = parseAddress(parts[4] ?? '');
                const state = parts[5] ?? 'UNKNOWN';
                if (local) {
                    connections.push({
                        protocol: 'tcp',
                        localAddress: local.address,
                        localPort: local.port,
                        remoteAddress: remote?.address || '*',
                        remotePort: remote?.port || 0,
                        state,
                    });
                }
            }
            else if (os === 'linux') {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 5)
                    continue;
                if (parts[0] === 'State')
                    continue;
                const local = parseAddress(parts[3] ?? '');
                const remote = parseAddress(parts[4] ?? '');
                if (local) {
                    let pid;
                    let processName;
                    const procMatch = line.match(/pid=(\d+)/);
                    const nameMatch = line.match(/users:\(\("([^"]+)"/);
                    if (procMatch?.[1])
                        pid = parseInt(procMatch[1]);
                    if (nameMatch?.[1])
                        processName = nameMatch[1];
                    connections.push({
                        protocol: 'tcp',
                        localAddress: local.address,
                        localPort: local.port,
                        remoteAddress: remote?.address || '*',
                        remotePort: remote?.port || 0,
                        state: parts[0] ?? 'UNKNOWN',
                        pid,
                        process: processName,
                    });
                }
            }
        }
        catch (err) {
            continue;
        }
    }
    return connections;
}
function parseAddress(addr) {
    if (!addr || addr === '*.*' || addr === '*:*')
        return null;
    const ipv6Match = addr.match(/\[(.+)\]:(\d+)/);
    if (ipv6Match) {
        return { address: ipv6Match[1], port: parseInt(ipv6Match[2]) };
    }
    const lastDot = addr.lastIndexOf('.');
    const lastColon = addr.lastIndexOf(':');
    if (lastColon > 0) {
        return {
            address: addr.slice(0, lastColon),
            port: parseInt(addr.slice(lastColon + 1)) || 0,
        };
    }
    if (lastDot > 0) {
        const port = parseInt(addr.slice(lastDot + 1));
        if (!isNaN(port)) {
            return { address: addr.slice(0, lastDot), port };
        }
    }
    return null;
}
export function createPortScanner(opts = {}) {
    const timeout = opts.timeoutMs ?? 1000;
    const concurrency = opts.concurrency ?? 50;
    return {
        async scanPort(host, port) {
            const start = Date.now();
            return new Promise((resolve) => {
                const socket = createConnection({ host, port, timeout }, () => {
                    socket.destroy();
                    resolve({
                        port,
                        open: true,
                        service: COMMON_PORTS.get(port),
                        responseTimeMs: Date.now() - start,
                    });
                });
                socket.on('error', () => {
                    resolve({
                        port,
                        open: false,
                        responseTimeMs: Date.now() - start,
                    });
                });
                socket.on('timeout', () => {
                    socket.destroy();
                    resolve({
                        port,
                        open: false,
                        responseTimeMs: Date.now() - start,
                    });
                });
            });
        },
        async scanRange(host, startPort, endPort) {
            const ports = [];
            for (let p = startPort; p <= endPort; p++)
                ports.push(p);
            return this.scanPorts(host, ports);
        },
        async scanPorts(host, ports) {
            const results = [];
            const chunks = [];
            for (let i = 0; i < ports.length; i += concurrency) {
                chunks.push(ports.slice(i, i + concurrency));
            }
            for (const chunk of chunks) {
                const batch = await Promise.all(chunk.map((port) => this.scanPort(host, port)));
                results.push(...batch);
            }
            return results;
        },
        async scanCommon(host) {
            return this.scanPorts(host, Array.from(COMMON_PORTS.keys()));
        },
        async scanShreServices(host = '127.0.0.1') {
            return this.scanRange(host, 5400, 5610);
        },
    };
}
const COMMON_PORTS = new Map([
    [22, 'ssh'],
    [53, 'dns'],
    [80, 'http'],
    [443, 'https'],
    [3000, 'dev-server'],
    [3306, 'mysql'],
    [5432, 'postgresql'],
    [5433, 'postgresql-alt'],
    [6333, 'qdrant'],
    [6379, 'redis'],
    [8080, 'http-alt'],
    [8443, 'https-alt'],
    [9090, 'prometheus'],
    [11434, 'ollama'],
    [18789, 'legacy-gateway'],
    [5400, 'cortexservice'],
    [5402, 'shre-hr'],
    [5409, 'shre-executor'],
    [5412, 'shre-registry'],
    [5450, 'cortex-bridge'],
    [5455, 'shre-auth'],
    [5460, 'shre-tasks'],
    [5470, 'shre-traffic'],
    [5471, 'shre-gateway-guard'],
    [5475, 'shre-chronicle'],
    [5480, 'shre-contacts'],
    [5485, 'shre-health'],
    [5486, 'shre-monitor'],
    [5490, 'shre-skills'],
    [5491, 'shre-scorer'],
    [5492, 'shre-radar'],
    [5493, 'shre-passport'],
    [5495, 'shre-meter'],
    [5497, 'shre-router'],
    [5498, 'shre-fleet'],
    [5500, 'mib-desktop'],
    [5510, 'shre-chat'],
    [5520, 'mib007'],
]);
export function createProcessProbe() {
    const info = detectPlatform();
    function parseProcessList(nameFilter) {
        try {
            const cmd = info.os === 'linux' ? 'ps aux --no-headers 2>/dev/null' : 'ps aux 2>/dev/null';
            const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
            const lines = output.trim().split('\n');
            const processes = [];
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 11)
                    continue;
                const user = parts[0] ?? '';
                const pid = parseInt(parts[1] ?? '');
                const cpu = parseFloat(parts[2] ?? '');
                const rssKB = parseInt(parts[5] ?? '') || 0;
                const startTime = parts[8] ?? '';
                const command = parts.slice(10).join(' ');
                const name = command.split('/').pop()?.split(' ')[0] ?? command;
                if (isNaN(pid))
                    continue;
                if (nameFilter &&
                    !name.toLowerCase().includes(nameFilter.toLowerCase()) &&
                    !command.toLowerCase().includes(nameFilter.toLowerCase())) {
                    continue;
                }
                processes.push({
                    pid,
                    ppid: 0,
                    name,
                    command,
                    user,
                    cpuPercent: cpu,
                    memoryMB: Math.round(rssKB / 1024),
                    startTime,
                });
            }
            return processes;
        }
        catch (err) {
            return [];
        }
    }
    return {
        list(nameFilter) {
            return parseProcessList(nameFilter);
        },
        get(pid) {
            const all = parseProcessList();
            return all.find((p) => p.pid === pid) || null;
        },
        shreProcesses() {
            return parseProcessList('shre')
                .concat(parseProcessList('mib'), parseProcessList('cortex'))
                .filter((p, i, arr) => arr.findIndex((q) => q.pid === p.pid) === i);
        },
        resources() {
            const { loadavg, totalmem, freemem } = require('node:os');
            const totalMB = Math.round(totalmem() / 1024 / 1024);
            const freeMB = Math.round(freemem() / 1024 / 1024);
            const load = loadavg();
            const { cpus: getCpus } = require('node:os');
            const cpuCount = getCpus().length;
            const cpuUsage = Math.min(100, Math.round((load[0] / cpuCount) * 100));
            return {
                cpuUsagePercent: cpuUsage,
                memoryUsedMB: totalMB - freeMB,
                memoryTotalMB: totalMB,
                loadAvg: load,
            };
        },
    };
}
export function createFileWatcher() {
    let watcher = null;
    let isActive = false;
    return {
        watch(dirPath, handler) {
            const { watch, existsSync } = require('node:fs');
            if (!existsSync(dirPath)) {
                log.warn('Directory does not exist', { path: dirPath });
                return;
            }
            watcher = watch(dirPath, { recursive: true }, (eventType, filename) => {
                if (!filename)
                    return;
                const { join } = require('node:path');
                handler({
                    type: eventType === 'rename' ? 'rename' : 'modify',
                    path: join(dirPath, filename),
                    timestamp: Date.now(),
                });
            });
            isActive = true;
            log.info('File watcher started', { path: dirPath });
        },
        stop() {
            if (watcher) {
                watcher.close();
                watcher = null;
            }
            isActive = false;
        },
        active() {
            return isActive;
        },
    };
}
