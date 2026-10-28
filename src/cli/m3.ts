import path from 'node:path';
import { NodeType } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';
import { backup } from '../engine/backup';
import { restore } from '../engine/restore';
import { logger } from '../logger';
import { configDir } from '../crypto/keySource';
import { StateDB } from '../state/db';
import { loginInteractive } from './auth';

function req(args: string[], index: number, what: string): string {
    const value = args[index];
    if (!value) {
        logger.error(`Missing required argument: ${what}`);
        process.exit(1);
    }
    return value;
}

function stateDbPath(): string {
    return process.env.PDN_STATE_DB ?? path.join(configDir(), 'state.db');
}

async function findOrCreateFolder(sdk: Awaited<ReturnType<typeof loginInteractive>>['sdk'], parentUid: string, name: string): Promise<string> {
    for await (const child of sdk.iterateFolderChildren(parentUid)) {
        if (nodeName(child.name) === name && child.type === NodeType.Folder) return child.uid;
    }
    const created = await sdk.createFolder(parentUid, name);
    logger.info(`Created Drive folder "${name}" (uid=${created.uid})`);
    return created.uid;
}

async function runBackup(args: string[], mirror: boolean) {
    const sourceDir = req(args, 0, 'sourceDir');
    const driveFolderName = req(args, 1, 'driveFolderName');

    const session = await loginInteractive();
    const sdk = session.sdk;
    const root = await sdk.getMyFilesRootFolder();
    const parentUid = await findOrCreateFolder(sdk, root.uid, driveFolderName);

    const db = new StateDB(stateDbPath());
    const result = await backup({
        sdk,
        sourceDir,
        driveParentUid: parentUid,
        stateDb: db,
        mirror,
        log: (msg) => logger.info(msg),
    });
    db.close();

    logger.info(
        `Backup complete: ${result.uploaded} uploaded, ${result.skipped} unchanged, ` +
            `${result.foldersCreated} folders created, ${result.deleted} trashed`,
    );
}

async function runRestore(args: string[]) {
    const driveFolderName = req(args, 0, 'driveFolderName');
    const destDir = req(args, 1, 'destDir');

    const session = await loginInteractive();
    const sdk = session.sdk;
    const root = await sdk.getMyFilesRootFolder();

    // Resolve the Drive folder by name (no search API, so scan root children).
    let folderUid: string | undefined;
    for await (const child of sdk.iterateFolderChildren(root.uid)) {
        if (nodeName(child.name) === driveFolderName && child.type === NodeType.Folder) folderUid = child.uid;
    }
    if (!folderUid) {
        logger.error(`Drive folder "${driveFolderName}" not found in My Files root.`);
        process.exit(1);
    }

    const result = await restore({ sdk, driveFolderUid: folderUid, destDir, log: (msg) => logger.info(msg) });
    logger.info(`Restore complete: ${result.filesDownloaded} files, ${result.foldersCreated} folders -> ${destDir}`);
}

async function runDb() {
    const db = new StateDB(stateDbPath());
    const records = db.all();
    logger.info(`State DB (${records.length} records):`);
    for (const r of records) {
        logger.info(`  [${r.kind}] ${r.relPath}  (drive_uid=${r.driveUid ?? '?'}, sha256=${r.sha256 ? r.sha256.slice(0, 12) + '…' : 'null'})`);
    }
    db.close();
}

async function main() {
    const command = process.argv[2] ?? 'help';
    const args = process.argv.slice(3);

    switch (command) {
        case 'backup':
            await runBackup(args, false);
            return;
        case 'mirror':
            await runBackup(args, true);
            return;
        case 'restore':
            await runRestore(args);
            return;
        case 'db':
            await runDb();
            return;
        default:
            logger.error('Usage: npm run m3 -- <backup|mirror|restore|db> [args]');
            logger.error('  backup  <sourceDir> <driveFolderName>   incremental NAS -> Drive (additive)');
            logger.error('  mirror  <sourceDir> <driveFolderName>   like backup + trash Drive nodes removed locally (gated)');
            logger.error('  restore <driveFolderName> <destDir>      Drive -> NAS');
            logger.error('  db                                         dump the state DB');
            process.exit(1);
    }
}

main().catch((error) => {
    logger.error('Fatal', error);
    process.exit(1);
});
