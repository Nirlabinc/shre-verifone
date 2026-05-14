import * as os from 'node:os';
import * as dns from 'node:dns';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.js';
const log = createLogger('shre-sdk/infra-monitor');
const execFile = promisify(execFileCb);
const CMD_TIMEOUT_MS = 5_000;
const DEFAULT_THRESHOLDS = {
    ramWarnPct: 85,
    ramCriticalPct: 95,
    cpuWarnMultiplier: 1,
    cpuCriticalMultiplier: 2,
    diskWarnPct: 80,
    diskCriticalPct: 90,
    diskEmergencyPct: 95,
    inodeWarnPct: 80,
    inodeCriticalPct: 90,
    packetLossWarnPct: 5,
    packetLossCriticalPct: 20,
    dnsWarnMs: 500,
    dnsCriticalMs: 2000,
    zombieWarnCount: 5,
    zombieCriticalCount: 20,
    fdCriticalPct: 80,
};
async function safeExec(cmd, args, timeoutMs = CMD_TIMEOUT_MS) {
    try {
        const { stdout } = await execFile(cmd, args, { timeout: timeoutMs });
        return stdout;
    }
    catch (err) {
        log.warn('Shell command failed', { cmd, args, error: err.message });
        return null;
    }
}
function linearSlope(points) {
    const n = points.length;
    if (n < 2)
        return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-12)
        return 0;
    return (n * sumXY - sumX * sumY) / denom;
}
async function collectRam(thresholds) {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const usedPct = (usedBytes / totalBytes) * 100;
    let pressureLevel = 'normal';
    if (usedPct >= thresholds.ramCriticalPct)
        pressureLevel = 'critical';
    else if (usedPct >= thresholds.ramWarnPct)
        pressureLevel = 'warn';
    let swapUsedBytes = -1;
    const raw = await safeExec('sysctl', ['-n', 'vm.swapusage']);
    if (raw) {
        const usedMatch = raw.match(/used\s*=\s*([\d.]+)M/);
        if (usedMatch?.[1]) {
            swapUsedBytes = Math.round(parseFloat(usedMatch[1]) * 1024 * 1024);
        }
    }
    return {
        totalBytes,
        usedBytes,
        freeBytes,
        usedPct: Math.round(usedPct * 100) / 100,
        pressureLevel,
        swapUsedBytes,
    };
}
function collectCpu(thresholds) {
    const loadArr = os.loadavg();
    const loadAvg1 = loadArr[0] ?? 0;
    const loadAvg5 = loadArr[1] ?? 0;
    const loadAvg15 = loadArr[2] ?? 0;
    const coreCount = os.cpus().length;
    const usagePct = Math.min(100, Math.round((loadAvg1 / coreCount) * 100 * 100) / 100);
    let pressure = 'normal';
    if (loadAvg1 > coreCount * thresholds.cpuCriticalMultiplier)
        pressure = 'critical';
    else if (loadAvg1 > coreCount * thresholds.cpuWarnMultiplier)
        pressure = 'warn';
    return { loadAvg1, loadAvg5, loadAvg15, usagePct, coreCount, pressure };
}
async function collectDisk(volumes) {
    const results = [];
    const dfRaw = await safeExec('df', ['-k']);
    const diRaw = await safeExec('df', ['-i']);
    const spaceMap = new Map();
    if (dfRaw) {
        const lines = dfRaw.trim().split('\n').slice(1);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6)
                continue;
            const mountPoint = parts[parts.length - 1] ?? '';
            const total = parseInt(parts[1] ?? '0', 10) * 1024;
            const used = parseInt(parts[2] ?? '0', 10) * 1024;
            const avail = parseInt(parts[3] ?? '0', 10) * 1024;
            if (!isNaN(total) && total > 0 && mountPoint) {
                spaceMap.set(mountPoint, { total, used, avail });
            }
        }
    }
    const inodeMap = new Map();
    if (diRaw) {
        const lines = diRaw.trim().split('\n').slice(1);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 6)
                continue;
            const mountPoint = parts[parts.length - 1] ?? '';
            const pctCol = parts[parts.length - 2] ?? '';
            const pctMatch = pctCol.match(/([\d.]+)%/);
            if (pctMatch?.[1]) {
                inodeMap.set(mountPoint, parseFloat(pctMatch[1]));
            }
        }
    }
    for (const vol of volumes) {
        const space = spaceMap.get(vol);
        if (!space) {
            log.warn('Volume not found in df output', { volume: vol });
            continue;
        }
        const usedPct = space.total > 0 ? Math.round((space.used / space.total) * 100 * 100) / 100 : 0;
        const inodeUsedPct = inodeMap.get(vol) ?? -1;
        results.push({
            volume: vol,
            totalBytes: space.total,
            usedBytes: space.used,
            availableBytes: space.avail,
            usedPct,
            inodeUsedPct,
        });
    }
    return { volumes: results };
}
async function collectNetwork() {
    let packetLossPct = -1;
    const pingRaw = await safeExec('ping', ['-c', '3', '-W', '2', '8.8.8.8']);
    if (pingRaw) {
        const lossMatch = pingRaw.match(/([\d.]+)%\s+packet\s+loss/);
        if (lossMatch?.[1]) {
            packetLossPct = parseFloat(lossMatch[1]);
        }
    }
    let dnsResolutionMs = -1;
    try {
        const start = performance.now();
        await new Promise((resolve, reject) => {
            dns.resolve4('google.com', (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        dnsResolutionMs = Math.round((performance.now() - start) * 100) / 100;
    }
    catch {
        dnsResolutionMs = -1;
    }
    const gatewayReachable = packetLossPct >= 0 && packetLossPct < 100;
    return { packetLossPct, dnsResolutionMs, gatewayReachable };
}
async function collectProcesses() {
    let totalProcesses = 0;
    let zombieCount = 0;
    let openFileDescriptors = -1;
    let fdLimit = -1;
    const psRaw = await safeExec('ps', ['aux']);
    if (psRaw) {
        const lines = psRaw.trim().split('\n');
        totalProcesses = Math.max(0, lines.length - 1);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 7 && parts[7]?.startsWith('Z')) {
                zombieCount++;
            }
        }
    }
    const fdRaw = await safeExec('sysctl', ['-n', 'kern.num_files']);
    if (fdRaw) {
        const val = parseInt(fdRaw.trim(), 10);
        if (!isNaN(val))
            openFileDescriptors = val;
    }
    const fdMaxRaw = await safeExec('sysctl', ['-n', 'kern.maxfiles']);
    if (fdMaxRaw) {
        const val = parseInt(fdMaxRaw.trim(), 10);
        if (!isNaN(val))
            fdLimit = val;
    }
    const fdUsedPct = openFileDescriptors >= 0 && fdLimit > 0
        ? Math.round((openFileDescriptors / fdLimit) * 100 * 100) / 100
        : -1;
    return { totalProcesses, zombieCount, openFileDescriptors, fdLimit, fdUsedPct };
}
function generateAlerts(snap, thresholds) {
    const alerts = [];
    const now = snap.ts;
    const push = (category, metric, message, severity, value, threshold) => {
        alerts.push({ category, metric, message, severity, value, threshold, ts: now });
    };
    if (snap.ram.usedPct >= thresholds.ramCriticalPct) {
        push('ram', 'used_pct', `RAM usage critical at ${snap.ram.usedPct}%`, 'critical', snap.ram.usedPct, thresholds.ramCriticalPct);
    }
    else if (snap.ram.usedPct >= thresholds.ramWarnPct) {
        push('ram', 'used_pct', `RAM usage high at ${snap.ram.usedPct}%`, 'warn', snap.ram.usedPct, thresholds.ramWarnPct);
    }
    const cores = snap.cpu.coreCount;
    if (snap.cpu.loadAvg1 > cores * thresholds.cpuCriticalMultiplier) {
        push('cpu', 'load_avg_1', `Load avg ${snap.cpu.loadAvg1.toFixed(2)} exceeds ${cores * thresholds.cpuCriticalMultiplier}x cores`, 'critical', snap.cpu.loadAvg1, cores * thresholds.cpuCriticalMultiplier);
    }
    else if (snap.cpu.loadAvg1 > cores * thresholds.cpuWarnMultiplier) {
        push('cpu', 'load_avg_1', `Load avg ${snap.cpu.loadAvg1.toFixed(2)} exceeds core count (${cores})`, 'warn', snap.cpu.loadAvg1, cores * thresholds.cpuWarnMultiplier);
    }
    for (const vol of snap.disk.volumes) {
        if (vol.usedPct >= thresholds.diskEmergencyPct) {
            push('disk', `space_pct:${vol.volume}`, `Disk ${vol.volume} EMERGENCY at ${vol.usedPct}%`, 'emergency', vol.usedPct, thresholds.diskEmergencyPct);
        }
        else if (vol.usedPct >= thresholds.diskCriticalPct) {
            push('disk', `space_pct:${vol.volume}`, `Disk ${vol.volume} critical at ${vol.usedPct}%`, 'critical', vol.usedPct, thresholds.diskCriticalPct);
        }
        else if (vol.usedPct >= thresholds.diskWarnPct) {
            push('disk', `space_pct:${vol.volume}`, `Disk ${vol.volume} warning at ${vol.usedPct}%`, 'warn', vol.usedPct, thresholds.diskWarnPct);
        }
        if (vol.inodeUsedPct >= 0) {
            if (vol.inodeUsedPct >= thresholds.inodeCriticalPct) {
                push('disk', `inode_pct:${vol.volume}`, `Inodes ${vol.volume} critical at ${vol.inodeUsedPct}%`, 'critical', vol.inodeUsedPct, thresholds.inodeCriticalPct);
            }
            else if (vol.inodeUsedPct >= thresholds.inodeWarnPct) {
                push('disk', `inode_pct:${vol.volume}`, `Inodes ${vol.volume} warning at ${vol.inodeUsedPct}%`, 'warn', vol.inodeUsedPct, thresholds.inodeWarnPct);
            }
        }
    }
    if (snap.network.packetLossPct >= 0) {
        if (snap.network.packetLossPct >= thresholds.packetLossCriticalPct) {
            push('network', 'packet_loss', `Packet loss critical at ${snap.network.packetLossPct}%`, 'critical', snap.network.packetLossPct, thresholds.packetLossCriticalPct);
        }
        else if (snap.network.packetLossPct >= thresholds.packetLossWarnPct) {
            push('network', 'packet_loss', `Packet loss at ${snap.network.packetLossPct}%`, 'warn', snap.network.packetLossPct, thresholds.packetLossWarnPct);
        }
    }
    if (snap.network.dnsResolutionMs >= 0) {
        if (snap.network.dnsResolutionMs >= thresholds.dnsCriticalMs) {
            push('network', 'dns_resolution', `DNS resolution slow at ${snap.network.dnsResolutionMs}ms`, 'critical', snap.network.dnsResolutionMs, thresholds.dnsCriticalMs);
        }
        else if (snap.network.dnsResolutionMs >= thresholds.dnsWarnMs) {
            push('network', 'dns_resolution', `DNS resolution elevated at ${snap.network.dnsResolutionMs}ms`, 'warn', snap.network.dnsResolutionMs, thresholds.dnsWarnMs);
        }
    }
    if (!snap.network.gatewayReachable) {
        push('network', 'gateway', 'Default gateway unreachable', 'critical', 0, 1);
    }
    if (snap.process.zombieCount >= thresholds.zombieCriticalCount) {
        push('process', 'zombies', `${snap.process.zombieCount} zombie processes`, 'critical', snap.process.zombieCount, thresholds.zombieCriticalCount);
    }
    else if (snap.process.zombieCount >= thresholds.zombieWarnCount) {
        push('process', 'zombies', `${snap.process.zombieCount} zombie processes`, 'warn', snap.process.zombieCount, thresholds.zombieWarnCount);
    }
    if (snap.process.fdUsedPct >= 0 && snap.process.fdUsedPct >= thresholds.fdCriticalPct) {
        push('process', 'fd_usage', `File descriptor usage at ${snap.process.fdUsedPct}%`, 'critical', snap.process.fdUsedPct, thresholds.fdCriticalPct);
    }
    return alerts;
}
export function createInfraMonitor(serviceName, options = {}) {
    const maxSnapshots = options.maxSnapshots ?? 200;
    const maxDiskSamples = options.maxDiskSamples ?? 48;
    const volumes = options.volumes ?? ['/'];
    const publishFn = options.publishFn;
    const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    const snapshots = [];
    const diskHistory = new Map();
    let collectionTimer = null;
    function recordDiskSamples(disk) {
        const now = Date.now();
        for (const vol of disk.volumes) {
            let samples = diskHistory.get(vol.volume);
            if (!samples) {
                samples = [];
                diskHistory.set(vol.volume, samples);
            }
            samples.push({ ts: now, usedBytes: vol.usedBytes, totalBytes: vol.totalBytes });
            if (samples.length > maxDiskSamples) {
                samples.splice(0, samples.length - maxDiskSamples);
            }
        }
    }
    function publishAlerts(alerts) {
        if (!publishFn || alerts.length === 0)
            return;
        try {
            for (const alert of alerts) {
                publishFn('infra.alert', alert.severity, {
                    service: serviceName,
                    category: alert.category,
                    metric: alert.metric,
                    message: alert.message,
                    value: alert.value,
                    threshold: alert.threshold,
                    ts: alert.ts,
                });
            }
        }
        catch (err) {
            log.warn('Failed to publish infra alerts', { error: err.message });
        }
    }
    async function snapshot() {
        const start = performance.now();
        const ts = new Date().toISOString();
        const [ram, cpu, disk, network, process] = await Promise.all([
            collectRam(thresholds).catch((err) => {
                log.warn('RAM collection failed', { error: err.message });
                return {
                    totalBytes: os.totalmem(),
                    usedBytes: os.totalmem() - os.freemem(),
                    freeBytes: os.freemem(),
                    usedPct: 0,
                    pressureLevel: 'normal',
                    swapUsedBytes: -1,
                };
            }),
            Promise.resolve(collectCpu(thresholds)),
            collectDisk(volumes).catch((err) => {
                log.warn('Disk collection failed', { error: err.message });
                return { volumes: [] };
            }),
            collectNetwork().catch((err) => {
                log.warn('Network collection failed', { error: err.message });
                return { packetLossPct: -1, dnsResolutionMs: -1, gatewayReachable: false };
            }),
            collectProcesses().catch((err) => {
                log.warn('Process collection failed', { error: err.message });
                return {
                    totalProcesses: 0,
                    zombieCount: 0,
                    openFileDescriptors: -1,
                    fdLimit: -1,
                    fdUsedPct: -1,
                };
            }),
        ]);
        const partial = { ts, service: serviceName, ram, cpu, disk, network, process };
        const alerts = generateAlerts(partial, thresholds);
        const collectionMs = Math.round((performance.now() - start) * 100) / 100;
        const snap = { ...partial, alerts, collectionMs };
        snapshots.push(snap);
        if (snapshots.length > maxSnapshots) {
            snapshots.splice(0, snapshots.length - maxSnapshots);
        }
        recordDiskSamples(disk);
        publishAlerts(alerts);
        log.info('Infrastructure snapshot collected', {
            service: serviceName,
            collectionMs,
            alertCount: alerts.length,
            ramPct: ram.usedPct,
            cpuLoad1: cpu.loadAvg1,
            diskVolumes: disk.volumes.length,
        });
        return snap;
    }
    function getLatest() {
        return snapshots.length > 0 ? (snapshots[snapshots.length - 1] ?? null) : null;
    }
    function getHistory(limit) {
        const n = limit ?? snapshots.length;
        return snapshots.slice(-n);
    }
    function getAlerts() {
        const latest = getLatest();
        return latest?.alerts ?? [];
    }
    function predictDiskFull(volume = '/') {
        const samples = diskHistory.get(volume);
        if (!samples || samples.length < 2) {
            return { volume, daysUntilFull: -1, growthBytesPerDay: 0, sampleCount: samples?.length ?? 0 };
        }
        const recent = samples.slice(-24);
        const points = recent.map((s) => ({
            x: s.ts / 86_400_000,
            y: s.usedBytes,
        }));
        const slope = linearSlope(points);
        const lastSample = recent[recent.length - 1];
        const remainingBytes = lastSample.totalBytes - lastSample.usedBytes;
        let daysUntilFull = -1;
        if (slope > 0 && remainingBytes > 0) {
            daysUntilFull = Math.round((remainingBytes / slope) * 100) / 100;
        }
        return {
            volume,
            daysUntilFull,
            growthBytesPerDay: Math.round(slope),
            sampleCount: recent.length,
        };
    }
    function startPeriodicCollection(intervalMs = 60_000) {
        if (collectionTimer) {
            log.warn('Periodic collection already running, stopping previous timer');
            clearInterval(collectionTimer);
        }
        log.info('Starting periodic infra collection', { service: serviceName, intervalMs });
        snapshot().catch((err) => {
            log.error('Initial infra snapshot failed', { error: err.message });
        });
        collectionTimer = setInterval(() => {
            snapshot().catch((err) => {
                log.error('Periodic infra snapshot failed', { error: err.message });
            });
        }, intervalMs);
        if (collectionTimer && typeof collectionTimer === 'object' && 'unref' in collectionTimer) {
            collectionTimer.unref();
        }
    }
    function stop() {
        if (collectionTimer) {
            clearInterval(collectionTimer);
            collectionTimer = null;
            log.info('Stopped periodic infra collection', { service: serviceName });
        }
    }
    return {
        snapshot,
        getLatest,
        getHistory,
        getAlerts,
        predictDiskFull,
        startPeriodicCollection,
        stop,
    };
}
