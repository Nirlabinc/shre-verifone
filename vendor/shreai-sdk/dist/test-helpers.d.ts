export declare function mockFetch(data: unknown, status?: number): import("vitest").Mock<(...args: any[]) => any>;
export declare function mockServer(): {
    close: import("vitest").Mock<(cb: () => void) => void>;
};
export declare function mockCortex(): {
    write: import("vitest").Mock<(...args: any[]) => any>;
    query: import("vitest").Mock<(...args: any[]) => any>;
    healthy: import("vitest").Mock<(...args: any[]) => any>;
};
export declare function mockEventBus(): {
    publish: import("vitest").Mock<(...args: any[]) => any>;
    subscribe: import("vitest").Mock<(...args: any[]) => any>;
};
