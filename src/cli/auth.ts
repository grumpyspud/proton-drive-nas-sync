import { login, MailboxPasswordRequiredError, TwoFactorRequiredError, type LoginOptions } from '../auth/login';
import { logger } from '../logger';
import { buildSession, type ProtonSession } from '../proton/sdk';
import { createSessionCredentials } from '../session';
import { prompt, promptHidden } from './prompt';

/**
 * Interactive login: prompts for username/password (password hidden), then for
 * 2FA / mailbox password only if the account requires them. Falls back to
 * PDN_USERNAME / PDN_PASSWORD / PDN_TWO_FACTOR / PDN_MAILBOX_PASSWORD env vars.
 *
 * When `persist` is true, the session is stored as an AES-256-GCM encrypted
 * blob (see src/session/persistentCredentials.ts) so it can be resumed without
 * re-entering credentials.
 */
export async function loginInteractive(options: { persist?: boolean } = {}): Promise<ProtonSession> {
    const username = process.env.PDN_USERNAME ?? (await prompt('Username: '));
    const password = process.env.PDN_PASSWORD ?? (await promptHidden('Password: '));

    const credentials = createSessionCredentials({ persist: options.persist ?? false });
    const session = buildSession(credentials, logger);

    const base: LoginOptions = {
        username,
        password,
        twoFactorCode: process.env.PDN_TWO_FACTOR,
        mailboxPassword: process.env.PDN_MAILBOX_PASSWORD,
    };

    let result;
    try {
        result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, base);
    } catch (error) {
        if (error instanceof TwoFactorRequiredError) {
            const code = await prompt('2FA code: ');
            result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, {
                ...base,
                twoFactorCode: code,
            });
        } else if (error instanceof MailboxPasswordRequiredError) {
            const mailbox = await promptHidden('Mailbox password: ');
            result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, {
                ...base,
                mailboxPassword: mailbox,
            });
        } else {
            throw error;
        }
    }

    logger.info(`Logged in as ${username} (uid=${result.uid}, passwordMode=${result.passwordMode})`);
    return session;
}
