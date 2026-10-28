import { login, MailboxPasswordRequiredError, TwoFactorRequiredError, type LoginOptions } from '../auth/login';
import { logger } from '../logger';
import { buildSession, type ProtonSession } from '../proton/sdk';
import { createSessionCredentials } from '../session';

export interface LoginResponse {
    authenticated: boolean;
    twoFactorRequired?: boolean;
    mailboxPasswordRequired?: boolean;
    uid?: string;
    error?: string;
}

/**
 * Holds the server's single Proton session. Login persists an AES-256-GCM
 * encrypted session blob (reuse of M2) so a restart can resume without
 * re-entering credentials. Raw passwords are held only transiently during the
 * login call and are never written to disk.
 */
class AuthService {
    private session: ProtonSession | null = null;

    isAuthenticated(): boolean {
        return this.session !== null;
    }

    getSession(): ProtonSession {
        if (!this.session) throw new Error('Not authenticated');
        return this.session;
    }

    async login(username: string, password: string, twoFactorCode?: string, mailboxPassword?: string): Promise<LoginResponse> {
        const credentials = createSessionCredentials({ persist: true });
        const session = buildSession(credentials, logger);
        const base: LoginOptions = { username, password, twoFactorCode, mailboxPassword };
        try {
            const result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, base);
            this.session = session;
            logger.info(`Logged in as ${username} (uid=${result.uid})`);
            return { authenticated: true, uid: result.uid };
        } catch (error) {
            if (error instanceof TwoFactorRequiredError) {
                return { authenticated: false, twoFactorRequired: true };
            }
            if (error instanceof MailboxPasswordRequiredError) {
                return { authenticated: false, mailboxPasswordRequired: true };
            }
            const message = (error as Error).message ?? String(error);
            logger.error('Login failed', error);
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
        logger.info('Logged out');
    }
}

export const authService = new AuthService();
