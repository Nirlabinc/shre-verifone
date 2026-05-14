export type { TestBlockContract, DependencyEdge, ValidationResult, Collision, CollisionMatrix, RollbackValidation, NRunResult, MutationDiff, ToolCallExpectation, ToolCallMatch, ToolCallValidation, RubricCriterion, DomainRubric, GoldenCase, HallucinationProbe, HallucinationFinding, SafetyViolation, TenantIsolationResult, FaultType, ExpectedBehavior, FaultScenario, TestLayer, } from './testing-types.js';
export { TEST_LAYERS } from './testing-types.js';
export { INJECTION_CORPUS, UNSAFE_PATTERNS, checkSafetyViolations, checkTenantIsolation, FAULT_SCENARIOS, createFaultInjector, } from './testing-adversarial.js';
import type { TestBlockContract, DependencyEdge, ValidationResult, CollisionMatrix, RollbackValidation, NRunResult, MutationDiff, ToolCallExpectation, ToolCallValidation, RubricCriterion, DomainRubric, HallucinationProbe, HallucinationFinding } from './testing-types.js';
export declare function validateContract(contract: TestBlockContract): ValidationResult;
export declare function computeCollisionMatrix(contracts: TestBlockContract[]): CollisionMatrix;
export declare function detectCycles(deps: DependencyEdge[]): string[][] | null;
export declare function computeWaves(contracts: TestBlockContract[], deps: DependencyEdge[]): string[][];
export declare function validateRollbacks(contracts: TestBlockContract[]): RollbackValidation[];
export declare function aggregateNRuns(runs: Array<{
    toolCalls: string[];
    confidence: number;
    tier: string;
}>): NRunResult;
export declare function diffStateMutation(before: Record<string, unknown>, after: Record<string, unknown>, owns: string[]): MutationDiff;
export declare function validateToolCalls(calls: Array<{
    name: string;
    params: Record<string, unknown>;
}>, expectations: ToolCallExpectation[]): ToolCallValidation;
export declare function createRubric(name: string, criteria: RubricCriterion[]): DomainRubric;
export declare function validateRubricWeights(rubric: DomainRubric): boolean;
export declare function computeRubricScore(rubric: DomainRubric, scores: Record<string, number>): number | null;
export declare function checkRubricThresholds(rubric: DomainRubric, scores: Record<string, number>): string[];
export declare const HALLUCINATION_PROBES: HallucinationProbe[];
export declare function probeForHallucinations(output: string, context: string): HallucinationFinding[];
