export interface FieldEncryptorConfig {
    masterKey: string;
    tenantId: string;
    keyDerivation?: 'hkdf';
    piiFields?: string[];
}
export interface EncryptOptions {
    field?: string;
    searchable?: boolean;
}
export interface FieldEncryptor {
    encrypt(plaintext: string, opts?: EncryptOptions): string;
    decrypt(ciphertext: string): string;
    search(fieldName: string, searchValue: string): string;
    rotateKey(oldMaster: string, newMaster: string, encryptedValues: string[]): {
        reEncrypted: string[];
        errors: Array<{
            index: number;
            error: string;
        }>;
    };
    isEncrypted(value: string): boolean;
    piiFields: string[];
}
export declare function createFieldEncryptor(config: FieldEncryptorConfig): FieldEncryptor;
