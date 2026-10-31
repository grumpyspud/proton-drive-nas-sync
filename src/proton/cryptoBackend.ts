import { CryptoProxy } from '@protontech/crypto';
import type { CryptoApiInterface } from '@protontech/crypto';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';
import type { SrpApiInterface } from '../../vendor/proton-drive-sdk-account/srp';
import { initOpenPGPCryptoModule } from './crypto';

/**
 * Crypto abstraction: the swap point for Proton's planned cryptographic model
 * change (end 2026 / early 2027).
 *
 * Everything the app does cryptographically flows through a CryptoBackend:
 *   - `openPGPCryptoModule`: the Drive SDK's file-encryption module.
 *   - `cryptoProxy`       : the keyring/address unlock proxy (account module).
 *   - `srpApi`            : SRP login primitives.
 *
 * When Proton ships the new model, add a second backend (e.g.
 * `createNewModelBackend()`) and select it at startup. The Sync/Backup/Restore
 * engines and the UI never touch crypto directly, so they don't change.
 */
export interface CryptoBackend {
    readonly name: string;
    readonly openPGPCryptoModule: OpenPGPCryptoWithCryptoProxy;
    readonly cryptoProxy: CryptoApiInterface;
    readonly srpApi: SrpApiInterface;
}

/** The current (pre-migration) OpenPGP backend. Initialised once per process ~
 *  the crypto package's `CryptoProxy` endpoint is a process-global singleton
 *  that throws "already initialised" if `setEndpoint` is called twice. Cached
 *  as a PROMISE so concurrent first calls (login + resume racing) share one
 *  init instead of tripping that singleton guard. */
let cachedBackendPromise: Promise<CryptoBackend> | undefined;

export function createOpenPGPBackend(): Promise<CryptoBackend> {
    if (!cachedBackendPromise) {
        cachedBackendPromise = (async (): Promise<CryptoBackend> => {
            const openPGPCryptoModule = await initOpenPGPCryptoModule();
            return {
                name: 'openpgp',
                openPGPCryptoModule,
                cryptoProxy: CryptoProxy,
                srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
            };
        })();
    }
    return cachedBackendPromise;
}

/** Forget the backend and wipe the in-memory keyring so the next login
 *  re-initialises it fresh (required for switching accounts). */
export function resetCryptoBackend(): void {
    if (!cachedBackendPromise) return;
    cachedBackendPromise = undefined;
    try {
        CryptoProxy.releaseEndpoint();
    } catch {
        // endpoint already released
    }
}
