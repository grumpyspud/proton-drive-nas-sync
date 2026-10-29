import { randomUUID } from 'node:crypto';
import { MemoryCache, ProtonDriveClient } from '@protontech/drive-sdk';
import { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';
import { AccountApi } from '../../vendor/proton-drive-sdk-account/accountApi';
import { Addresses } from '../../vendor/proton-drive-sdk-account/addresses';
import { Srp } from '../../vendor/proton-drive-sdk-account/srp';
import type { SessionCredentials } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import type { Logger } from '../logger';
import { APP_VERSION, BASE_URL, SDK_VERSION } from '../config';
import { telemetry } from '../logger';
import { DriveAccountAdapter } from './accountAdapter';
import { createOpenPGPBackend, type CryptoBackend } from './cryptoBackend';
import { HTTPClient } from './httpClient';

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
 * Wires the vendored account module together with the Drive SDK, mirroring the
 * reference CLI's `init()` + `initApi()`. All crypto flows through `backend`
 * (defaults to the OpenPGP backend) so the upcoming crypto-model migration is a
 * one-line swap at startup.
 */
export async function buildSession(credentials: SessionCredentials, logger: Logger, backend?: CryptoBackend): Promise<ProtonSession> {
    const crypto = backend ?? (await createOpenPGPBackend());

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
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        telemetry,
        openPGPCryptoModule: crypto.openPGPCryptoModule,
        account,
        srpModule: srp,
    });

    return { credentials, apiClient, accountApi, srp, addresses, account, httpClient, sdk };
}
