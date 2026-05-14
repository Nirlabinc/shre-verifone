import type { SafetyViolation, TenantIsolationResult, FaultType, FaultScenario } from './testing-types.js';
export declare const INJECTION_CORPUS: string[];
export declare const UNSAFE_PATTERNS: RegExp[];
export declare function checkSafetyViolations(output: string): SafetyViolation[];
export declare function checkTenantIsolation(tenantAState: Record<string, unknown>, tenantBState: Record<string, unknown>): TenantIsolationResult;
export declare const FAULT_SCENARIOS: FaultScenario[];
export declare function createFaultInjector<T>(executor: (...args: unknown[]) => Promise<T>, faultType: FaultType, atInvocation?: number): (...args: unknown[]) => Promise<T>;
