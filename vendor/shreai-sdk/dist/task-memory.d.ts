import type { TaskMemory, TaskMemoryTool, TaskMemoryPipe, TaskMemoryNode, TaskMemoryAgent, TaskMemoryStorage, TaskMemoryConfidence, TaskMemoryBenchmark } from './types.js';
export declare function createTaskMemory(seed?: Partial<Omit<TaskMemory, 'version'>>): TaskMemory;
export declare function parseTaskMemory(raw: string | null | undefined): TaskMemory | null;
export declare function serializeTaskMemory(memory: TaskMemory): string;
export declare function addTool(memory: TaskMemory, tool: TaskMemoryTool): TaskMemory;
export declare function addPipe(memory: TaskMemory, pipe: TaskMemoryPipe): TaskMemory;
export declare function addNode(memory: TaskMemory, node: TaskMemoryNode): TaskMemory;
export declare function addAgent(memory: TaskMemory, agent: TaskMemoryAgent): TaskMemory;
export declare function addStorage(memory: TaskMemory, storage: TaskMemoryStorage): TaskMemory;
export declare function addNote(memory: TaskMemory, note: string): TaskMemory;
export declare function mergeTaskMemory(...memories: (TaskMemory | null | undefined)[]): TaskMemory;
export declare function inheritMemory(current: TaskMemory | null, predecessors: Array<{
    taskId: string;
    agent?: string;
    memory: TaskMemory | null;
}>): TaskMemory;
export declare function formatMemoryBrief(memory: TaskMemory): string;
export interface ConfidenceInput {
    skillMatch: number;
    memory: TaskMemory;
    historicalFit?: number;
    loadRatio?: number;
    predecessorsInherited?: number;
    predecessorsExpected?: number;
}
export declare function computeConfidence(input: ConfidenceInput): TaskMemoryConfidence;
export declare function computeMemorySignature(memory: TaskMemory): string;
export interface HistoricalTaskRecord {
    agentId: string;
    qualityScore?: number;
    status: string;
    durationMs?: number;
    estimatedDurationMs?: number;
    memorySignature: string;
    discoveredToolCount: number;
    downstreamInheritances: number;
}
export declare function computeBenchmark(agentId: string, memory: TaskMemory, history: HistoricalTaskRecord[]): TaskMemoryBenchmark;
export declare function signatureSimilarity(a: string, b: string): number;
export type { TaskMemory, TaskMemoryTool, TaskMemoryPipe, TaskMemoryNode, TaskMemoryAgent, TaskMemoryStorage, TaskMemoryConfidence, TaskMemoryBenchmark, };
