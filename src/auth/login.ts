import type { AccountApi } from '../../vendor/proton-drive-sdk-account/accountApi';
import type { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';
import type { Srp } from '../../vendor/proton-drive-sdk-account/srp';
import type { SessionCredentials } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import type { Logger } from '../logger';

export interface LoginOptions {
    username: string;
    password: string;
    twoFactorCode?: string;
    mailboxPassword?: string;
}

export interface LoginResult {
    uid: string;
    accessToken: string;
    refreshToken?: string;
    passwordMode: number;
}

/**
 * Full password login, extending the SDK's reference `authViaPassword` with the
 * two pieces it omits: TOTP 2FA and two-password mode.
 *
 * Flow:
 *   1. /auth/info  -> SRP parameters
 *   2. getSrp()    -> client proof + ephemeral
 *   3. /auth       -> UID/accessToken/refreshToken + server proof
 *   4. verify server proof
 *   5. if 2FA enabled -> /auth/v4/2fa with the TOTP code
 *   6. derive the user key password (mailbox password in two-password mode)
 *   7. store session + user key password
 */
export async function login(
    accountApi: AccountApi,
    apiClient: ApiClient,
    srp: Srp,
    credentials: SessionCredentials,
    logger: Logger,
    options: LoginOptions,
): Promise<LoginResult> {
    logger.debug('Fetching auth info');
    const info = await accountApi.info(options.username);
    if (!info.Version || !info.Modulus || !info.SRPSession || !info.ServerEphemeral || !info.Salt) {
        throw new Error('Missing required auth info fields');
    }

    logger.debug('Generating SRP proofs');
    const { clientEphemeral, clientProof, expectedServerProof } = await srp.getSrp(
        info.Version,
        info.Modulus,
        info.ServerEphemeral,
        info.Salt,
        options.password,
    );

    logger.debug('Authenticating');
    const authResponse = await accountApi.auth({
        Username: options.username,
        SRPSession: info.SRPSession,
        PersistentCookies: 1,
        Payload: {},
        ClientProof: clientProof,
        ClientEphemeral: clientEphemeral,
    });

    if (!authResponse.ServerProof) {
        throw new Error('Missing ServerProof');
    }
    if (authResponse.ServerProof !== expectedServerProof) {
        throw new Error('Server proof verification failed');
    }
    if (!authResponse.UID || !authResponse.AccessToken) {
        throw new Error('Missing UID or AccessToken');
    }

    const twoFactorEnabled = (authResponse['2FA']?.Enabled ?? authResponse.TwoFactor ?? 0) !== 0;
    if (twoFactorEnabled && !options.twoFactorCode) {
        throw new TwoFactorRequiredError();
    }

    // Arm the authenticated HTTP client before any authenticated call.
    await credentials.setSessionInfo({
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken,
        ...(authResponse.RefreshToken !== undefined && { refreshToken: authResponse.RefreshToken }),
    });

    if (twoFactorEnabled) {
        logger.debug('Submitting 2FA code');
        await apiClient.authenticatedRequest
            .post(`${apiClient.baseUrlWithProtocol}/auth/v4/2fa`, { json: { TwoFactorCode: options.twoFactorCode } })
            .json();
    }

    const passwordMode = authResponse.PasswordMode ?? 1;
    const keyPassword = passwordMode === 2 ? options.mailboxPassword : options.password;
    if (!keyPassword) {
        throw new MailboxPasswordRequiredError();
    }

    logger.debug('Deriving user key password');
    const salts = await accountApi.salts();
    const userKeySalt = salts.KeySalts?.at(0)?.KeySalt;
    if (!userKeySalt) {
        throw new Error('Missing KeySalt');
    }
    const userKeyPassword = await srp.computeKeyPassword(keyPassword, userKeySalt);
    await credentials.setUserKeyPassword(userKeyPassword);

    return {
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken,
        refreshToken: authResponse.RefreshToken,
        passwordMode,
    };
}

export class TwoFactorRequiredError extends Error {
    constructor() {
        super('Two-factor authentication is required');
        this.name = 'TwoFactorRequiredError';
    }
}

export class MailboxPasswordRequiredError extends Error {
    constructor() {
        super('Mailbox password is required in two-password mode');
        this.name = 'MailboxPasswordRequiredError';
    }
}
