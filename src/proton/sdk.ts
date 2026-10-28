import { randomUUID } from 'node:crypto';
import { CryptoProxy } from '@protontech/crypto';
import type { CryptoApiInterface } from '@protontech/crypto';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
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
import { HTTPClient } from './httpClient';
import { initOpenPGPCryptoModule } from './crypto';

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
 * reference CLI's `init()` + `initApi()`.
 */
export function buildSession(credentials: SessionCredentials, logger: Logger): ProtonSession {
    // Initialise the crypto endpoint first, so CryptoProxy is ready before any
    // keyring unlock happens inside Addresses.
    const openPGPCryptoModule = initOpenPGPCryptoModule();

    const apiClient = new ApiClient({
        baseUrl: BASE_URL,
        appVersion: APP_VERSION,
        credentials,
        logger,
        headers: { 'x-pm-drive-sdk-version': SDK_VERSION },
    });

    const accountApi = new AccountApi(apiClient);
    const srp = new Srp(accountApi, { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp });
    const cryptoProxy: CryptoApiInterface = CryptoProxy;
    const addresses = new Addresses(accountApi, credentials, cryptoProxy, logger);
    const account = new DriveAccountAdapter(addresses);
    const httpClient = new HTTPClient(apiClient);

    const sdk = new ProtonDriveClient({
        config: { baseUrl: BASE_URL, clientUid: `pdn-${randomUUID()}` },
        httpClient,
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        telemetry,
        openPGPCryptoModule,
        account,
        srpModule: srp,
    });

    return { credentials, apiClient, accountApi, srp, addresses, account, httpClient, sdk };
}
