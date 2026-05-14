export type LicenseTier = 'lite' | 'standard' | 'full' | 'enterprise';
export interface LicenseClaims {
    workspaceId: string;
    tier: LicenseTier;
    maxAgents: number;
    maxRequests: number;
    features: string[];
    expiresAt: string;
    issuedAt: string;
    issuer: string;
}
export type LicenseStatus = {
    valid: true;
    claims: LicenseClaims;
    daysRemaining: number;
} | {
    valid: true;
    claims: LicenseClaims;
    daysRemaining: number;
    grace: true;
    graceRemainingDays: number;
} | {
    valid: false;
    reason: string;
};
export declare function setPublicKey(pem: string): void;
export declare function generateLicenseKey(claims: Omit<LicenseClaims, 'issuedAt' | 'issuer'>, privateKeyPem: string): string;
export declare function validateLicense(licenseKey: string): LicenseStatus;
export declare function loadLicenseKey(): string | null;
export interface LicenseEnforcer {
    getStatus(): LicenseStatus;
    hasFeature(feature: string): boolean;
    canAddAgent(currentCount: number): boolean;
    canMakeRequest(currentMonthCount: number): boolean;
    refresh(): void;
    isSelfHosted(): boolean;
}
export declare function createLicenseEnforcer(): LicenseEnforcer;
