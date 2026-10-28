import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger } from '../logger';

/**
 * Master key for encrypting the persisted session blob.
 *
 * Resolution order:
 *   1. PDN_ENCRYPTION_KEY (64 hex chars = 32 bytes) — preferred for production,
 *      e.g. a Docker secret surfaced as an env var.
 *   2. PDN_ENCRYPTION_KEY_FILE (path) or `<configDir>/encryption.key` — a keyfile.
 *   3. If neither exists, auto-provision a random key at the keyfile path (0600).
 *      This is a dev convenience; production should mount a real secret.
 */
export function configDir(): string {
    return process.env.PDN_CONFIG_DIR ?? path.join(homedir(), '.config', 'proton-drive-nas-sync');
}

function toKey(raw: string): Buffer {
    const trimmed = raw.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }
    throw new Error('Encryption key must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32');
}

export function loadMasterKey(): Buffer {
    const env = process.env.PDN_ENCRYPTION_KEY;
    if (env) {
        return toKey(env);
    }

    const keyFile = process.env.PDN_ENCRYPTION_KEY_FILE ?? path.join(configDir(), 'encryption.key');
    if (existsSync(keyFile)) {
        return toKey(readFileSync(keyFile, 'utf8'));
    }

    const key = randomBytes(32);
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    logger.warn(`Auto-provisioned encryption key at ${keyFile} (0600). For production, mount a Docker secret.`);
    return key;
}
