import { vi } from 'vitest';
export function mockFetch(data, status = 200) {
    return vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 400,
        status,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
    });
}
export function mockServer() {
    return {
        close: vi.fn((cb) => cb()),
    };
}
export function mockCortex() {
    return {
        write: vi.fn().mockResolvedValue(true),
        query: vi.fn().mockResolvedValue({ data: [] }),
        healthy: vi.fn().mockResolvedValue(true),
    };
}
export function mockEventBus() {
    return {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
    };
}
