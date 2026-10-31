import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM authenticated encryption for small secret blobs (the persisted
 * session). Uses Node's built-in crypto: this protects OUR session, not
 * Proton's file encryption (which the SDK handles separately).
 *
 * Payload format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
 */
export interface SecretBox {
    encrypt(plaintext: string): string;
    decrypt(payload: string): string;
}

export function createSecretBox(key: Buffer): SecretBox {
    if (key.length !== 32) {
        throw new Error(`AES-256-GCM requires a 32-byte key (got ${key.length} bytes)`);
    }

    return {
        encrypt(plaintext) {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            const tag = cipher.getAuthTag();
            return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
        },
        decrypt(payload) {
            const [version, ivB64, tagB64, dataB64] = payload.split(':');
            if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
                throw new Error('Invalid encrypted session payload');
            }
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
            decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
            return Buffer.concat([
                decipher.update(Buffer.from(dataB64, 'base64')),
                decipher.final(),
            ]).toString('utf8');
        },
    };
}
