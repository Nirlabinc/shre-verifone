import { homedir, platform, arch, hostname, cpus, totalmem, freemem } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';
const log = createLogger('shre-sdk:platform');
export function detectPlatform() {
    const os = mapPlatform(platform());
    const a = mapArch(arch());
    const tier = detectTier(os);
    const totalMem = Math.round(totalmem() / 1024 / 1024);
    return {
        os,
        arch: a,
        tier,
        hostname: hostname(),
        cpuCount: cpus().length,
        totalMemoryMB: totalMem,
        freeMemoryMB: Math.round(freemem() / 1024 / 1024),
        nodeVersion: process.version,
        kernelProbeSupport: getKernelProbeSupport(os),
        serviceManager: getServiceManager(os),
    };
}
function mapPlatform(p) {
    switch (p) {
        case 'darwin':
            return 'macos';
        case 'linux':
            if (process.env.ANDROID_ROOT || process.env.ANDROID_DATA)
                return 'android';
            return 'linux';
        case 'win32':
            return 'windows';
        default:
            return 'unknown';
    }
}
function mapArch(a) {
    switch (a) {
        case 'arm64':
            return 'arm64';
        case 'x64':
            return 'x64';
        case 'arm':
            return 'arm';
        default:
            return 'unknown';
    }
}
function detectTier(os) {
    if (os === 'android' || os === 'ios')
        return 'mobile';
    const totalMB = Math.round(totalmem() / 1024 / 1024);
    if (totalMB < 2048)
        return 'embedded';
    if (process.env.SSH_TTY || process.env.CONTAINER)
        return 'server';
    return 'desktop';
}
function getKernelProbeSupport(os) {
    switch (os) {
        case 'linux':
            return ['ebpf'];
        case 'macos':
            return ['dtrace'];
        case 'windows':
            return ['etw'];
        default:
            return [];
    }
}
function getServiceManager(os) {
    switch (os) {
        case 'macos':
            return 'launchd';
        case 'linux':
            return 'systemd';
        case 'windows':
            return 'windows-service';
        default:
            return 'none';
    }
}
export function getPlatformPaths(appName = 'shre') {
    const info = detectPlatform();
    const paths = resolvePaths(info.os, appName);
    for (const dir of Object.values(paths)) {
        try {
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
        }
        catch (err) {
            log.debug('[platform] Failed to create directory', { dir, error: err.message });
        }
    }
    return paths;
}
function resolvePaths(os, appName) {
    const home = homedir();
    switch (os) {
        case 'macos':
            return {
                config: join(home, `.${appName}`),
                data: join(home, `.${appName}`),
                cache: join(home, 'Library', 'Caches', appName),
                logs: join(home, 'Library', 'Logs', appName),
                runtime: join('/tmp', `${appName}-runtime`),
                services: join(home, 'Library', 'LaunchAgents'),
            };
        case 'linux':
            return {
                config: process.env.XDG_CONFIG_HOME
                    ? join(process.env.XDG_CONFIG_HOME, appName)
                    : join(home, '.config', appName),
                data: process.env.XDG_DATA_HOME
                    ? join(process.env.XDG_DATA_HOME, appName)
                    : join(home, '.local', 'share', appName),
                cache: process.env.XDG_CACHE_HOME
                    ? join(process.env.XDG_CACHE_HOME, appName)
                    : join(home, '.cache', appName),
                logs: join('/var', 'log', appName),
                runtime: process.env.XDG_RUNTIME_DIR
                    ? join(process.env.XDG_RUNTIME_DIR, appName)
                    : join('/tmp', `${appName}-runtime`),
                services: join('/etc', 'systemd', 'system'),
            };
        case 'windows':
            const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
            const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
            return {
                config: join(appData, appName),
                data: join(localAppData, appName, 'data'),
                cache: join(localAppData, appName, 'cache'),
                logs: join(localAppData, appName, 'logs'),
                runtime: join(localAppData, appName, 'runtime'),
                services: join(appData, appName, 'services'),
            };
        case 'android':
            const androidBase = process.env.ANDROID_DATA || '/data/data/ai.shre.app';
            return {
                config: join(androidBase, 'config'),
                data: join(androidBase, 'data'),
                cache: join(androidBase, 'cache'),
                logs: join(androidBase, 'logs'),
                runtime: join(androidBase, 'runtime'),
                services: join(androidBase, 'services'),
            };
        default:
            return {
                config: join(home, `.${appName}`),
                data: join(home, `.${appName}`, 'data'),
                cache: join(home, `.${appName}`, 'cache'),
                logs: join(home, `.${appName}`, 'logs'),
                runtime: join('/tmp', `${appName}-runtime`),
                services: join(home, `.${appName}`, 'services'),
            };
    }
}
export function createServiceManager() {
    const info = detectPlatform();
    switch (info.serviceManager) {
        case 'launchd':
            return createLaunchdManager();
        case 'systemd':
            return createSystemdManager();
        case 'windows-service':
            return createWindowsServiceManager();
        default:
            return createNoopManager();
    }
}
function createLaunchdManager() {
    const { writeFileSync } = require('node:fs');
    const { execSync } = require('node:child_process');
    const paths = getPlatformPaths();
    return {
        async install(def) {
            const content = generateLaunchdPlist(def);
            const path = join(paths.services, `ai.shre.${def.name}.plist`);
            writeFileSync(path, content);
            return { path, content };
        },
        generate(def) {
            return generateLaunchdPlist(def);
        },
        async start(name) {
            const path = join(paths.services, `ai.shre.${name}.plist`);
            execSync(`launchctl load -w "${path}"`, { stdio: 'ignore' });
        },
        async stop(name) {
            const path = join(paths.services, `ai.shre.${name}.plist`);
            try {
                execSync(`launchctl unload "${path}"`, { stdio: 'ignore' });
            }
            catch (err) {
                log.debug('[platform] launchctl unload failed (may already be unloaded)', {
                    error: err.message,
                });
            }
        },
        async status(name) {
            try {
                const output = execSync(`launchctl list ai.shre.${name} 2>/dev/null`, {
                    encoding: 'utf-8',
                });
                return output.includes('PID') ? 'running' : 'stopped';
            }
            catch (err) {
                log.debug('[platform] launchctl status check failed', { error: err.message });
                return 'unknown';
            }
        },
    };
}
function generateLaunchdPlist(def) {
    const envEntries = def.env
        ? Object.entries(def.env)
            .map(([k, v]) => `      <key>${k}</key>\n      <string>${escapeXml(v)}</string>`)
            .join('\n')
        : '';
    const envSection = envEntries
        ? `    <key>EnvironmentVariables</key>\n    <dict>\n${envEntries}\n    </dict>`
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.shre.${def.name}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(def.command)}</string>
${(def.args ?? []).map((a) => `        <string>${escapeXml(a)}</string>`).join('\n')}
    </array>
${def.cwd ? `    <key>WorkingDirectory</key>\n    <string>${escapeXml(def.cwd)}</string>` : ''}
${envSection}
    <key>RunAtLoad</key>
    <${def.startOnBoot !== false}/>
    <key>KeepAlive</key>
    <${def.restartOnFailure !== false}/>
    <key>StandardOutPath</key>
    <string>${homedir()}/Library/Logs/shre/${def.name}.log</string>
    <key>StandardErrorPath</key>
    <string>${homedir()}/Library/Logs/shre/${def.name}.err</string>
</dict>
</plist>`;
}
function createSystemdManager() {
    const { writeFileSync } = require('node:fs');
    const { execSync } = require('node:child_process');
    const home = homedir();
    const isRoot = process.getuid?.() === 0;
    const unitDir = isRoot ? '/etc/systemd/system' : join(home, '.config', 'systemd', 'user');
    return {
        async install(def) {
            const content = generateSystemdUnit(def);
            const path = join(unitDir, `shre-${def.name}.service`);
            try {
                mkdirSync(unitDir, { recursive: true });
            }
            catch (err) {
                log.debug('[platform] Failed to create systemd unit dir', {
                    error: err.message,
                });
            }
            writeFileSync(path, content);
            const cmd = isRoot ? 'systemctl daemon-reload' : 'systemctl --user daemon-reload';
            execSync(cmd, { stdio: 'ignore' });
            return { path, content };
        },
        generate(def) {
            return generateSystemdUnit(def);
        },
        async start(name) {
            const flag = isRoot ? '' : '--user ';
            execSync(`systemctl ${flag}start shre-${name}`, { stdio: 'ignore' });
        },
        async stop(name) {
            const flag = isRoot ? '' : '--user ';
            try {
                execSync(`systemctl ${flag}stop shre-${name}`, { stdio: 'ignore' });
            }
            catch (err) {
                log.debug('[platform] systemctl stop failed (may already be stopped)', {
                    error: err.message,
                });
            }
        },
        async status(name) {
            const flag = isRoot ? '' : '--user ';
            try {
                const output = execSync(`systemctl ${flag}is-active shre-${name}`, {
                    encoding: 'utf-8',
                }).trim();
                return output === 'active' ? 'running' : 'stopped';
            }
            catch (err) {
                log.debug('[platform] systemctl status check failed', { error: err.message });
                return 'unknown';
            }
        },
    };
}
function generateSystemdUnit(def) {
    const envLines = def.env
        ? Object.entries(def.env)
            .map(([k, v]) => `Environment=${k}=${v}`)
            .join('\n')
        : '';
    const args = def.args ? ' ' + def.args.join(' ') : '';
    return `[Unit]
Description=Shre AI - ${def.displayName}
After=network.target

[Service]
Type=simple
ExecStart=${def.command}${args}
${def.cwd ? `WorkingDirectory=${def.cwd}` : ''}
${envLines}
Restart=${def.restartOnFailure !== false ? 'on-failure' : 'no'}
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=shre-${def.name}

[Install]
WantedBy=${def.startOnBoot !== false ? 'default.target' : ''}
`;
}
function createWindowsServiceManager() {
    return {
        async install(def) {
            const content = generateWindowsBatch(def);
            const path = join(getPlatformPaths().services, `shre-${def.name}.bat`);
            const { writeFileSync } = require('node:fs');
            writeFileSync(path, content);
            return { path, content };
        },
        generate(def) {
            return generateWindowsBatch(def);
        },
        async start(name) {
            const { execSync } = require('node:child_process');
            try {
                execSync(`sc start shre-${name}`, { stdio: 'ignore' });
            }
            catch (err) {
                log.warn('Windows service start requires elevated privileges', {
                    name,
                    error: err.message,
                });
            }
        },
        async stop(name) {
            const { execSync } = require('node:child_process');
            try {
                execSync(`sc stop shre-${name}`, { stdio: 'ignore' });
            }
            catch (err) {
                log.debug('[platform] Windows service stop failed', { error: err.message });
            }
        },
        async status(name) {
            try {
                const { execSync } = require('node:child_process');
                const output = execSync(`sc query shre-${name}`, { encoding: 'utf-8' });
                return output.includes('RUNNING') ? 'running' : 'stopped';
            }
            catch (err) {
                log.debug('[platform] Windows service status check failed', {
                    error: err.message,
                });
                return 'unknown';
            }
        },
    };
}
function generateWindowsBatch(def) {
    const envLines = def.env
        ? Object.entries(def.env)
            .map(([k, v]) => `set ${k}=${v}`)
            .join('\r\n')
        : '';
    const args = def.args ? ' ' + def.args.join(' ') : '';
    return `@echo off
REM Shre AI - ${def.displayName}
${def.cwd ? `cd /d "${def.cwd}"` : ''}
${envLines}
"${def.command}"${args}
`;
}
function createNoopManager() {
    return {
        async install(_def) {
            log.warn('Service management not supported on this platform');
            return { path: '', content: '' };
        },
        generate() {
            return '';
        },
        async start() {
            log.warn('Service start not supported');
        },
        async stop() {
            log.warn('Service stop not supported');
        },
        async status() {
            return 'unknown';
        },
    };
}
export function assessHardware() {
    const totalMB = Math.round(totalmem() / 1024 / 1024);
    const cpuCount = cpus().length;
    const warnings = [];
    const gpu = process.env.CUDA_VISIBLE_DEVICES
        ? `CUDA (devices: ${process.env.CUDA_VISIBLE_DEVICES})`
        : process.env.METAL_DEVICE_WRAPPER_TYPE
            ? 'Apple Metal'
            : null;
    let recommendedTier;
    let canRunCortexDB;
    let canRunLocalLLM;
    let maxConcurrentTasks;
    if (totalMB < 2048) {
        recommendedTier = 'lite';
        canRunCortexDB = false;
        canRunLocalLLM = false;
        maxConcurrentTasks = 1;
        warnings.push('Very low memory — use SHRE_TIER=lite (in-memory storage only)');
    }
    else if (totalMB < 8192) {
        recommendedTier = 'standard';
        canRunCortexDB = totalMB >= 4096;
        canRunLocalLLM = totalMB >= 4096 && (gpu !== null || cpuCount >= 4);
        maxConcurrentTasks = Math.min(cpuCount, 3);
        if (totalMB < 4096) {
            warnings.push('CortexDB needs 2.5GB+ — consider external CortexDB or lite tier');
        }
    }
    else {
        recommendedTier = 'full';
        canRunCortexDB = true;
        canRunLocalLLM = true;
        maxConcurrentTasks = Math.min(cpuCount, 8);
    }
    if (cpuCount < 2) {
        warnings.push('Single-core CPU — performance will be limited');
    }
    return {
        recommendedTier,
        canRunCortexDB,
        canRunLocalLLM,
        maxConcurrentTasks,
        gpu,
        warnings,
    };
}
export function createKernelProbe(type) {
    const info = detectPlatform();
    if (!info.kernelProbeSupport.includes(type)) {
        log.warn(`Kernel probe type '${type}' not supported on ${info.os}`);
    }
    let isActive = false;
    return {
        type,
        async attach(program) {
            log.info(`[kernel-probe] Would attach ${type} program: ${program.slice(0, 100)}`);
            log.warn(`[kernel-probe] Native ${type} extension not yet loaded — stub mode`);
            isActive = true;
        },
        async detach() {
            isActive = false;
            log.info(`[kernel-probe] Detached ${type} probe`);
        },
        active() {
            return isActive;
        },
    };
}
function escapeXml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
