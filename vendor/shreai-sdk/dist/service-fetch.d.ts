import { Agent } from 'node:https';
export declare function createServiceAgent(): Agent;
export declare function createServiceFetch(_serviceName: string): (url: string | URL, init?: RequestInit & {
    timeout?: number;
}) => Promise<Response>;
