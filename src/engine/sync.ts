import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { downloadFile, sha1OfFile, uploadFile, uploadFileRevision } from '../fs/files';
import type { SyncDB } from '../state/syncDb';
import { assertSourceAvailable, checkDeletionTripwire } from './safety';
import { drain } from './util';
import { walkDriveTree, walkLocalTree } from './walk';
import type { DriveEntry, LocalEntry } from './walk';

export interface SyncOptions {
    sdk: ProtonDriveClient;
    pairId: string;
    localDir: string;
    driveFolderUid: string;
    db: SyncDB;
    deletionThresholdPct?: number;
    log?: (msg: string) => void;
}

export interface SyncResult {
    uploaded: number;
    downloaded: number;
    localRecycled: number;
    driveTrashed: number;
    conflicts: number;
    skipped: number;
}

interface DriveDeletion {
    relPath: string;
    uid: string;
}

interface LocalDeletion {
    relPath: string;
}

function driveSha1(fingerprint: string | null | undefined): string {
    return (fingerprint ?? '').split('|')[0] ?? '';
}

/**
 * One bidirectional sync cycle for a folder pair. Three-way reconcile of
 * local vs Drive vs last-synced (DB). Deletions are soft on BOTH sides
 * (trash on Drive, recycle to `.pdn-trash` locally) and are gated by the
 * deletion-rate tripwire — never a hard delete.
 */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
    const { sdk, pairId, localDir, driveFolderUid, db, deletionThresholdPct, log = () => {} } = options;
    const result: SyncResult = { uploaded: 0, downloaded: 0, localRecycled: 0, driveTrashed: 0, conflicts: 0, skipped: 0 };

    // 1. Source-availability gate: a missing local dir halts, never mass-deletes.
    await assertSourceAvailable(localDir);

    // 2. Walk both sides.
    const local = await walkLocalTree(localDir);
    const drive = await walkDriveTree(sdk, driveFolderUid);

    const localByRel = new Map(local.map((e) => [e.relPath, e]));
    const driveByRel = new Map(drive.map((e) => [e.relPath, e]));
    const stored = db.allNodes(pairId);
    const storedByRel = new Map(stored.map((n) => [n.relPath, n]));

    const driveDeletions: DriveDeletion[] = [];
    const localDeletions: LocalDeletion[] = [];
    const deletedFolderPrefixes = new Set<string>();

    async function downloadTo(uid: string, localPath: string): Promise<void> {
        await mkdir(path.dirname(localPath), { recursive: true });
        await downloadFile(sdk, uid, localPath);
    }

    // Resolve a conflict: local wins, but the Drive version is preserved
    // locally as `<relPath>.conflict-<ts>` so nothing is lost.
    async function resolveConflict(relPath: string, D: DriveEntry, L: LocalEntry, localSha1: string): Promise<void> {
        const ts = Date.now();
        const conflictPath = path.join(localDir, `${relPath}.conflict-${ts}`);
        await mkdir(path.dirname(conflictPath), { recursive: true });
        await downloadFile(sdk, D.uid, conflictPath);
        const uid = await uploadFileRevision(sdk, D.uid, L.absPath);
        db.upsertNode({
            pairId,
            relPath,
            kind: 'file',
            driveUid: uid,
            driveFingerprint: null,
            localSha1,
            localSize: L.size,
            localMtime: L.mtimeMs,
        });
        log(`conflict on ${relPath}: kept local, saved Drive version as ${path.basename(conflictPath)}`);
    }

    // ---- Folders (create both ways; defer deletions as a unit) ----
    const folderRelPaths = new Set<string>();
    for (const e of local) if (e.kind === 'folder') folderRelPaths.add(e.relPath);
    for (const e of drive) if (e.kind === 'folder') folderRelPaths.add(e.relPath);
    for (const n of stored) if (n.kind === 'folder') folderRelPaths.add(n.relPath);

    const sortedFolders = [...folderRelPaths].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const relPath of sortedFolders) {
        const L = localByRel.get(relPath);
        const D = driveByRel.get(relPath);
        const S = storedByRel.get(relPath);
        const inLocal = !!L;
        const inDrive = !!D;
        const inDb = !!S;

        if (inLocal && !inDrive && !inDb) {
            const parentRel = path.posix.dirname(relPath);
            const parentUid = parentRel === '.' ? driveFolderUid : driveByRel.get(parentRel)?.uid;
            if (!parentUid) throw new Error(`No parent for folder ${relPath}`);
            const created = await sdk.createFolder(parentUid, path.posix.basename(relPath));
            driveByRel.set(relPath, { relPath, uid: created.uid, kind: 'folder', fingerprint: '', node: created });
            db.upsertNode({ pairId, relPath, kind: 'folder', driveUid: created.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
            log(`created folder on Drive: ${relPath}`);
        } else if (!inLocal && inDrive && !inDb) {
            await mkdir(path.join(localDir, relPath), { recursive: true });
            db.upsertNode({ pairId, relPath, kind: 'folder', driveUid: D.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
            log(`created folder locally: ${relPath}`);
        } else if (inLocal && inDrive) {
            if (!inDb) {
                db.upsertNode({ pairId, relPath, kind: 'folder', driveUid: D.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
            }
            // both present — nothing to do
        } else if (inLocal && !inDrive && inDb) {
            deletedFolderPrefixes.add(relPath);
            localDeletions.push({ relPath });
        } else if (!inLocal && inDrive && inDb) {
            deletedFolderPrefixes.add(relPath);
            driveDeletions.push({ relPath, uid: D.uid });
        } else if (!inLocal && !inDrive && inDb) {
            db.removeNode(pairId, relPath);
        }
    }

    const isUnderDeletedFolder = (relPath: string): boolean => {
        for (const p of deletedFolderPrefixes) {
            if (relPath === p || relPath.startsWith(`${p}/`)) return true;
        }
        return false;
    };

    // ---- Files ----
    const fileRelPaths = new Set<string>();
    for (const e of local) if (e.kind === 'file') fileRelPaths.add(e.relPath);
    for (const e of drive) if (e.kind === 'file') fileRelPaths.add(e.relPath);
    for (const n of stored) if (n.kind === 'file') fileRelPaths.add(n.relPath);

    for (const relPath of fileRelPaths) {
        if (isUnderDeletedFolder(relPath)) continue; // covered by the folder deletion

        const L = localByRel.get(relPath);
        const D = driveByRel.get(relPath);
        const S = storedByRel.get(relPath);
        const inLocal = !!L;
        const inDrive = !!D;
        const inDb = !!S;

        if (!inLocal && !inDrive) {
            if (inDb) db.removeNode(pairId, relPath);
            continue;
        }

        const parentRel = path.posix.dirname(relPath);
        const parentUid = parentRel === '.' ? driveFolderUid : driveByRel.get(parentRel)?.uid;

        // Local content hash (fast-path: reuse stored sha1 when size+mtime match).
        let localSha1: string | null = null;
        if (L) {
            if (S && S.localSha1 && S.localSize === L.size && S.localMtime === L.mtimeMs) {
                localSha1 = S.localSha1;
            } else {
                localSha1 = await sha1OfFile(L.absPath);
            }
        }

        const driveFp = D?.fingerprint ?? null;

        // -- new local file --
        if (inLocal && !inDrive && !inDb) {
            if (!parentUid) throw new Error(`No parent for ${relPath}`);
            const uid = await uploadFile(sdk, parentUid, path.posix.basename(relPath), L.absPath);
            db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
            driveByRel.set(relPath, { relPath, uid, kind: 'file', fingerprint: `${localSha1}|${L.size}|${L.mtimeMs}`, node: undefined });
            result.uploaded++;
            log(`uploaded ${relPath}`);
            continue;
        }

        // -- new Drive file --
        if (!inLocal && inDrive && !inDb) {
            await downloadTo(D.uid, path.join(localDir, relPath));
            db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: null, localSize: null, localMtime: null });
            result.downloaded++;
            log(`downloaded ${relPath}`);
            continue;
        }

        // -- both new (first-sync collision) --
        if (inLocal && inDrive && !inDb) {
            if (localSha1 && driveSha1(driveFp) && localSha1 === driveSha1(driveFp)) {
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                result.skipped++;
            } else {
                await resolveConflict(relPath, D, L, localSha1!);
                result.conflicts++;
            }
            continue;
        }

        // -- both present and previously synced --
        if (inLocal && inDrive) {
            const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
            const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;

            if (localChanged && !driveChanged) {
                const uid = await uploadFileRevision(sdk, D.uid, L.absPath);
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                result.uploaded++;
                log(`uploaded revision ${relPath}`);
            } else if (!localChanged && driveChanged) {
                await downloadTo(D.uid, path.join(localDir, relPath));
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: null, localSize: null, localMtime: null });
                result.downloaded++;
                log(`downloaded ${relPath}`);
            } else if (localChanged && driveChanged) {
                if (localSha1 && driveSha1(driveFp) && localSha1 === driveSha1(driveFp)) {
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                    result.skipped++;
                } else {
                    await resolveConflict(relPath, D, L, localSha1!);
                    result.conflicts++;
                }
            } else {
                // unchanged — fill any null fingerprints with observed values
                db.upsertNode({
                    pairId,
                    relPath,
                    kind: 'file',
                    driveUid: D.uid,
                    driveFingerprint: driveFp ?? S!.driveFingerprint,
                    localSha1: localSha1 ?? S!.localSha1,
                    localSize: L.size,
                    localMtime: L.mtimeMs,
                });
                result.skipped++;
            }
            continue;
        }

        // -- local present, drive missing (drive deleted it) --
        if (inLocal && !inDrive) {
            const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
            if (localChanged) {
                if (!parentUid) throw new Error(`No parent for ${relPath}`);
                const uid = await uploadFile(sdk, parentUid, path.posix.basename(relPath), L.absPath);
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                result.uploaded++;
                log(`re-uploaded ${relPath} (Drive copy was deleted)`);
            } else {
                localDeletions.push({ relPath });
            }
            continue;
        }

        // -- drive present, local missing (local deleted it) --
        if (!inLocal && inDrive) {
            const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;
            if (driveChanged) {
                await downloadTo(D.uid, path.join(localDir, relPath));
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: null, localSize: null, localMtime: null });
                result.downloaded++;
                log(`restored ${relPath} (local copy was deleted)`);
            } else {
                driveDeletions.push({ relPath, uid: D.uid });
            }
            continue;
        }
    }

    // ---- Deletion barrier: tripwire over ALL deletions, then execute (soft) ----
    const totalDeletions = driveDeletions.length + localDeletions.length;
    if (totalDeletions > 0) {
        checkDeletionTripwire({ totalTracked: stored.length, deletions: totalDeletions, thresholdPct: deletionThresholdPct });

        if (driveDeletions.length > 0) {
            await drain(sdk.trashNodes(driveDeletions.map((d) => d.uid)));
            for (const d of driveDeletions) db.removeNode(pairId, d.relPath);
            result.driveTrashed += driveDeletions.length;
            log(`trashed ${driveDeletions.length} item(s) on Drive`);
        }

        if (localDeletions.length > 0) {
            const trashRoot = path.join(localDir, '.pdn-trash', String(Date.now()));
            await mkdir(trashRoot, { recursive: true });
            for (const d of localDeletions) {
                const src = path.join(localDir, d.relPath);
                const dst = path.join(trashRoot, d.relPath);
                await mkdir(path.dirname(dst), { recursive: true });
                await rename(src, dst);
                db.removeNode(pairId, d.relPath);
            }
            result.localRecycled += localDeletions.length;
            log(`recycled ${localDeletions.length} item(s) to .pdn-trash`);
        }
    }

    return result;
}
