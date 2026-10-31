import { randomUUID } from 'node:crypto';
import { MemoryCache, NullCache, ProtonDriveClient, type ProtonDriveCache } from '@protontech/drive-sdk';
import { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';
import { AccountApi } from '../../vendor/proton-drive-sdk-account/accountApi';
import { Addresses } from '../../vendor/proton-drive-sdk-account/addresses';
import { Srp } from '../../vendor/proton-drive-sdk-account/srp';
import type { SessionCredentials } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import type { Logger } from '../logger';
import { APP_VERSION, BASE_URL, CACHE_LRU_MAX, CACHE_MODE, SDK_VERSION } from '../config';
import { telemetry } from '../logger';
import { DriveAccountAdapter } from './accountAdapter';
import { createOpenPGPBackend, type CryptoBackend } from './cryptoBackend';
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
 * Builds a cache backend for the Drive SDK, selected by the `PDN_CACHE` env var:
 *   `memory` (default) - unbounded in-memory cache,
 *   `null`             - cache disabled (every scan is cold),
 *   `lru`              - bounded least-recently-used cache (see CACHE_LRU_MAX).
 */
function makeCache<T>(): ProtonDriveCache<T> {
    switch (CACHE_MODE) {
        case 'null':
            return new NullCache<T>();
        case 'lru':
            return new LruCache<T>(CACHE_LRU_MAX);
        case 'memory':
        default:
            return new MemoryCache<T>();
    }
}

/**
 * Wires the vendored account module together with the Drive SDK, mirroring the
 * reference CLI's `init()` + `initApi()`. All crypto flows through `backend`
 * (defaults to the OpenPGP backend) so the upcoming crypto-model migration is a
 * one-line swap at startup.
 */
export async function buildSession(credentials: SessionCredentials, logger: Logger, backend?: CryptoBackend): Promise<ProtonSession> {
    const crypto = backend ?? (await createOpenPGPBackend());

    logger.info(`Drive SDK cache: ${CACHE_MODE}${CACHE_MODE === 'lru' ? ` (max ${CACHE_LRU_MAX} entries)` : ''}`);

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
        entitiesCache: makeCache(),
        cryptoCache: makeCache(),
        telemetry,
        openPGPCryptoModule: crypto.openPGPCryptoModule,
        account,
        srpModule: srp,
    });

    return { credentials, apiClient, accountApi, srp, addresses, account, httpClient, sdk };
}
