import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MemoryCache, NullCache, ProtonDriveClient, type CachedCryptoMaterial, type ProtonDriveCache } from '@protontech/drive-sdk';
import { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';
import { AccountApi } from '../../vendor/proton-drive-sdk-account/accountApi';
import { Addresses } from '../../vendor/proton-drive-sdk-account/addresses';
import { Srp } from '../../vendor/proton-drive-sdk-account/srp';
import type { SessionCredentials } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import type { Logger } from '../logger';
import { APP_VERSION, BASE_URL, CACHE_DIR, CACHE_LRU_MAX, CACHE_MODE, SDK_VERSION } from '../config';
import { configDir } from '../crypto/keySource';
import { telemetry } from '../logger';
import { DriveAccountAdapter } from './accountAdapter';
import { createOpenPGPBackend, type CryptoBackend } from './cryptoBackend';
import { DiskCache } from './diskCache';
import { HTTPClient } from './httpClient';
import { LruCache } from './lruCache';

export interface ProtonSession {
    credentials: SessionCredentials;
    apiClient: ApiClient;
    accountApi: AccountApi;
    srp: Srp;
    addresses: Addresses;
    account: DriveAccountAdapter;
    httpClient: HTTPClient;
    sdk: ProtonDriveClient;
}

/**
 * Builds the entity-cache backend, selected by the `PDN_CACHE` env var:
 *   `memory` (default) - unbounded in-memory cache,
 *   `null`             - cache disabled (every scan is cold),
 *   `lru`              - bounded least-recently-used cache (see CACHE_LRU_MAX),
 *   `disk`             - persistent disk-backed cache under CACHE_DIR, with an
 *                        in-memory LRU front sized by CACHE_LRU_MAX (0 = none).
 */
function makeEntitiesCache(): ProtonDriveCache<string> {
    switch (CACHE_MODE) {
        case 'null':
            return new NullCache<string>();
        case 'lru':
            return new LruCache<string>(CACHE_LRU_MAX);
        case 'disk':
            return new DiskCache(cacheDir(), CACHE_LRU_MAX);
        case 'memory':
        default:
            return new MemoryCache<string>();
    }
}

/**
 * The crypto cache stays in-memory in every mode except `null`: its values are
 * opaque crypto objects (`PrivateKey`/`SessionKey`/`Uint8Array`) that do not
 * serialize to disk cleanly, and it is small enough not to be the memory
 * problem. `disk` therefore persists entities only.
 */
function makeCryptoCache(): ProtonDriveCache<CachedCryptoMaterial> {
    switch (CACHE_MODE) {
        case 'null':
            return new NullCache<CachedCryptoMaterial>();
        case 'lru':
            return new LruCache<CachedCryptoMaterial>(CACHE_LRU_MAX);
        case 'disk':
        case 'memory':
        default:
            return new MemoryCache<CachedCryptoMaterial>();
    }
}

/** Resolves the disk cache directory: PDN_CACHE_DIR, else `<configDir>/cache`. */
function cacheDir(): string {
    return CACHE_DIR !== '' ? CACHE_DIR : path.join(configDir(), 'cache');
}

/**
 * Wires the vendored account module together with the Drive SDK, mirroring the
 * reference CLI's `init()` + `initApi()`. All crypto flows through `backend`
 * (defaults to the OpenPGP backend) so the upcoming crypto-model migration is a
 * one-line swap at startup.
 */
export async function buildSession(credentials: SessionCredentials, logger: Logger, backend?: CryptoBackend): Promise<ProtonSession> {
    const crypto = backend ?? (await createOpenPGPBackend());

    const cacheNote = CACHE_MODE === 'lru'
        ? `lru (max ${CACHE_LRU_MAX} entries)`
        : CACHE_MODE === 'disk'
            ? `disk (${cacheDir()}${CACHE_LRU_MAX > 0 ? `, ${CACHE_LRU_MAX} entry RAM front` : ', no RAM front'})`
            : CACHE_MODE;
    logger.info(`Drive SDK cache: ${cacheNote}`);

    const apiClient = new ApiClient({
        baseUrl: BASE_URL,
        appVersion: APP_VERSION,
        credentials,
        logger,
        headers: { 'x-pm-drive-sdk-version': SDK_VERSION },
    });

    const accountApi = new AccountApi(apiClient);
    const srp = new Srp(accountApi, crypto.srpApi);
    const addresses = new Addresses(accountApi, credentials, crypto.cryptoProxy, logger);
    const account = new DriveAccountAdapter(addresses);
    const httpClient = new HTTPClient(apiClient);

    const sdk = new ProtonDriveClient({
        config: { baseUrl: BASE_URL, clientUid: `pdn-${randomUUID()}` },
        httpClient,
        entitiesCache: makeEntitiesCache(),
        cryptoCache: makeCryptoCache(),
        telemetry,
        openPGPCryptoModule: crypto.openPGPCryptoModule,
        account,
        srpModule: srp,
    });

    return { credentials, apiClient, accountApi, srp, addresses, account, httpClient, sdk };
}
