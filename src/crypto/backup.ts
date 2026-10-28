import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Encrypted backup container for the full app state (pair DB + session blob +
 * master key). The key is derived from BOTH the app password and a user-chosen
 * passphrase (scrypt over `<appPassword>\0<passphrase>`), so an attacker needs
 * both secrets — and neither is stored in the file itself.
 *
 * Wire format (binary):
 *   magic  "PDNBAK1"                       (7 bytes)
 *   version (u8) = 1
 *   kdfLogN (u8), kdfR (u8), kdfP (u8)     (scrypt params, for future-proofing)
 *   salt    (16 bytes)
 *   nonce   (12 bytes)
 *   AES-256-GCM ciphertext || tag (16 bytes)
 */

export const BACKUP_MAGIC = 'PDNBAK1';
const VERSION = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const SCRYPT_LOG_N = 15; // 2^15 = 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAXMEM = 128 * 1024 * 1024;

export interface BackupPayload {
    version: number;
    createdAt: string; // ISO
    hasSession: boolean;
    db: string; // base64 of sync.db raw bytes
    sessionBlob: string | null; // the encrypted session text (secretBox output) or null
    masterKey: string; // hex (64 chars)
}

export function isStrongPassphrase(p: string): boolean {
    if (typeof p !== 'string') return false;
    if (p.length < 12) return false;
    if (!/[a-z]/.test(p)) return false;
    if (!/[A-Z]/.test(p)) return false;
    if (!/[0-9]/.test(p)) return false;
    if (!/[^A-Za-z0-9\s]/.test(p)) return false; // punctuation/symbol
    return true;
}

export function describePassphrasePolicy(): string {
    return 'Passphrase must be at least 12 characters and include uppercase, lowercase, a number, and a symbol';
}

function deriveKey(appPassword: string, passphrase: string, salt: Buffer, logN: number, r: number, p: number): Buffer {
    const material = `${appPassword}\u0000${passphrase}`;
    return scryptSync(material, salt, KEY_LEN, { N: 1 << logN, r, p, maxmem: MAXMEM });
}

export function encryptBackup(payload: BackupPayload, appPassword: string, passphrase: string): Buffer {
    const salt = randomBytes(SALT_LEN);
    const nonce = randomBytes(NONCE_LEN);
    const key = deriveKey(appPassword, passphrase, salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(11);
    header.write(BACKUP_MAGIC, 0, 'ascii');
    header.writeUInt8(VERSION, 7);
    header.writeUInt8(SCRYPT_LOG_N, 8);
    header.writeUInt8(SCRYPT_R, 9);
    header.writeUInt8(SCRYPT_P, 10);

    return Buffer.concat([header, salt, nonce, enc, tag]);
}

export function decryptBackup(buf: Buffer, appPassword: string, passphrase: string): BackupPayload {
    if (buf.length < 11 + SALT_LEN + NONCE_LEN + 16) {
        throw new Error('Backup file is too small or corrupt');
    }
    if (buf.subarray(0, 7).toString('ascii') !== BACKUP_MAGIC) {
        throw new Error('Not a recognized backup file');
    }
    const version = buf.readUInt8(7);
    if (version !== VERSION) {
        throw new Error(`Unsupported backup version ${version}`);
    }
    const logN = buf.readUInt8(8);
    const r = buf.readUInt8(9);
    const p = buf.readUInt8(10);
    // Guard against a malicious header asking for absurd scrypt cost.
    if (logN > 20 || r > 32 || p > 4) {
        throw new Error('Backup header specifies invalid key-derivation parameters');
    }
    const salt = buf.subarray(11, 11 + SALT_LEN);
    const nonce = buf.subarray(11 + SALT_LEN, 11 + SALT_LEN + NONCE_LEN);
    const encStart = 11 + SALT_LEN + NONCE_LEN;
    const enc = buf.subarray(encStart, buf.length - 16);
    const tag = buf.subarray(buf.length - 16);

    const key = deriveKey(appPassword, passphrase, salt, logN, r, p);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    try {
        const plaintext = Buffer.concat([decipher.update(enc), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8')) as BackupPayload;
    } catch {
        throw new Error('Incorrect passphrase, or the app password has changed since this backup was created');
    }
}
