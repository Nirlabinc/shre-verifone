import { createLogger } from './logger.js';
export function createHookRegistry(config = {}) {
    const log = config.logger ?? createLogger('hooks');
    const registry = new Map();
    function define(name) {
        if (registry.has(name))
            return registry.get(name);
        const beforeHandlers = [];
        const afterHandlers = [];
        let nextId = 0;
        function getList(phase) {
            return phase === 'before' ? beforeHandlers : afterHandlers;
        }
        function tap(phase, handler, priority = 100) {
            const id = nextId++;
            const list = getList(phase);
            list.push({ handler, priority, id });
            list.sort((a, b) => a.priority - b.priority || a.id - b.id);
            return () => {
                const idx = list.findIndex((e) => e.id === id);
                if (idx >= 0)
                    list.splice(idx, 1);
            };
        }
        async function run(phase, ctx) {
            const list = getList(phase);
            let current = ctx;
            for (const entry of list) {
                try {
                    current = await entry.handler(current);
                }
                catch (err) {
                    log.warn(`[hooks] Handler error in "${name}" ${phase}`, {
                        error: err.message,
                    });
                }
            }
            return current;
        }
        function size() {
            return beforeHandlers.length + afterHandlers.length;
        }
        const point = { tap, run, size };
        registry.set(name, point);
        return point;
    }
    function get(name) {
        return registry.get(name);
    }
    function list() {
        return Array.from(registry.keys());
    }
    return { define, get, list };
}
