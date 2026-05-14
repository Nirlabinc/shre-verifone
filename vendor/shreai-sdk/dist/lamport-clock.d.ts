export interface LamportClock {
    tick(): number;
    receive(remoteTimestamp: number): number;
    current(): number;
    serviceId(): string;
    stamp(): LamportTimestamp;
}
export interface LamportTimestamp {
    lamport: number;
    wall: string;
    origin: string;
}
export declare function compareLamport(a: LamportTimestamp, b: LamportTimestamp): number;
export declare function happenedBefore(a: LamportTimestamp, b: LamportTimestamp): boolean;
export declare function sortByCausalOrder<T extends {
    lamportTs?: LamportTimestamp;
}>(events: T[]): T[];
export declare function createLamportClock(serviceId: string): LamportClock;
