import path from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { sha256OfFile, uploadFile, uploadFileRevision } from '../fs/files';
import type { StateDB } from '../state/db';
import { assertSourceAvailable, checkDeletionTripwire } from './safety';
import { drain } from './util';
import { walkDriveTree, walkLocalTree } from './walk';

export interface BackupOptions {
    sdk: ProtonDriveClient;
    sourceDir: string;
    driveParentUid: string;
    stateDb: StateDB;
    /** When true, also remove Drive nodes that no longer exist locally (gated by the tripwire). */
    mirror?: boolean;
    deletionThresholdPct?: number;
    log?: (msg: string) => void;
}

export interface BackupResult {
    uploaded: number;
    skipped: number;
    foldersCreated: number;
    deleted: number;
}

/**
 * One-way NAS -> Drive backup (incremental). Reconciles the local tree into the
 * target Drive folder, uploading new/changed files and creating missing folders.
 *
 * Change detection: size + mtime fast-path; on any change, SHA-256 is compared
 * against the stored hash before uploading. `mirror` additionally trashes Drive
 * files that vanished locally: but only after the source-availability gate and
 * the deletion-rate tripwire both pass.
 */
export async function backup(options: BackupOptions): Promise<BackupResult> {
    const { sdk, sourceDir, driveParentUid, stateDb, mirror = false, deletionThresholdPct, log = () => {} } = options;
    const result: BackupResult = { uploaded: 0, skipped: 0, foldersCreated: 0, deleted: 0 };

    // 1. Source-availability gate.
    await assertSourceAvailable(sourceDir);

    // 2. Walk both trees.
    const local = await walkLocalTree(sourceDir);
    const remote = await walkDriveTree(sdk, driveParentUid);

    const localByRel = new Map(local.map((e) => [e.relPath, e]));
    const remoteByRel = new Map(remote.map((e) => [e.relPath, e]));

    // 3. Reconcile folders (shallow-first so parents exist before children).
    const folders = local
        .filter((e) => e.kind === 'folder')
        .sort((a, b) => a.relPath.split('/').length - b.relPath.split('/').length);
    for (const folder of folders) {
        if (remoteByRel.has(folder.relPath)) continue;
        const parentRel = path.posix.dirname(folder.relPath);
        const parentUid = parentRel === '.' ? driveParentUid : remoteByRel.get(parentRel)?.uid;
        if (!parentUid) throw new Error(`No parent folder for ${folder.relPath}`);
        const created = await sdk.createFolder(parentUid, path.posix.basename(folder.relPath));
        remoteByRel.set(folder.relPath, { relPath: folder.relPath, uid: created.uid, kind: 'folder' });
        stateDb.upsert({ relPath: folder.relPath, kind: 'folder', driveUid: created.uid, sha256: null, size: null, mtimeMs: null });
        result.foldersCreated++;
        log(`created folder ${folder.relPath}`);
    }

    // 4. Reconcile files.
    const files = local.filter((e) => e.kind === 'file');
    for (const file of files) {
        const parentRel = path.posix.dirname(file.relPath);
        const parentUid = parentRel === '.' ? driveParentUid : remoteByRel.get(parentRel)?.uid;
        if (!parentUid) throw new Error(`No parent folder for ${file.relPath}`);

        const existing = remoteByRel.get(file.relPath);
        const db = stateDb.get(file.relPath);

        // Fast path: size + mtime unchanged.
        if (db && db.kind === 'file' && db.size === file.size && db.mtimeMs === file.mtimeMs && existing) {
            result.skipped++;
            continue;
        }

        const hash = await sha256OfFile(file.absPath);
        if (existing && db && db.sha256 === hash) {
            // Content unchanged (metadata-only change): refresh the record, no upload.
            stateDb.upsert({ relPath: file.relPath, kind: 'file', driveUid: existing.uid, sha256: hash, size: file.size, mtimeMs: file.mtimeMs });
            result.skipped++;
            continue;
        }

        const uid = existing
            ? await uploadFileRevision(sdk, existing.uid, file.absPath)
            : await uploadFile(sdk, parentUid, path.posix.basename(file.relPath), file.absPath);
        stateDb.upsert({ relPath: file.relPath, kind: 'file', driveUid: uid, sha256: hash, size: file.size, mtimeMs: file.mtimeMs });
        remoteByRel.set(file.relPath, { relPath: file.relPath, uid, kind: 'file' });
        result.uploaded++;
        log(`uploaded ${file.relPath}`);
    }

    // 5. Mirror deletions (only when requested, always gated).
    if (mirror) {
        const remoteFiles = remote.filter((e) => e.kind === 'file');
        const missing = remoteFiles.filter((e) => !localByRel.has(e.relPath));
        checkDeletionTripwire({ totalTracked: remoteFiles.length, deletions: missing.length, thresholdPct: deletionThresholdPct });
        for (const entry of missing) {
            await drain(sdk.trashNodes([entry.uid]));
            stateDb.remove(entry.relPath);
            result.deleted++;
            log(`trashed ${entry.relPath}`);
        }
    }

    return result;
}
