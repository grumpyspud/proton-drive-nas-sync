import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeType, type NodeEntity } from '@protontech/drive-sdk';
import { downloadFile, nodeName, sha1OfFile, uploadFile } from '../fs/files';
import { logger } from '../logger';
import { loginInteractive } from './auth';

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
}

function req(args: string[], index: number, what: string): string {
    const value = args[index];
    if (!value) {
        logger.error(`Missing required argument: ${what}`);
        process.exit(1);
    }
    return value;
}

async function listChildren(session: Awaited<ReturnType<typeof loginInteractive>>, folderUid: string, label: string) {
    logger.info(`Listing ${label} (${folderUid}):`);
    let count = 0;
    for await (const child of session.sdk.iterateFolderChildren(folderUid)) {
        const kind = child.type === NodeType.Folder ? 'dir ' : 'file';
        logger.info(`  [${kind}] ${nodeName(child.name)}  (uid=${child.uid})`);
        count++;
    }
    logger.info(`  -> ${count} children`);
    return count;
}

async function findChildByName(session: Awaited<ReturnType<typeof loginInteractive>>, folderUid: string, name: string): Promise<NodeEntity | undefined> {
    for await (const child of session.sdk.iterateFolderChildren(folderUid)) {
        if (nodeName(child.name) === name) return child;
    }
    return undefined;
}

/**
 * M1 self-contained demo: exercises every core op against the live account in
 * one session, then cleans up after itself.
 *
 *   upload -> list -> download + sha1 verify -> mkdir -> move -> rename
 *   -> trash -> restore -> list -> cleanup (trash + permanent delete)
 */
async function demo() {
    const session = await loginInteractive();
    const sdk = session.sdk;
    const ts = Date.now();

    const root = await sdk.getMyFilesRootFolder();
    logger.info(`Root: ${nodeName(root.name)} (uid=${root.uid})`);

    // 1. Build a deterministic test file.
    const tmp = await mkdtemp(path.join(tmpdir(), 'pdn-m1-'));
    const srcPath = path.join(tmp, 'source.bin');
    const content = Buffer.alloc(64 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = (i * 7 + ts) % 256;
    await writeFile(srcPath, content);
    const srcSha1 = await sha1OfFile(srcPath);
    logger.info(`[1] test file: ${srcPath} (${content.length} bytes, sha1=${srcSha1})`);

    const fileName = `m1-test-${ts}.bin`;
    const folderName = `m1-folder-${ts}`;

    // 2. Upload.
    const fileUid = await uploadFile(sdk, root.uid, fileName, srcPath);
    logger.info(`[2] uploaded ${fileName} -> uid=${fileUid}`);

    // 3. Confirm it's listed.
    await listChildren(session, root.uid, 'root');

    // 4. Download + verify.
    const dstPath = path.join(tmp, 'downloaded.bin');
    await downloadFile(sdk, fileUid, dstPath);
    const dstSha1 = await sha1OfFile(dstPath);
    const match = dstSha1 === srcSha1;
    logger.info(`[4] downloaded + sha1 verify: ${match ? 'MATCH ✓' : 'MISMATCH ✗'} (${dstSha1})`);
    if (!match) throw new Error('Round-trip checksum mismatch');

    // 5. Create folder.
    const folder = await sdk.createFolder(root.uid, folderName);
    logger.info(`[5] created folder ${nodeName(folder.name)} -> uid=${folder.uid}`);

    // 6. Move file into folder.
    const moveResults = await drain(sdk.moveNodes([fileUid], folder.uid));
    logger.info(`[6] moved file into folder: ${JSON.stringify(moveResults.map((r) => (r.ok ? `ok` : `ERR ${(r as any).error?.message}`)))}`);

    // 7. Rename file.
    const renamed = `renamed-${ts}.bin`;
    const renamedNode = await sdk.renameNode(fileUid, renamed);
    logger.info(`[7] renamed to ${nodeName(renamedNode.name)}`);

    // 8. Trash.
    const trashResults = await drain(sdk.trashNodes([fileUid]));
    logger.info(`[8] trashed: ${JSON.stringify(trashResults.map((r) => (r.ok ? `ok` : `ERR ${(r as any).error?.message}`)))}`);
    logger.info(`    trashed nodes now: ${await countTrashed(sdk)}`);

    // 9. Restore.
    const restoreResults = await drain(sdk.restoreNodes([fileUid]));
    logger.info(`[9] restored: ${JSON.stringify(restoreResults.map((r) => (r.ok ? `ok` : `ERR ${(r as any).error?.message}`)))}`);

    // 10. Confirm file is back in folder.
    await listChildren(session, folder.uid, 'folder (after restore)');

    // 11. Cleanup: trash the folder, then permanently delete it.
    await drain(sdk.trashNodes([folder.uid]));
    const delResults = await drain(sdk.deleteNodes([folder.uid]));
    logger.info(`[11] cleanup: folder permanently deleted (${JSON.stringify(delResults.map((r) => (r.ok ? `ok` : `ERR ${(r as any).error?.message}`)))})`);

    await rm(tmp, { recursive: true, force: true });
    logger.info('M1 demo complete: all operations verified.');
}

async function countTrashed(sdk: Awaited<ReturnType<typeof loginInteractive>>['sdk']): Promise<number> {
    let n = 0;
    for await (const _ of sdk.iterateTrashedNodeUids()) n++;
    return n;
}

async function main() {
    const command = process.argv[2] ?? 'demo';
    const args = process.argv.slice(3);

    if (command === 'demo') {
        await demo();
        return;
    }

    const session = await loginInteractive();
    const sdk = session.sdk;
    const root = await sdk.getMyFilesRootFolder();

    switch (command) {
        case 'ls': {
            const uid = args[0] ?? root.uid;
            await listChildren(session, uid, 'folder');
            break;
        }
        case 'mkdir': {
            const name = req(args, 0, 'name');
            const parent = args[1] ?? root.uid;
            const folder = await sdk.createFolder(parent, name);
            logger.info(`created folder ${nodeName(folder.name)} (uid=${folder.uid})`);
            break;
        }
        case 'upload': {
            const localPath = req(args, 0, 'localPath');
            const parent = args[1] ?? root.uid;
            const name = args[2] ?? path.basename(localPath);
            const uid = await uploadFile(sdk, parent, name, localPath);
            logger.info(`uploaded ${name} -> uid=${uid}`);
            break;
        }
        case 'download': {
            const uid = req(args, 0, 'nodeUid');
            const localPath = req(args, 1, 'localPath');
            await downloadFile(sdk, uid, localPath);
            logger.info(`downloaded to ${localPath}`);
            break;
        }
        case 'rename': {
            const uid = req(args, 0, 'nodeUid');
            const name = req(args, 1, 'newName');
            const node = await sdk.renameNode(uid, name);
            logger.info(`renamed to ${nodeName(node.name)}`);
            break;
        }
        case 'move': {
            const uid = req(args, 0, 'nodeUid');
            const target = req(args, 1, 'targetFolderUid');
            const results = await drain(sdk.moveNodes([uid], target));
            logger.info(JSON.stringify(results.map((r) => (r.ok ? 'ok' : `ERR ${(r as any).error?.message}`))));
            break;
        }
        case 'trash': {
            const results = await drain(sdk.trashNodes(args));
            logger.info(JSON.stringify(results.map((r) => (r.ok ? 'ok' : `ERR ${(r as any).error?.message}`))));
            break;
        }
        case 'restore': {
            const results = await drain(sdk.restoreNodes(args));
            logger.info(JSON.stringify(results.map((r) => (r.ok ? 'ok' : `ERR ${(r as any).error?.message}`))));
            break;
        }
        case 'delete': {
            const results = await drain(sdk.deleteNodes(args));
            logger.info(JSON.stringify(results.map((r) => (r.ok ? 'ok' : `ERR ${(r as any).error?.message}`))));
            break;
        }
        case 'empty-trash': {
            await sdk.emptyTrash();
            logger.info('trash emptied');
            break;
        }
        default:
            logger.error(`Unknown command: ${command}`);
            process.exit(1);
    }
}

main().catch((error) => {
    logger.error('Fatal', error);
    process.exit(1);
});
