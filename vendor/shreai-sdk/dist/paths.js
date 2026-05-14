import { join, resolve } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
const isWindows = osPlatform() === 'win32';
export function getShreRoot() {
    if (process.env.SHRE_ROOT) {
        return resolve(process.env.SHRE_ROOT);
    }
    const isIsoLayer = process.env.SHRE_ISO_LAYER === 'true';
    if (isWindows) {
        const base = isIsoLayer
            ? process.env.ProgramData || 'C:\\ProgramData'
            : process.env.AppData || join(homedir(), 'AppData', 'Roaming');
        return join(base, 'shre');
    }
    else {
        if (isIsoLayer) {
            return '/var/lib/shre';
        }
        return join(homedir(), '.shre');
    }
}
export function getShrePath(...parts) {
    return join(getShreRoot(), ...parts);
}
export function getLogDir() {
    if (process.env.SHRE_LOG_DIR)
        return resolve(process.env.SHRE_LOG_DIR);
    if (isWindows) {
        return getShrePath('logs');
    }
    else if (osPlatform() === 'darwin') {
        return join(homedir(), 'Library', 'Logs', 'shre-services');
    }
    else {
        return '/var/log/shre';
    }
}
export const PATHS = {
    config: () => getShrePath('model-config.json'),
    ports: () => getShrePath('ports.json'),
    vault: () => getShrePath('vault'),
    tls: () => getShrePath('tls'),
    agents: () => getShrePath('agents'),
    backups: () => getShrePath('backups'),
};
