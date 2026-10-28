import {
    beginLogin,
    completeLogin,
    HumanVerificationRequiredError,
    MailboxPasswordRequiredError,
    TwoFactorRequiredError,
    type LoginOptions,
    type PendingLogin,
} from '../auth/login';
import { logger } from '../logger';
import { resetCryptoBackend } from '../proton/cryptoBackend';
import { buildSession, type ProtonSession } from '../proton/sdk';
import { createSessionCredentials } from '../session';

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

/**
 * Holds the server's single Proton session. Login persists an AES-256-GCM
 * encrypted session blob (reuse of M2) so a restart can resume without
 * re-entering credentials. Raw passwords are held only transiently during the
 * login call and are never written to disk.
 *
 * Login is a multi-step flow (password -> CAPTCHA -> 2FA -> two-password), and
 * the /auth request must only be issued once. The intermediate state (scoped
 * access token + SRP proof result) is kept in `pendingSession`/`pending`
 * between steps so the follow-up steps never re-issue /auth.
 */
class AuthService {
    private session: ProtonSession | null = null;
    private pendingSession: ProtonSession | null = null;
    private pending: PendingLogin | null = null;

    isAuthenticated(): boolean {
        return this.session !== null;
    }

    getSession(): ProtonSession {
        if (!this.session) throw new Error('Not authenticated');
        return this.session;
    }

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
            const session = buildSession(credentials, logger);
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
            // Hard failure — drop any partial state so the next attempt starts fresh.
            this.pendingSession = null;
            this.pending = null;
            return { authenticated: false, error: message };
        }
    }

    /** Load a persisted session blob and refresh the token. Returns false if none. */
    async resume(): Promise<boolean> {
        try {
            const credentials = createSessionCredentials({ persist: true });
            await credentials.load();
            if (!credentials.uid || !credentials.refreshToken) return false;
            const session = buildSession(credentials, logger);
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
