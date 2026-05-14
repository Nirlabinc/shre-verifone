export declare function getShreRoot(): string;
export declare function getShrePath(...parts: string[]): string;
export declare function getLogDir(): string;
export declare const PATHS: {
    config: () => string;
    ports: () => string;
    vault: () => string;
    tls: () => string;
    agents: () => string;
    backups: () => string;
};
