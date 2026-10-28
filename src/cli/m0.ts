import { NodeType } from '@protontech/drive-sdk';
import {
    login,
    MailboxPasswordRequiredError,
    TwoFactorRequiredError,
    type LoginOptions,
} from '../auth/login';
import { logger } from '../logger';
import { buildSession } from '../proton/sdk';
import { InMemoryCredentials } from '../session/credentials';
import { prompt, promptHidden } from './prompt';

function nodeName(name: { ok: boolean } & Record<string, unknown>): string {
    return name.ok ? String(name.value) : '(unable to decrypt name)';
}

async function main(): Promise<void> {
    const command = process.argv[2] ?? 'login';

    if (command === 'selftest') {
        await selftest();
        return;
    }

    const username = process.env.PDN_USERNAME ?? (await prompt('Username: '));
    const password = process.env.PDN_PASSWORD ?? (await promptHidden('Password: '));

    const credentials = new InMemoryCredentials();
    const session = buildSession(credentials, logger);

    const baseOptions: LoginOptions = {
        username,
        password,
        twoFactorCode: process.env.PDN_TWO_FACTOR,
        mailboxPassword: process.env.PDN_MAILBOX_PASSWORD,
    };

    let result;
    try {
        result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, baseOptions);
    } catch (error) {
        if (error instanceof TwoFactorRequiredError) {
            const code = await prompt('2FA code: ');
            result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, {
                ...baseOptions,
                twoFactorCode: code,
            });
        } else if (error instanceof MailboxPasswordRequiredError) {
            const mailbox = await promptHidden('Mailbox password: ');
            result = await login(session.accountApi, session.apiClient, session.srp, credentials, logger, {
                ...baseOptions,
                mailboxPassword: mailbox,
            });
        } else {
            throw error;
        }
    }

    logger.info(`Logged in as ${username} (uid=${result.uid}, passwordMode=${result.passwordMode})`);

    const root = await session.sdk.getMyFilesRootFolder();
    logger.info(`My Files root: ${nodeName(root.name)} (uid=${root.uid})`);

    let count = 0;
    for await (const child of session.sdk.iterateFolderChildren(root.uid)) {
        const kind = child.type === NodeType.Folder ? 'dir ' : 'file';
        logger.info(`  [${kind}] ${nodeName(child.name)}  (uid=${child.uid})`);
        count++;
    }
    logger.info(`Listed ${count} children.`);
}

async function selftest(): Promise<void> {
    const { initOpenPGPCryptoModule } = await import('../proton/crypto');
    const { generateKeySalt } = await import('@protontech/crypto/srp');

    initOpenPGPCryptoModule();
    const salt = generateKeySalt();

    logger.info('crypto selftest OK');
    logger.info(`OpenPGP endpoint initialised; SRP module loaded; sample key salt: ${salt}`);
}

main().catch((error) => {
    logger.error('Fatal', error);
    process.exit(1);
});
