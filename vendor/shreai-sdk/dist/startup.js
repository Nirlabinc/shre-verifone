import { createLogger } from './logger.js';
const log = createLogger('startup');
async function checkDependency(dep) {
    const timeout = dep.timeout ?? 5000;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        await fetch(dep.url, {
            signal: controller.signal,
            ...(dep.url.startsWith('https') ? {} : {}),
        });
        clearTimeout(timer);
        return true;
    }
    catch (err) {
        return false;
    }
}
export async function validateDependencies(deps, options = {}) {
    const { retries = 3, retryDelay = 2000, exitOnFail = true } = options;
    const result = { ok: true, passed: [], failed: [], warnings: [] };
    log.info('Validating startup dependencies', { count: deps.length });
    for (const dep of deps) {
        let reachable = false;
        for (let attempt = 1; attempt <= retries; attempt++) {
            reachable = await checkDependency(dep);
            if (reachable)
                break;
            if (attempt < retries) {
                log.warn(`${dep.name} unreachable, retry ${attempt}/${retries}...`);
                await new Promise((r) => setTimeout(r, retryDelay));
            }
        }
        if (reachable) {
            result.passed.push(dep.name);
            log.info(`✓ ${dep.name}`, { url: dep.url });
        }
        else if (dep.optional) {
            result.warnings.push(dep.name);
            log.warn(`⚠ ${dep.name} unreachable (optional, continuing)`, { url: dep.url });
        }
        else {
            result.failed.push(dep.name);
            result.ok = false;
            log.error(`✗ ${dep.name} unreachable after ${retries} attempts`, { url: dep.url });
        }
    }
    if (!result.ok) {
        const msg = `Startup failed: ${result.failed.join(', ')} unreachable`;
        log.error(msg);
        if (exitOnFail) {
            process.exit(1);
        }
    }
    else {
        log.info('All dependencies validated', {
            passed: result.passed.length,
            warnings: result.warnings.length,
        });
    }
    return result;
}
