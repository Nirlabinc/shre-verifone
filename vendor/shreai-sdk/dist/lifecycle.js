import { createLogger } from './logger.js';
export function registerShutdown(server, opts) {
    const log = createLogger(opts.name);
    let shuttingDown = false;
    const forceTimeout = opts.timeout ?? 5000;
    const shutdown = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        log.info(`${signal} received, shutting down...`, { signal });
        try {
            if (opts.onShutdown)
                await opts.onShutdown();
        }
        catch (e) {
            log.error('cleanup error', {}, e);
        }
        server.close(() => {
            log.info('shutdown complete');
            process.exit(0);
        });
        setTimeout(() => {
            log.error(`forced shutdown after ${forceTimeout}ms`, { forceTimeout });
            process.exit(1);
        }, forceTimeout).unref();
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}
