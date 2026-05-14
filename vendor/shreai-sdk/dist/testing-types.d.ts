export interface TestBlockContract {
    id: string;
    name: string;
    owns: string[];
    reads: string[];
    tools: string[];
    hasRollback: boolean;
    rollbackDescription?: string;
}
export interface DependencyEdge {
    from: string;
    to: string;
}
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
export interface Collision {
    key: string;
    blockA: string;
    blockB: string;
}
export interface CollisionMatrix {
    hasCollisions: boolean;
    collisions: Collision[];
    ownershipMap: Record<string, string[]>;
}
export interface RollbackValidation {
    blockId: string;
    hasRollback: boolean;
    ownsKeys: boolean;
    missingRollback: boolean;
    warning: string | null;
}
export interface NRunResult {
    runs: number;
    consistentToolCalls: boolean;
    confidenceRange: [number, number];
    tierConsistent: boolean;
    allPassed: boolean;
}
export interface MutationDiff {
    changedKeys: string[];
    addedKeys: string[];
    removedKeys: string[];
    violations: string[];
}
export interface ToolCallExpectation {
    toolName: string;
    requiredParams?: string[];
    forbiddenParams?: string[];
}
export interface ToolCallMatch {
    toolName: string;
    matched: boolean;
    missingParams: string[];
    forbiddenParamsFound: string[];
}
export interface ToolCallValidation {
    valid: boolean;
    matches: ToolCallMatch[];
    unexpectedCalls: string[];
    unmatchedExpectations: string[];
}
export interface RubricCriterion {
    name: string;
    description: string;
    weight: number;
    minScore: number;
}
export interface DomainRubric {
    name: string;
    criteria: RubricCriterion[];
}
export interface GoldenCase {
    id: string;
    input: string;
    expectedOutput: string;
    rubric: DomainRubric;
    minScore: number;
}
export interface HallucinationProbe {
    name: string;
    pattern: RegExp;
    description: string;
}
export interface HallucinationFinding {
    probe: string;
    match: string;
    index: number;
    description: string;
}
export interface SafetyViolation {
    patternName: string;
    match: string;
    severity: 'critical' | 'high' | 'medium';
}
export interface TenantIsolationResult {
    isolated: boolean;
    leakedKeys: string[];
    leakedTenantIds: string[];
}
export type FaultType = 'tool_timeout' | 'llm_error' | 'db_write_fail' | 'network_drop';
export type ExpectedBehavior = 'rollback' | 'retry' | 'escalate' | 'graceful_degrade';
export interface FaultScenario {
    name: string;
    faultType: FaultType;
    expectedBehavior: ExpectedBehavior;
}
export interface TestLayer {
    id: 'L1' | 'L2' | 'L3' | 'L4';
    name: string;
    description: string;
    maxDurationMs: number;
    frequency: 'every-commit' | 'pr' | 'nightly';
    requiresLLM: boolean;
    blocksMerge: boolean;
}
export declare const TEST_LAYERS: TestLayer[];
