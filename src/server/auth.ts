import { Auth } from '../../vendor/proton-drive-sdk-account/auth';
import {
    beginLogin,
    completeLogin,
    HumanVerificationRequiredError,
    MailboxPasswordRequiredError,
    TwoFactorRequiredError,
    type LoginOptions,
    type PendingLogin,
} from '../auth/login';
import { ACCOUNT_URL, AUTH_CLIENT_ID } from '../config';
import { logger } from '../logger';
import { resetCryptoBackend } from '../proton/cryptoBackend';
import { buildSession, type ProtonSession } from '../proton/sdk';
import { createSessionCredentials } from '../session';

/** State of the browser sign-in, as reported to the UI. */
export interface WebLoginState {
    status: 'idle' | 'pending' | 'authenticated' | 'failed' | 'cancelled';
    /** Epoch ms when the current sign-in link was issued (pending only). */
    startedAt?: number;
    uid?: string;
    error?: string;
}

/** Result of an in-app (SRP) login attempt, as reported to the UI. */
export interface LoginResponse {
    authenticated: boolean;
    twoFactorRequired?: boolean;
    mailboxPasswordRequired?: boolean;
    humanVerificationRequired?: boolean;
    webUrl?: string;
    humanVerificationToken?: string;
    methods?: string[];
    uid?: string;
    error?: string;
}

interface WebLoginAttempt {
    state: WebLoginState;
    abort: AbortController;
}

export class AlreadySignedInError extends Error {
    constructor() {
        super('Already signed in to Proton. Sign out first.');
        this.name = 'AlreadySignedInError';
    }
}

/**
 * Holds the server's single Proton session. Signing in persists an AES-256-GCM
 * encrypted session blob so a restart can resume without signing in again.
 *
 * Two sign-in methods are available, selected at startup by `PDN_AUTH_METHOD`:
 *   - `browser` (default): sign in on account.proton.me ("session fork") and
 *     Proton hands this app a session. The password, 2FA code and mailbox
 *     password never reach this app (see `startWebLogin`).
 *   - `srp`: the original in-app username/password form. Login is a multi-step
 *     flow (password -> CAPTCHA -> 2FA -> two-password); the intermediate state
 *     (scoped access token + SRP proof result) is held in `pendingSession` /
 *     `pending` between steps so the follow-up steps never re-issue /auth.
 */
class AuthService {
    private session: ProtonSession | null = null;
    private pendingSession: ProtonSession | null = null;
    private pending: PendingLogin | null = null;
    private webLogin: WebLoginAttempt | null = null;

    isAuthenticated(): boolean {
        return this.session !== null;
    }

    getSession(): ProtonSession {
        if (!this.session) throw new Error('Not authenticated');
        return this.session;
    }

    /**
     * In-app SRP login (PDN_AUTH_METHOD=srp). Multi-step: phase 1 (auth/info +
     * auth), then CAPTCHA / 2FA / two-password as Proton demands. Returns the
     * state needed to drive the next step (or `authenticated: true` on success).
     */
    async login(
        username: string,
        password: string,
        twoFactorCode?: string,
        mailboxPassword?: string,
        humanVerificationToken?: string,
    ): Promise<LoginResponse> {
        try {
            // Mid-flow: continue from the pending state (2FA / two-password).
            if (this.pending && this.pendingSession) {
                const result = await completeLogin(this.pendingSession, this.pending, logger, twoFactorCode, mailboxPassword);
                this.session = this.pendingSession;
                this.pendingSession = null;
                this.pending = null;
                logger.info(`Logged in as ${username} (uid=${result.uid})`);
                return { authenticated: true, uid: result.uid };
            }

            // Fresh login: build a session and run phase 1 (auth/info + auth).
            const credentials = createSessionCredentials({ persist: true });
            const session = await buildSession(credentials, logger);
            const options: LoginOptions = { username, password, humanVerificationToken };
            const pending = await beginLogin(session, logger, options);
            this.pendingSession = session;
            this.pending = pending;

            const result = await completeLogin(session, pending, logger, twoFactorCode, mailboxPassword);
            this.session = session;
            this.pendingSession = null;
            this.pending = null;
            logger.info(`Logged in as ${username} (uid=${result.uid})`);
            return { authenticated: true, uid: result.uid };
        } catch (error) {
            if (error instanceof HumanVerificationRequiredError) {
                return {
                    authenticated: false,
                    humanVerificationRequired: true,
                    webUrl: error.details.webUrl,
                    humanVerificationToken: error.details.token,
                    methods: error.details.methods,
                };
            }
            if (error instanceof TwoFactorRequiredError) {
                return { authenticated: false, twoFactorRequired: true };
            }
            if (error instanceof MailboxPasswordRequiredError) {
                return { authenticated: false, mailboxPasswordRequired: true };
            }
            const message = (error as Error).message ?? String(error);
            logger.error('Login failed', error);
            // Hard failure: drop any partial state so the next attempt starts fresh.
            this.pendingSession = null;
            this.pending = null;
            return { authenticated: false, error: message };
        }
    }

    /**
     * Start a browser sign-in ("session fork"), the same flow Proton's own Drive
     * CLI uses. The user signs in on account.proton.me, where the password, 2FA
     * (including security keys) and CAPTCHA are handled by Proton, and Proton
     * hands this app a new session. The key password arrives encrypted with a
     * key that only exists in the link's #fragment, so this app never sees the
     * password, 2FA code, or mailbox password.
     *
     * Resolves with the sign-in link as soon as Proton issues it; completion is
     * polled in the background (see getWebLoginState) and the link expires after
     * 10 minutes. Starting again cancels the previous attempt, so only the newest
     * link can sign the app in.
     */
    async startWebLogin(): Promise<{ signInUrl: string }> {
        if (this.session) throw new AlreadySignedInError();
        this.cancelWebLogin();

        const credentials = createSessionCredentials({ persist: true });
        const session = await buildSession(credentials, logger);
        const auth = new Auth(AUTH_CLIENT_ID, session.accountApi, credentials, session.srp, logger, ACCOUNT_URL);

        const attempt: WebLoginAttempt = {
            state: { status: 'pending', startedAt: Date.now() },
            abort: new AbortController(),
        };
        this.webLogin = attempt;

        let linkIssued!: (url: string) => void;
        let linkFailed!: (error: unknown) => void;
        const signInUrl = new Promise<string>((resolve, reject) => {
            linkIssued = resolve;
            linkFailed = reject;
        });

        auth.authViaWeb((url) => linkIssued(url), attempt.abort.signal).then(
            (result) => {
                // Cancelled or superseded while the final status poll was in
                // flight: leave this session unused.
                if (this.webLogin !== attempt || attempt.abort.signal.aborted) return;
                this.session = session;
                attempt.state = { status: 'authenticated', uid: result.uid };
                logger.info(`Signed in via browser (uid=${result.uid})`);
            },
            (error: unknown) => {
                linkFailed(error); // no-op once the link was issued
                if (this.webLogin !== attempt || attempt.abort.signal.aborted) return;
                const message = error instanceof Error ? error.message : String(error);
                attempt.state = { status: 'failed', error: message };
                logger.error('Browser sign-in failed', error);
            },
        );

        return { signInUrl: await signInUrl };
    }

    /** Progress of the current browser sign-in, for the UI to poll. */
    getWebLoginState(): WebLoginState {
        if (this.webLogin) return this.webLogin.state;
        return { status: this.session ? 'authenticated' : 'idle' };
    }

    /** Stop waiting for a pending browser sign-in; its link stops working here. */
    cancelWebLogin(): void {
        const attempt = this.webLogin;
        if (!attempt) return;
        if (attempt.state.status === 'pending') {
            attempt.abort.abort();
            logger.info('Browser sign-in cancelled');
        }
        this.webLogin = null;
    }

    /** Load a persisted session blob and refresh the token. Returns false if none. */
    async resume(): Promise<boolean> {
        try {
            const credentials = createSessionCredentials({ persist: true });
            await credentials.load();
            if (!credentials.uid || !credentials.refreshToken) return false;
            if (!credentials.getUserKeyPassword()) {
                logger.warn('Session resume failed: persisted session has no user key password (incomplete login)');
                return false;
            }
            const session = await buildSession(credentials, logger);
            const refreshed = await session.apiClient.refreshSessionIfPossible();
            if (!refreshed) return false;
            this.session = session;
            logger.info(`Resumed session (uid=${credentials.uid})`);
            return true;
        } catch (error) {
            logger.warn(`Session resume failed: ${(error as Error).message ?? error}`);
            return false;
        }
    }

    async logout(): Promise<void> {
        this.cancelWebLogin();
        if (this.session) {
            await this.session.credentials.signOut().catch(() => {});
        }
        this.session = null;
        this.pendingSession = null;
        this.pending = null;
        resetCryptoBackend();
        logger.info('Logged out');
    }
}

export const authService = new AuthService();
