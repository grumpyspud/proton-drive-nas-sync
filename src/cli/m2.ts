import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { NodeType } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';
import { logger } from '../logger';
import { configDir } from '../crypto/keySource';
import { buildSession } from '../proton/sdk';
import { createSessionCredentials } from '../session';
import { loginInteractive } from './auth';

/**
 * M2 — encrypted session persistence + resume.
 *
 *   login   -> interactive login, persist encrypted session blob, list root
 *   resume  -> load persisted blob, refresh token, list root (NO credentials)
 *   logout  -> delete the persisted blob
 */
async function login(): Promise<void> {
    const session = await loginInteractive({ persist: true });
    const blob = path.join(configDir(), 'session.blob');
    logger.info(`Session persisted (encrypted) to ${blob}`);
    await listRoot(session);
}

async function resume(): Promise<void> {
    const credentials = createSessionCredentials({ persist: true });
    await credentials.load();

    if (!credentials.uid || !credentials.refreshToken) {
        logger.error('No persisted session found. Run `npm run m2 login` first.');
        process.exit(1);
    }

    const session = buildSession(credentials, logger);

    logger.info('Refreshing access token from refresh token…');
    const refreshed = await session.apiClient.refreshSessionIfPossible();
    if (!refreshed) {
        logger.error('Session refresh failed (refresh token may be expired or revoked).');
        process.exit(1);
    }

    logger.info(`Resumed session (uid=${credentials.uid}) without re-entering credentials`);
    await listRoot(session);
}

async function listRoot(session: Awaited<ReturnType<typeof buildSession>>): Promise<void> {
    const root = await session.sdk.getMyFilesRootFolder();
    logger.info(`My Files root: ${nodeName(root.name)} (uid=${root.uid})`);
    let count = 0;
    for await (const child of session.sdk.iterateFolderChildren(root.uid)) {
        const kind = child.type === NodeType.Folder ? 'dir ' : 'file';
        logger.info(`  [${kind}] ${nodeName(child.name)}`);
        count++;
    }
    logger.info(`Listed ${count} children.`);
}

async function logout(): Promise<void> {
    await unlink(path.join(configDir(), 'session.blob')).catch(() => {});
    logger.info('Session blob removed.');
}

async function main(): Promise<void> {
    const command = process.argv[2] ?? 'login';
    switch (command) {
        case 'login':
            await login();
            return;
        case 'resume':
            await resume();
            return;
        case 'logout':
            await logout();
            return;
        default:
            logger.error(`Unknown command: ${command}`);
            process.exit(1);
    }
}

main().catch((error) => {
    logger.error('Fatal', error);
    process.exit(1);
});
