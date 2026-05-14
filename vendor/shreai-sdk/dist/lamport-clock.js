export function compareLamport(a, b) {
    if (a.lamport !== b.lamport)
        return a.lamport - b.lamport;
    return a.origin.localeCompare(b.origin);
}
export function happenedBefore(a, b) {
    return a.lamport < b.lamport;
}
export function sortByCausalOrder(events) {
    return [...events].sort((a, b) => {
        if (!a.lamportTs && !b.lamportTs)
            return 0;
        if (!a.lamportTs)
            return -1;
        if (!b.lamportTs)
            return 1;
        return compareLamport(a.lamportTs, b.lamportTs);
    });
}
export function createLamportClock(serviceId) {
    let _counter = 0;
    return {
        tick() {
            _counter++;
            return _counter;
        },
        receive(remoteTimestamp) {
            _counter = Math.max(_counter, remoteTimestamp) + 1;
            return _counter;
        },
        current() {
            return _counter;
        },
        serviceId() {
            return serviceId;
        },
        stamp() {
            _counter++;
            return {
                lamport: _counter,
                wall: new Date().toISOString(),
                origin: serviceId,
            };
        },
    };
}
