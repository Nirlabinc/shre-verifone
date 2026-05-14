import { createLogger } from './logger.js';
export function createPowerManager(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(`${serviceName}:power`);
    const idleThreshold = opts.idleThresholdMs ?? 60_000;
    const sleepThreshold = opts.sleepThresholdMs ?? 300_000;
    const checkInterval = opts.checkIntervalMs ?? 10_000;
    const neverSleep = opts.neverSleep ?? false;
    let _state = 'active';
    let _lastActivity = Date.now();
    let _timer = null;
    let _transitionCount = 0;
    const _startedAt = Date.now();
    let _totalIdleMs = 0;
    let _totalSleepMs = 0;
    let _totalActiveMs = 0;
    let _lastStateChangeAt = Date.now();
    function trackTime() {
        const now = Date.now();
        const elapsed = now - _lastStateChangeAt;
        switch (_state) {
            case 'active':
            case 'waking':
                _totalActiveMs += elapsed;
                break;
            case 'idle':
                _totalIdleMs += elapsed;
                break;
            case 'sleep':
                _totalSleepMs += elapsed;
                break;
        }
        _lastStateChangeAt = now;
    }
    async function transition(to) {
        if (_state === to)
            return;
        if (neverSleep && to === 'sleep') {
            log.debug('[power] Sleep blocked — neverSleep is set', { service: serviceName });
            return;
        }
        const from = _state;
        trackTime();
        _state = to;
        _transitionCount++;
        log.info('[power] State change', { service: serviceName, from, to });
        opts.onStateChange?.(from, to);
        try {
            switch (to) {
                case 'idle':
                    await opts.onIdle?.();
                    break;
                case 'sleep':
                    await opts.onSleep?.();
                    break;
                case 'waking':
                case 'active':
                    if (from === 'idle' || from === 'sleep') {
                        _state = 'waking';
                        await opts.onWake?.();
                        _state = 'active';
                    }
                    break;
            }
        }
        catch (err) {
            log.warn('[power] Transition callback failed', {
                from,
                to,
                error: err.message,
            });
        }
    }
    function check() {
        const idleTime = Date.now() - _lastActivity;
        if (_state === 'active' && idleTime >= idleThreshold) {
            transition('idle').catch(() => { });
        }
        else if (_state === 'idle' && idleTime >= sleepThreshold) {
            transition('sleep').catch(() => { });
        }
    }
    return {
        touch() {
            _lastActivity = Date.now();
            if (_state !== 'active') {
                transition('active').catch(() => { });
            }
        },
        state() {
            return _state;
        },
        idleMs() {
            return Date.now() - _lastActivity;
        },
        async wake() {
            _lastActivity = Date.now();
            if (_state !== 'active') {
                await transition('active');
            }
        },
        async forceSleep() {
            if (_state !== 'sleep') {
                await transition('sleep');
            }
        },
        start() {
            if (_timer)
                return;
            _timer = setInterval(check, checkInterval);
            log.info('[power] Power manager started', {
                service: serviceName,
                idleThreshold,
                sleepThreshold,
                neverSleep,
            });
        },
        stop() {
            if (_timer) {
                clearInterval(_timer);
                _timer = null;
            }
            trackTime();
        },
        stats() {
            const now = Date.now();
            const elapsed = now - _lastStateChangeAt;
            let activeMs = _totalActiveMs;
            let idleMs = _totalIdleMs;
            let sleepMs = _totalSleepMs;
            switch (_state) {
                case 'active':
                case 'waking':
                    activeMs += elapsed;
                    break;
                case 'idle':
                    idleMs += elapsed;
                    break;
                case 'sleep':
                    sleepMs += elapsed;
                    break;
            }
            return {
                currentState: _state,
                lastActivityAt: new Date(_lastActivity).toISOString(),
                idleMs: now - _lastActivity,
                totalIdleMs: idleMs,
                totalSleepMs: sleepMs,
                totalActiveMs: activeMs,
                transitionCount: _transitionCount,
                uptimeMs: now - _startedAt,
            };
        },
    };
}
export function createPowerMiddleware(pm) {
    return {
        touch: (_c, next) => {
            pm.touch();
            return next();
        },
    };
}
