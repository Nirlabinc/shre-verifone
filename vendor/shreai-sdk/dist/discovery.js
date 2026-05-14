import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname as osHostname } from 'node:os';
import { getShrePath } from './paths.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
function findPortsJson() {
    if (process.env.SHRE_PORTS_PATH)
        return process.env.SHRE_PORTS_PATH;
    const systemPath = getShrePath('ports.json');
    if (existsSync(systemPath))
        return systemPath;
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        const candidate = join(dir, 'ports.json');
        try {
            readFileSync(candidate, 'utf-8');
            return candidate;
        }
        catch (err) {
            dir = dirname(dir);
        }
    }
    dir = process.cwd();
    for (let i = 0; i < 5; i++) {
        const candidate = join(dir, 'ports.json');
        try {
            readFileSync(candidate, 'utf-8');
            return candidate;
        }
        catch (err) {
            dir = dirname(dir);
        }
    }
    throw new Error('ports.json not found — set SHRE_PORTS_PATH env var');
}
let _config = null;
let _configPath = null;
function loadPorts() {
    if (_config)
        return _config;
    _configPath = findPortsJson();
    const raw = readFileSync(_configPath, 'utf-8');
    _config = JSON.parse(raw);
    return _config;
}
export function reloadPorts() {
    _config = null;
    return loadPorts();
}
export function getPorts() {
    return loadPorts();
}
export function getService(name) {
    const ports = loadPorts();
    const entry = ports.services[name];
    if (!entry) {
        throw new Error(`Unknown service: "${name}" — check ports.json`);
    }
    return entry;
}
export function getInfra(name) {
    const ports = loadPorts();
    const entry = ports.infrastructure[name];
    if (!entry) {
        throw new Error(`Unknown infrastructure: "${name}" — check ports.json`);
    }
    return entry;
}
function resolveHost(name, entry) {
    const envKey = `SHRE_HOST_${name.toUpperCase().replace(/-/g, '_')}`;
    return (process.env[envKey] ||
        process.env.SHRE_NODE_HOST ||
        entry.host ||
        process.env.SHRE_STANDBY_HOST ||
        '127.0.0.1');
}
export function resolveAllHosts(name) {
    const ports = loadPorts();
    const entry = ports.services[name] || ports.infrastructure[name];
    if (!entry)
        return ['127.0.0.1'];
    const hosts = new Set();
    const envKey = `SHRE_HOST_${name.toUpperCase().replace(/-/g, '_')}`;
    if (process.env[envKey])
        hosts.add(process.env[envKey]);
    if (process.env.SHRE_NODE_HOST)
        hosts.add(process.env.SHRE_NODE_HOST);
    if (entry.host)
        hosts.add(entry.host);
    if (process.env.SHRE_STANDBY_HOST)
        hosts.add(process.env.SHRE_STANDBY_HOST);
    hosts.add('127.0.0.1');
    return Array.from(hosts);
}
export function serviceUrl(name) {
    const ports = loadPorts();
    let entry = ports.services[name];
    let isInfra = false;
    if (!entry) {
        entry = ports.infrastructure[name];
        isInfra = true;
    }
    if (!entry) {
        throw new Error(`Unknown service or infrastructure: "${name}" — check ports.json`);
    }
    const forceHttp = process.env.SHRE_FORCE_HTTP !== '0';
    const protocol = forceHttp ? 'http' : entry.protocol || (isInfra ? 'http' : 'http');
    const host = resolveHost(name, entry);
    return `${protocol}://${host}:${entry.port}`;
}
export function infraUrl(name) {
    return serviceUrl(name);
}
export function getNodeIdentity() {
    const hostname = osHostname();
    const host = process.env.SHRE_NODE_HOST || '127.0.0.1';
    const nodeId = process.env.SHRE_NODE_ID || `${hostname}-${process.pid}`;
    return { nodeId, hostname, host };
}
export function listServices() {
    return Object.keys(loadPorts().services);
}
export function listInfra() {
    return Object.keys(loadPorts().infrastructure);
}
