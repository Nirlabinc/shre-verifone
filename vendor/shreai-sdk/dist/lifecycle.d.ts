export interface ShutdownOptions {
    name: string;
    timeout?: number;
    onShutdown?: () => Promise<void> | void;
}
export declare function registerShutdown(server: {
    close: (cb: () => void) => void;
}, opts: ShutdownOptions): void;
