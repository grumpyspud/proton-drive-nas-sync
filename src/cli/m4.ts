import { createHash } from 'node:crypto';
import path from 'node:path';
import { NodeType } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';
import { syncOnce } from '../engine/sync';
import { logger } from '../logger';
import { configDir } from '../crypto/keySource';
import { SyncDB } from '../state/syncDb';
import { loginInteractive } from './auth';

function req(args: string[], index: number, what: string): string {
    const value = args[index];
    if (!value) {
        logger.error(`Missing required argument: ${what}`);
        process.exit(1);
    }
    return value;
}

function pairId(localDir: string, driveFolderName: string): string {
    return createHash('sha256').update(`${localDir}\n${driveFolderName}`).digest('hex').slice(0, 16);
}

function syncDbPath(): string {
    return process.env.PDN_STATE_DB ?? path.join(configDir(), 'sync.db');
}

async function findOrCreateFolder(sdk: Awaited<ReturnType<typeof loginInteractive>>['sdk'], parentUid: string, name: string): Promise<string> {
    for await (const child of sdk.iterateFolderChildren(parentUid)) {
        if (nodeName(child.name) === name && child.type === NodeType.Folder) return child.uid;
    }
    const created = await sdk.createFolder(parentUid, name);
    logger.info(`Created Drive folder "${name}" (uid=${created.uid})`);
    return created.uid;
}

async function runSync(args: string[], watch: boolean) {
    const localDir = req(args, 0, 'localDir');
    const driveFolderName = req(args, 1, 'driveFolderName');

    const session = await loginInteractive();
    const sdk = session.sdk;
    const root = await sdk.getMyFilesRootFolder();
    const driveFolderUid = await findOrCreateFolder(sdk, root.uid, driveFolderName);

    const db = new SyncDB(syncDbPath());
    const id = pairId(localDir, driveFolderName);
    db.upsertPair({ id, localDir, driveFolderName, driveFolderUid, lastSyncAt: null, dedupeEnabled: false, dedupeMinBytes: 0 });

    const run = async () => {
        const result = await syncOnce({ sdk, pairId: id, localDir, driveFolderUid, db, log: (m) => logger.info(m) });
        logger.info(
            `Sync: ${result.uploaded} up, ${result.downloaded} down, ${result.driveTrashed} trashed(Drive), ` +
                `${result.localRecycled} recycled(local), ${result.conflicts} conflicts, ${result.skipped} skipped`,
        );
    };

    if (watch) {
        const intervalSec = parseInt(process.env.PDN_SYNC_INTERVAL ?? '30', 10);
        logger.info(`Watching ${localDir} <-> ${driveFolderName} every ${intervalSec}s (Ctrl-C to stop)`);
        for (;;) {
            await run();
            await new Promise((r) => setTimeout(r, intervalSec * 1000));
        }
    } else {
        await run();
        db.close();
    }
}

async function runPairs() {
    const db = new SyncDB(syncDbPath());
    const pairs = db.listPairs();
    logger.info(`${pairs.length} pair(s):`);
    for (const p of pairs) logger.info(`  ${p.id}  ${p.localDir} <-> ${p.driveFolderName}`);
    db.close();
}

async function main() {
    const command = process.argv[2] ?? 'help';
    const args = process.argv.slice(3);

    switch (command) {
        case 'sync':
            await runSync(args, false);
            return;
        case 'watch':
            await runSync(args, true);
            return;
        case 'pairs':
            await runPairs();
            return;
        default:
            logger.error('Usage: npm run m4 -- <sync|watch|pairs> [args]');
            logger.error('  sync  <localDir> <driveFolderName>   one bidirectional sync cycle');
            logger.error('  watch <localDir> <driveFolderName>   loop (PDN_SYNC_INTERVAL sec, default 30)');
            logger.error('  pairs                                 list configured pairs');
            process.exit(1);
    }
}

main().catch((error) => {
    logger.error('Fatal', error);
    process.exit(1);
});
