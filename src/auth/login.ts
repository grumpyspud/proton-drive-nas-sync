import { AccountApiError } from '../../vendor/proton-drive-sdk-account/accountApi';
import type { AccountApi } from '../../vendor/proton-drive-sdk-account/accountApi';
import type { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';
import type { Srp } from '../../vendor/proton-drive-sdk-account/srp';
import type { SessionCredentials } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import type { Logger } from '../logger';

export interface LoginOptions {
    username: string;
    password: string;
    humanVerificationToken?: string;
}

export interface LoginResult {
    uid: string;
    accessToken: string;
    refreshToken?: string;
    passwordMode: number;
}

export interface HumanVerificationDetails {
    webUrl?: string;
    token?: string;
    methods: string[];
}

/** The subset of the Proton session the login flow needs. */
export interface LoginSession {
    accountApi: AccountApi;
    apiClient: ApiClient;
    srp: Srp;
    credentials: SessionCredentials;
}

interface AuthInfo {
    Version?: number;
    Modulus?: string;
    SRPSession?: string;
    ServerEphemeral?: string;
    Salt?: string;
}

interface AuthResponse {
    UID?: string;
    AccessToken?: string;
    RefreshToken?: string;
    ServerProof?: string;
    PasswordMode?: number;
    TwoFactor?: number;
    '2FA'?: { Enabled?: number };
}

/**
 * State persisted between the password step and the 2FA / two-password steps.
 * The scoped access token from /auth is armed on the session, so the follow-up
 * steps never re-issue /auth (which would re-trigger CAPTCHA / invalidate the
 * single-use human-verification token).
 */
export interface PendingLogin {
    authResponse: AuthResponse;
    loginPassword: string;
    twoFactorDone: boolean;
}

function hvHeaders(token?: string): Record<string, string> {
    if (!token) return {};
    return {
        'x-pm-human-verification-token': token,
        'x-pm-human-verification-token-type': 'captcha',
    };
}

/** Proton error 9001 = human-verification (CAPTCHA) required. */
function extractHumanVerification(body: unknown): HumanVerificationDetails | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as { Code?: number; Details?: Record<string, unknown> };
    if (b.Code !== 9001) return null;
    const d = b.Details ?? {};
    return {
        webUrl: typeof d.WebUrl === 'string' ? d.WebUrl : undefined,
        token: typeof d.HumanVerificationToken === 'string' ? d.HumanVerificationToken : undefined,
        methods: Array.isArray(d.HumanVerificationMethods) ? (d.HumanVerificationMethods as string[]) : [],
    };
}

function makeApiError(status: number, body: unknown): AccountApiError {
    const b = (body ?? {}) as { Code?: number; Error?: string };
    return new AccountApiError(
        typeof b.Error === 'string' && b.Error ? b.Error : `Request failed with status code ${status}`,
        { httpCode: status, code: typeof b.Code === 'number' ? b.Code : 0, debug: (body as object) ?? undefined },
    );
}

async function postInfo(apiClient: ApiClient, username: string, hvToken?: string): Promise<AuthInfo> {
    const response = await apiClient.unauthenticatedRequest.post(
        `${apiClient.baseUrlWithProtocol}/core/v4/auth/info`,
        { json: { Intent: 'Proton', Username: username }, headers: hvHeaders(hvToken), throwHttpErrors: false },
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
        const hv = extractHumanVerification(body);
        if (hv) throw new HumanVerificationRequiredError(hv);
        throw makeApiError(response.status, body);
    }
    if (body && typeof body === 'object' && 'Modulus' in body) return body as AuthInfo;
    throw new AccountApiError('Invalid auth response', { debug: body as object });
}

async function postAuth(apiClient: ApiClient, data: Record<string, unknown>, hvToken?: string): Promise<AuthResponse> {
    const response = await apiClient.unauthenticatedRequest.post(`${apiClient.baseUrlWithProtocol}/core/v4/auth`, {
        json: data,
        headers: hvHeaders(hvToken),
        throwHttpErrors: false,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
        const hv = extractHumanVerification(body);
        if (hv) throw new HumanVerificationRequiredError(hv);
        throw makeApiError(response.status, body);
    }
    return (body as AuthResponse) ?? {};
}

export class HumanVerificationRequiredError extends Error {
    constructor(public readonly details: HumanVerificationDetails) {
        super('Human verification (CAPTCHA) required');
        this.name = 'HumanVerificationRequiredError';
    }
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

/**
 * Phase 1 of login: /auth/info -> SRP -> /auth (with the human-verification
 * token when retrying a 9001). On success the scoped access token is armed on
 * the session and the pending state is returned. Throws
 * HumanVerificationRequiredError on code 9001.
 */
export async function beginLogin(
    session: LoginSession,
    logger: Logger,
    options: LoginOptions,
): Promise<PendingLogin> {
    const { apiClient, srp, credentials } = session;

    logger.debug('Fetching auth info');
    const info = await postInfo(apiClient, options.username, options.humanVerificationToken);
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
    const authResponse = await postAuth(
        apiClient,
        {
            Username: options.username,
            SRPSession: info.SRPSession,
            PersistentCookies: 1,
            Payload: {},
            ClientProof: clientProof,
            ClientEphemeral: clientEphemeral,
        },
        options.humanVerificationToken,
    );

    if (!authResponse.ServerProof) {
        throw new Error('Missing ServerProof');
    }
    if (authResponse.ServerProof !== expectedServerProof) {
        throw new Error('Server proof verification failed');
    }
    if (!authResponse.UID || !authResponse.AccessToken) {
        throw new Error('Missing UID or AccessToken');
    }

    await credentials.setSessionInfo({
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken,
        ...(authResponse.RefreshToken !== undefined && { refreshToken: authResponse.RefreshToken }),
    });

    return { authResponse, loginPassword: options.password, twoFactorDone: false };
}

/**
 * Phase 2 of login: submit 2FA (if enabled and not yet done) then derive the
 * user key password (mailbox password in two-password mode). Resumes from the
 * pending state: /auth is never re-issued.
 */
export async function completeLogin(
    session: LoginSession,
    pending: PendingLogin,
    logger: Logger,
    twoFactorCode?: string,
    mailboxPassword?: string,
): Promise<LoginResult> {
    const { accountApi, apiClient, srp, credentials } = session;
    const { authResponse, loginPassword } = pending;

    const twoFactorEnabled = (authResponse['2FA']?.Enabled ?? authResponse.TwoFactor ?? 0) !== 0;
    if (twoFactorEnabled && !pending.twoFactorDone) {
        if (!twoFactorCode) {
            throw new TwoFactorRequiredError();
        }
        logger.debug('Submitting 2FA code');
        await apiClient.authenticatedRequest
            .post(`${apiClient.baseUrlWithProtocol}/auth/v4/2fa`, { json: { TwoFactorCode: twoFactorCode } })
            .json();
        pending.twoFactorDone = true;
    }

    const passwordMode = authResponse.PasswordMode ?? 1;
    const keyPassword = passwordMode === 2 ? mailboxPassword : loginPassword;
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
        uid: authResponse.UID!,
        accessToken: authResponse.AccessToken!,
        refreshToken: authResponse.RefreshToken,
        passwordMode,
    };
}
