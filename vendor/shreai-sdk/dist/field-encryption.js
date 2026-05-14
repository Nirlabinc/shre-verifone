import { createCipheriv, createDecipheriv, createHmac, randomBytes, hkdfSync } from 'node:crypto';
import { createLogger } from './logger.js';
const ENCRYPTION_PREFIX = 'enc:v1:';
const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = 'shre-field-encryption-v1';
const HKDF_HASH = 'sha256';
const DEFAULT_PII_FIELDS = [
    'email',
    'phone',
    'name',
    'address',
    'ssn',
    'dob',
    'passport',
    'license',
];
const log = createLogger('shre-field-encryption');
function decodeMasterKey(masterKey) {
    let buf;
    if (masterKey.length === 44 && masterKey.endsWith('=')) {
        buf = Buffer.from(masterKey, 'base64');
    }
    else if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
        buf = Buffer.from(masterKey, 'hex');
    }
    else {
        buf = Buffer.from(masterKey, 'base64');
    }
    if (buf.length !== KEY_BYTES) {
        throw new Error(`Master key must be 32 bytes (256 bits). Got ${buf.length} bytes. ` +
            'Provide a base64-encoded or hex-encoded 256-bit key.');
    }
    return buf;
}
function deriveTenantKey(masterKeyBuf, tenantId, context) {
    const info = context ? `shre:${tenantId}:${context}` : `shre:${tenantId}`;
    return Buffer.from(hkdfSync(HKDF_HASH, masterKeyBuf, HKDF_SALT, info, KEY_BYTES));
}
function deterministicIV(tenantKey, fieldName, plaintext) {
    const hmac = createHmac('sha256', tenantKey);
    hmac.update(`${fieldName}:${plaintext}`);
    return hmac.digest().subarray(0, IV_BYTES);
}
export function createFieldEncryptor(config) {
    const masterKeyBuf = decodeMasterKey(config.masterKey);
    const piiFields = config.piiFields || DEFAULT_PII_FIELDS;
    function encryptWithKey(key, plaintext, iv) {
        const _iv = iv || randomBytes(IV_BYTES);
        const cipher = createCipheriv(AES_ALGO, key, _iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return { iv: _iv, ciphertext: encrypted, tag };
    }
    function decryptWithKey(key, iv, ciphertext, tag) {
        const decipher = createDecipheriv(AES_ALGO, key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    }
    return {
        piiFields,
        encrypt(plaintext, opts) {
            if (!plaintext)
                return plaintext;
            const field = opts?.field || 'generic';
            const searchable = opts?.searchable || false;
            const fieldKey = deriveTenantKey(masterKeyBuf, config.tenantId, field);
            const iv = searchable ? deterministicIV(fieldKey, field, plaintext) : undefined;
            const { iv: usedIv, ciphertext, tag } = encryptWithKey(fieldKey, plaintext, iv);
            return `${ENCRYPTION_PREFIX}${usedIv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}:${field}`;
        },
        decrypt(encrypted) {
            if (!encrypted || !encrypted.startsWith(ENCRYPTION_PREFIX)) {
                throw new Error('Not an encrypted value (missing enc:v1: prefix)');
            }
            const payload = encrypted.slice(ENCRYPTION_PREFIX.length);
            const parts = payload.split(':');
            if (parts.length < 3) {
                throw new Error('Invalid encrypted format: expected enc:v1:<iv>:<ciphertext>:<tag>[:<field>]');
            }
            const iv = Buffer.from(parts[0], 'hex');
            const ciphertext = Buffer.from(parts[1], 'hex');
            const tag = Buffer.from(parts[2], 'hex');
            const field = parts[3] || 'generic';
            if (iv.length !== IV_BYTES)
                throw new Error(`Invalid IV length: ${iv.length}`);
            if (tag.length !== TAG_BYTES)
                throw new Error(`Invalid auth tag length: ${tag.length}`);
            const fieldKey = deriveTenantKey(masterKeyBuf, config.tenantId, field);
            try {
                return decryptWithKey(fieldKey, iv, ciphertext, tag);
            }
            catch (err) {
                log.error('Decryption failed', { field, tenantId: config.tenantId }, err);
                throw new Error('Decryption failed: invalid key or corrupted data');
            }
        },
        search(fieldName, searchValue) {
            const fieldKey = deriveTenantKey(masterKeyBuf, config.tenantId, fieldName);
            const iv = deterministicIV(fieldKey, fieldName, searchValue);
            const { iv: usedIv, ciphertext, tag } = encryptWithKey(fieldKey, searchValue, iv);
            return `${ENCRYPTION_PREFIX}${usedIv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}:${fieldName}`;
        },
        rotateKey(oldMaster, newMaster, encryptedValues) {
            const oldMasterBuf = decodeMasterKey(oldMaster);
            const newMasterBuf = decodeMasterKey(newMaster);
            const reEncrypted = [];
            const errors = [];
            for (let i = 0; i < encryptedValues.length; i++) {
                try {
                    const encrypted = encryptedValues[i];
                    if (!encrypted.startsWith(ENCRYPTION_PREFIX)) {
                        reEncrypted.push(encrypted);
                        continue;
                    }
                    const payload = encrypted.slice(ENCRYPTION_PREFIX.length);
                    const parts = payload.split(':');
                    const iv = Buffer.from(parts[0], 'hex');
                    const ciphertext = Buffer.from(parts[1], 'hex');
                    const tag = Buffer.from(parts[2], 'hex');
                    const field = parts[3] || 'generic';
                    const oldFieldKey = deriveTenantKey(oldMasterBuf, config.tenantId, field);
                    const plaintext = decryptWithKey(oldFieldKey, iv, ciphertext, tag);
                    const newFieldKey = deriveTenantKey(newMasterBuf, config.tenantId, field);
                    const result = encryptWithKey(newFieldKey, plaintext);
                    reEncrypted.push(`${ENCRYPTION_PREFIX}${result.iv.toString('hex')}:${result.ciphertext.toString('hex')}:${result.tag.toString('hex')}:${field}`);
                }
                catch (err) {
                    errors.push({
                        index: i,
                        error: err instanceof Error ? err.message : 'Unknown error',
                    });
                    reEncrypted.push(encryptedValues[i]);
                }
            }
            log.info('Key rotation complete', {
                total: encryptedValues.length,
                rotated: encryptedValues.length - errors.length,
                errors: errors.length,
                tenantId: config.tenantId,
            });
            return { reEncrypted, errors };
        },
        isEncrypted(value) {
            return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
        },
    };
}
