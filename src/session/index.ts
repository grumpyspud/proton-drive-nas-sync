import path from 'node:path';
import type { SessionCredentials } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import { configDir, loadMasterKey } from '../crypto/keySource';
import { createSecretBox } from '../crypto/secret';
import { InMemoryCredentials } from './credentials';
import { PersistentCredentials } from './persistentCredentials';

/**
 * Creates the session store. `persist: true` yields an AES-256-GCM encrypted
 * blob under `<configDir>/session.blob`, keyed from PDN_ENCRYPTION_KEY or a
 * keyfile (see src/crypto/keySource.ts). `persist: false` is memory-only.
 */
export function createSessionCredentials(options: { persist: boolean }): SessionCredentials {
    if (!options.persist) {
        return new InMemoryCredentials();
    }
    const key = loadMasterKey();
    return new PersistentCredentials({
        filePath: path.join(configDir(), 'session.blob'),
        secretBox: createSecretBox(key),
    });
}
