import { NodeType } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';
import { logger } from '../logger';
import { initOpenPGPCryptoModule } from '../proton/crypto';
import { loginInteractive } from './auth';

async function main(): Promise<void> {
    const command = process.argv[2] ?? 'login';

    if (command === 'selftest') {
        const { generateKeySalt } = await import('@protontech/crypto/srp');
        initOpenPGPCryptoModule();
        const salt = generateKeySalt();
        logger.info('crypto selftest OK');
        logger.info(`OpenPGP endpoint initialised; SRP module loaded; sample key salt: ${salt}`);
        return;
    }

    const session = await loginInteractive();
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

main().catch((error) => {
    logger.error('Fatal', error);
    process.exit(1);
});
