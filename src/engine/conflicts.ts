import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { uploadFileRevision } from '../fs/files';
import { recycleFiles } from '../fs/trash';
import type { ConflictRecord, SyncDB } from '../state/syncDb';

/**
 * Resolve a pending conflict by keeping one version. Soft on both paths: the
 * losing copy is recycled to `.pdn-trash`, never hard-deleted. The node and
 * conflict row are dropped so the next sync re-establishes state from the
 * (now-consistent) files on both sides.
 */
export async function resolveConflictKeep(
    db: SyncDB,
    sdk: ProtonDriveClient,
    pairId: string,
    localDir: string,
    conflict: ConflictRecord,
    keep: 'local' | 'drive',
): Promise<void> {
    const localAbs = join(localDir, ...conflict.relPath.split('/'));
    const conflictAbs = join(localDir, ...conflict.conflictPath.split('/'));

    if (keep === 'local') {
        // Local wins: push it to Drive as a revision, then recycle the preserved
        // Drive copy. `driveUid` is the Drive node holding the other version.
        if (conflict.driveUid) {
            await uploadFileRevision(sdk, conflict.driveUid, localAbs, () => {}, undefined);
        }
        if (existsSync(conflictAbs)) await recycleFiles(localDir, [conflict.conflictPath]);
    } else {
        // Drive wins: recycle the local copy, then promote the preserved Drive
        // copy into the canonical path. Drive already holds this version, so no
        // upload is needed: the next sync sees local == Drive and skips.
        if (existsSync(localAbs)) await recycleFiles(localDir, [conflict.relPath]);
        if (existsSync(conflictAbs)) await rename(conflictAbs, localAbs);
    }

    db.removeNode(pairId, conflict.relPath);
    db.removeConflict(pairId, conflict.conflictPath);
}
