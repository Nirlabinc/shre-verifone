import { createLogger } from './logger.js';
import * as crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const log = createLogger('license');
const GRACE_PERIOD_DAYS = 30;
const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
SHRE_LICENSE_PUBLIC_KEY_PLACEHOLDER
-----END PUBLIC KEY-----`;
let _publicKey = EMBEDDED_PUBLIC_KEY;
export function setPublicKey(pem) {
    _publicKey = pem;
}
function base64UrlDecode(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64');
}
function decodeJwtPayload(token) {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1])
        throw new Error('Invalid JWT format');
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf-8'));
}
function verifyJwtSignature(token, publicKeyPem) {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
        return false;
    const signedContent = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);
    try {
        const verify = crypto.createVerify('RSA-SHA256');
        verify.update(signedContent);
        return verify.verify(publicKeyPem, signature);
    }
    catch {
        return false;
    }
}
function base64UrlEncode(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function generateLicenseKey(claims, privateKeyPem) {
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        ...claims,
        issuedAt: new Date().toISOString(),
        issuer: 'shre-platform',
    };
    const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const signedContent = `${headerB64}.${payloadB64}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signedContent);
    const signature = sign.sign(privateKeyPem);
    return `${signedContent}.${base64UrlEncode(signature)}`;
}
export function validateLicense(licenseKey) {
    if (!licenseKey || licenseKey.trim().length === 0) {
        return { valid: false, reason: 'No license key provided' };
    }
    if (_publicKey.includes('PLACEHOLDER')) {
        try {
            const payload = decodeJwtPayload(licenseKey);
            log.warn('License validation in dev mode (placeholder public key) — skipping signature check');
            return checkExpiry(payload);
        }
        catch (e) {
            return { valid: false, reason: `Failed to decode license: ${e.message}` };
        }
    }
    if (!verifyJwtSignature(licenseKey, _publicKey)) {
        return { valid: false, reason: 'Invalid license signature' };
    }
    let claims;
    try {
        claims = decodeJwtPayload(licenseKey);
    }
    catch (e) {
        return { valid: false, reason: `Failed to decode license claims: ${e.message}` };
    }
    if (!claims.workspaceId || !claims.tier || !claims.expiresAt) {
        return {
            valid: false,
            reason: 'License missing required fields (workspaceId, tier, expiresAt)',
        };
    }
    return checkExpiry(claims);
}
function checkExpiry(claims) {
    const now = new Date();
    const expiresAt = new Date(claims.expiresAt);
    const msRemaining = expiresAt.getTime() - now.getTime();
    const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
    if (daysRemaining > 0) {
        return { valid: true, claims, daysRemaining };
    }
    const daysPastExpiry = Math.abs(daysRemaining);
    if (daysPastExpiry <= GRACE_PERIOD_DAYS) {
        const graceRemainingDays = GRACE_PERIOD_DAYS - daysPastExpiry;
        return { valid: true, claims, daysRemaining: 0, grace: true, graceRemainingDays };
    }
    return {
        valid: false,
        reason: `License expired ${daysPastExpiry} days ago (grace period: ${GRACE_PERIOD_DAYS} days)`,
    };
}
export function loadLicenseKey() {
    const envKey = process.env.SHRE_LICENSE_KEY;
    if (envKey && envKey.trim().length > 0) {
        log.info('License key loaded from SHRE_LICENSE_KEY env');
        return envKey.trim();
    }
    const keyPath = join(homedir(), '.shre', 'license.key');
    if (existsSync(keyPath)) {
        try {
            const fileKey = readFileSync(keyPath, 'utf-8').trim();
            if (fileKey.length > 0) {
                log.info('License key loaded from ~/.shre/license.key');
                return fileKey;
            }
        }
        catch (e) {
            log.warn('Failed to read license key file:', e.message);
        }
    }
    return null;
}
export function createLicenseEnforcer() {
    let licenseKey = loadLicenseKey();
    let cachedStatus = null;
    let lastCheck = 0;
    const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
    function refresh() {
        licenseKey = loadLicenseKey();
        cachedStatus = null;
        lastCheck = 0;
    }
    function getStatus() {
        if (!licenseKey) {
            return {
                valid: true,
                claims: {
                    workspaceId: 'cloud',
                    tier: 'enterprise',
                    maxAgents: 0,
                    maxRequests: 0,
                    features: ['*'],
                    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
                    issuedAt: new Date().toISOString(),
                    issuer: 'shre-cloud',
                },
                daysRemaining: 365,
            };
        }
        const now = Date.now();
        if (cachedStatus && now - lastCheck < CHECK_INTERVAL_MS) {
            return cachedStatus;
        }
        cachedStatus = validateLicense(licenseKey);
        lastCheck = now;
        if (cachedStatus.valid) {
            if ('grace' in cachedStatus && cachedStatus.grace) {
                log.warn(`License expired — grace period: ${cachedStatus.graceRemainingDays} days remaining`, {
                    workspaceId: cachedStatus.claims.workspaceId,
                    tier: cachedStatus.claims.tier,
                });
            }
            else {
                log.info(`License valid — ${cachedStatus.daysRemaining} days remaining`, {
                    workspaceId: cachedStatus.claims.workspaceId,
                    tier: cachedStatus.claims.tier,
                });
            }
        }
        else {
            log.error(`License invalid: ${cachedStatus.reason}`);
        }
        return cachedStatus;
    }
    function hasFeature(feature) {
        const status = getStatus();
        if (!status.valid)
            return false;
        return status.claims.features.includes('*') || status.claims.features.includes(feature);
    }
    function canAddAgent(currentCount) {
        const status = getStatus();
        if (!status.valid)
            return false;
        if (status.claims.maxAgents === 0)
            return true;
        return currentCount < status.claims.maxAgents;
    }
    function canMakeRequest(currentMonthCount) {
        const status = getStatus();
        if (!status.valid)
            return false;
        if (status.claims.maxRequests === 0)
            return true;
        return currentMonthCount < status.claims.maxRequests;
    }
    function isSelfHosted() {
        return licenseKey !== null;
    }
    const initialStatus = getStatus();
    if (licenseKey && !initialStatus.valid) {
        log.error('=== LICENSE VALIDATION FAILED ===');
        log.error(`Reason: ${initialStatus.reason}`);
        log.error('AI endpoints will return 402 Payment Required.');
        log.error('Contact support@nirtek.net for license renewal.');
        log.error('================================');
    }
    return { getStatus, hasFeature, canAddAgent, canMakeRequest, refresh, isSelfHosted };
}
