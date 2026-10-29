import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { downloadFile, sha1OfFile, uploadFile, uploadFileRevision } from '../fs/files';
import type { TransferProgress } from '../fs/files';
import type { SyncDB } from '../state/syncDb';
import { SpeedMeter, type ProgressHandler } from './progress';
import { assertSourceAvailable, checkDeletionTripwire, DeletionTripwireError } from './safety';
import { drain } from './util';
import { driveSize, walkDriveTree, walkLocalTree } from './walk';
import type { DriveEntry, LocalEntry } from './walk';

export interface SyncOptions {
    sdk: ProtonDriveClient;
    pairId: string;
    localDir: string;
    driveFolderUid: string;
    driveFolderName?: string;
    db: SyncDB;
    deletionThresholdPct?: number;
    log?: (msg: string) => void;
    /** Emits sync-start, per-transfer (bytes/percent/speed) and per-item events. */
    onProgress?: ProgressHandler;
    /** When truthy, the sync halts at the next safe boundary (between files). */
    shouldAbort?: () => boolean;
    /** Per-file bars are only emitted for files this size or larger (bytes). */
    progressMinBytes?: number;
    /** Max concurrent file transfers (up/downloads) during the reconcile phase.
     *  Defaults to DEFAULT_TRANSFER_CONCURRENCY; 1 = sequential (prior behaviour). */
    transferConcurrency?: number;
    /** When true, skip the deletion-rate tripwire (user already confirmed). */
    allowDeletions?: boolean;
}

export interface SyncResult {
    uploaded: number;
    downloaded: number;
    localRecycled: number;
    driveTrashed: number;
    conflicts: number;
    skipped: number;
    /** Files that failed and were skipped (skip-on-error) rather than aborting the run. */
    failed: number;
}

/** Thrown by syncOnce when a pause/stop is requested mid-cycle. */
export class SyncAbortedError extends Error {
    constructor() {
        super('Sync aborted');
        this.name = 'SyncAbortedError';
    }
}

/** Files smaller than this get no individual progress bar (avoids UI flicker on
 *  floods of small files); the job-level bar still tracks them. Tunable at the
 *  server via PDN_PROGRESS_MIN_BYTES. */
export const DEFAULT_PROGRESS_MIN_BYTES = 5 * 1024 * 1024;

/** Max concurrent file transfers (up/downloads) during a sync cycle. Transfers
 *  are I/O-bound (network + disk), so a handful of parallel transfers roughly
 *  multiplies throughput without extra CPU. Matches Proton's own clients, which
 *  run ~3–5 concurrent transfers. */
export const DEFAULT_TRANSFER_CONCURRENCY = 3;

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
 *
 * Progress: emits `sync-start`, then per-item events and per-transfer
 * `transfer` events (cumulative bytes, percent, sliding-window speed). The
 * caller emits `sync-complete` (with the returned summary) or `sync-error`.
 */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
    const { sdk, pairId, localDir, driveFolderUid, db, deletionThresholdPct, log = () => {}, onProgress, shouldAbort, progressMinBytes = DEFAULT_PROGRESS_MIN_BYTES, allowDeletions } = options;
    const result: SyncResult = { uploaded: 0, downloaded: 0, localRecycled: 0, driveTrashed: 0, conflicts: 0, skipped: 0, failed: 0 };
    const checkAbort = (): void => {
        if (shouldAbort?.()) throw new SyncAbortedError();
    };

    // Job-level progress tracking (overall % + speed across all files).
    let completedBytes = 0;
    let completedFiles = 0;
    let totalBytes = 0;
    let totalFiles = 0;
    const overallMeter = new SpeedMeter();

    onProgress?.({ type: 'sync-start', pairId, localDir, driveFolderName: options.driveFolderName ?? '' });

    // 1. Source-availability gate: a missing local dir halts, never mass-deletes.
    await assertSourceAvailable(localDir);

    // 2. Walk both sides, collecting leftover *.pdn-part temp files for cleanup.
    const localPartials: Array<{ relPath: string; absPath: string }> = [];
    const drivePartials: Array<{ relPath: string; uid: string }> = [];
    const local = await walkLocalTree(localDir, {
        onPartial: (relPath, absPath) => {
            localPartials.push({ relPath, absPath });
        },
        onProgress: (stats) => onProgress?.({ type: 'walk', side: 'local', ...stats }),
    });
    const drive = await walkDriveTree(sdk, driveFolderUid, '', {
        onPartial: (relPath, uid) => {
            drivePartials.push({ relPath, uid });
        },
        onProgress: (stats) => onProgress?.({ type: 'walk', side: 'drive', ...stats }),
    });
    checkAbort();

    // Remove partial-transfer leftovers (never sync incomplete data — the walk
    // above already excluded them from the reconcile). Local = delete, Drive =
    // trash (soft-delete), never a hard wipe.
    for (const p of localPartials) {
        await rm(p.absPath, { force: true });
        onProgress?.({ type: 'item', action: 'cleanup-partial', relPath: p.relPath });
    }
    if (drivePartials.length > 0) {
        await drain(sdk.trashNodes(drivePartials.map((p) => p.uid)));
        for (const p of drivePartials) {
            onProgress?.({ type: 'item', action: 'cleanup-partial', relPath: p.relPath });
        }
    }
    if (localPartials.length || drivePartials.length) {
        const msg = `cleaned ${localPartials.length} local + ${drivePartials.length} Drive partial file(s)`;
        log(msg);
        onProgress?.({ type: 'log', message: msg });
    }

    const localByRel = new Map(local.map((e) => [e.relPath, e]));
    const driveByRel = new Map(drive.map((e) => [e.relPath, e]));
    const stored = db.allNodes(pairId);
    const storedByRel = new Map(stored.map((n) => [n.relPath, n]));

    const driveDeletions: DriveDeletion[] = [];
    const localDeletions: LocalDeletion[] = [];
    const deletedFolderPrefixes = new Set<string>();

    /** Builds a byte-level reporter. Emits a per-file `transfer` event (only for
     *  files at/above progressMinBytes) plus a job-level `overall` event. */
    function transferReporter(relPath: string, direction: 'upload' | 'download'): TransferProgress {
        const meter = new SpeedMeter();
        return (bytes, total) => {
            const percent = total > 0 ? Math.min(100, (bytes / total) * 100) : 100;
            if (total >= progressMinBytes) {
                onProgress?.({ type: 'transfer', relPath, direction, bytes, total, percent, speedBps: meter.sample(bytes) });
            }
            const jobBytes = completedBytes + bytes;
            onProgress?.({
                type: 'overall',
                transferredBytes: jobBytes,
                totalBytes,
                percent: totalBytes > 0 ? Math.min(100, (jobBytes / totalBytes) * 100) : 0,
                speedBps: overallMeter.sample(jobBytes),
                filesDone: completedFiles,
                totalFiles,
            });
        };
    }

    async function downloadTo(uid: string, relPath: string, localPath: string): Promise<void> {
        await mkdir(path.dirname(localPath), { recursive: true });
        let size = 0;
        const rep = transferReporter(relPath, 'download');
        await downloadFile(sdk, uid, localPath, (bytes, total) => {
            size = total;
            rep(bytes, total);
        });
        completedBytes += size;
        completedFiles++;
    }

    // Resolve a conflict: local wins, but the Drive version is preserved
    // locally as `<relPath>.conflict-<ts>` so nothing is lost.
    async function resolveConflict(relPath: string, D: DriveEntry, L: LocalEntry, localSha1: string): Promise<void> {
        const ts = Date.now();
        const conflictPath = path.join(localDir, `${relPath}.conflict-${ts}`);
        await mkdir(path.dirname(conflictPath), { recursive: true });
        await downloadFile(sdk, D.uid, conflictPath, transferReporter(relPath, 'download'));
        completedBytes += driveSize(D.node);
        const uid = await uploadFileRevision(sdk, D.uid, L.absPath, transferReporter(relPath, 'upload'), localSha1);
        completedBytes += L.size;
        completedFiles++;
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
        checkAbort();
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
            onProgress?.({ type: 'item', action: 'mkdir-drive', relPath });
            log(`created folder on Drive: ${relPath}`);
        } else if (!inLocal && inDrive && !inDb) {
            await mkdir(path.join(localDir, relPath), { recursive: true });
            db.upsertNode({ pairId, relPath, kind: 'folder', driveUid: D.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
            onProgress?.({ type: 'item', action: 'mkdir-local', relPath });
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

    // ---- Plan pass: estimate the job's total transfer size for the overall
    //      progress bar. Cheap signals only (no hashing): exact for new files,
    //      approximate only when a "changed" decision would need the sha1. ----
    for (const relPath of fileRelPaths) {
        if (isUnderDeletedFolder(relPath)) continue;
        const L = localByRel.get(relPath);
        const D = driveByRel.get(relPath);
        const S = storedByRel.get(relPath);
        const inLocal = !!L;
        const inDrive = !!D;
        const inDb = !!S;
        const dSize = driveSize(D?.node);
        let bytes = 0;
        let transfers = false;

        if (inLocal && !inDrive && !inDb) {
            bytes = L!.size;
            transfers = true;
        } else if (!inLocal && inDrive && !inDb) {
            bytes = dSize;
            transfers = true;
        } else if (inLocal && inDrive && !inDb) {
            bytes = L!.size + dSize; // assume conflict
            transfers = true;
        } else if (inLocal && inDrive) {
            const localChanged = S!.localSha1 == null || S!.localSize !== L!.size || S!.localMtime !== L!.mtimeMs;
            const driveChanged = S!.driveFingerprint == null || D!.fingerprint !== S!.driveFingerprint;
            if (localChanged && !driveChanged) {
                bytes = L!.size;
                transfers = true;
            } else if (!localChanged && driveChanged) {
                bytes = dSize;
                transfers = true;
            } else if (localChanged && driveChanged) {
                bytes = L!.size + dSize;
                transfers = true;
            }
        } else if (inLocal && !inDrive) {
            const localChanged = S!.localSha1 == null || S!.localSize !== L!.size || S!.localMtime !== L!.mtimeMs;
            if (localChanged) {
                bytes = L!.size;
                transfers = true;
            }
        } else if (!inLocal && inDrive) {
            const driveChanged = S!.driveFingerprint == null || D!.fingerprint !== S!.driveFingerprint;
            if (driveChanged) {
                bytes = dSize;
                transfers = true;
            }
        }

        if (transfers) totalFiles++;
        totalBytes += bytes;
    }
    onProgress?.({ type: 'sync-plan', totalBytes, totalFiles });

    // Reconcile ONE file (three-way merge + transfer). Extracted from the former
    // sequential loop so the transfer phase can run with bounded concurrency.
    // `checkAbort` and the map lookups sit OUTSIDE the try so a pause/stop
    // throws SyncAbortedError (not a skip-on-error); transfers/DB are inside and
    // fail soft per-file.
    async function reconcileFile(relPath: string): Promise<void> {
        checkAbort();
        if (isUnderDeletedFolder(relPath)) return; // covered by the folder deletion

        const L = localByRel.get(relPath);
        const D = driveByRel.get(relPath);
        const S = storedByRel.get(relPath);
        const inLocal = !!L;
        const inDrive = !!D;
        const inDb = !!S;

        try {
            if (!inLocal && !inDrive) {
                if (inDb) db.removeNode(pairId, relPath);
                return;
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
                const uid = await uploadFile(sdk, parentUid, path.posix.basename(relPath), L.absPath, transferReporter(relPath, 'upload'), localSha1 ?? undefined);
                completedBytes += L.size;
                completedFiles++;
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                driveByRel.set(relPath, { relPath, uid, kind: 'file', fingerprint: `${localSha1}|${L.size}|${L.mtimeMs}`, node: undefined });
                result.uploaded++;
                onProgress?.({ type: 'item', action: 'upload', relPath });
                log(`uploaded ${relPath}`);
                return;
            }

            // -- new Drive file --
            if (!inLocal && inDrive && !inDb) {
                await downloadTo(D.uid, relPath, path.join(localDir, relPath));
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: null, localSize: null, localMtime: null });
                result.downloaded++;
                onProgress?.({ type: 'item', action: 'download', relPath });
                log(`downloaded ${relPath}`);
                return;
            }

            // -- both new (first-sync collision) --
            if (inLocal && inDrive && !inDb) {
                if (localSha1 && driveSha1(driveFp) && localSha1 === driveSha1(driveFp)) {
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                    result.skipped++;
                    onProgress?.({ type: 'item', action: 'skip', relPath });
                } else {
                    await resolveConflict(relPath, D, L, localSha1!);
                    result.conflicts++;
                    onProgress?.({ type: 'item', action: 'conflict', relPath });
                }
                return;
            }

            // -- both present and previously synced --
            if (inLocal && inDrive) {
                const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
                const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;

                if (localChanged && !driveChanged) {
                    const uid = await uploadFileRevision(sdk, D.uid, L.absPath, transferReporter(relPath, 'upload'), localSha1 ?? undefined);
                    completedBytes += L.size;
                    completedFiles++;
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                    result.uploaded++;
                    onProgress?.({ type: 'item', action: 'upload', relPath });
                    log(`uploaded revision ${relPath}`);
                } else if (!localChanged && driveChanged) {
                    await downloadTo(D.uid, relPath, path.join(localDir, relPath));
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: null, localSize: null, localMtime: null });
                    result.downloaded++;
                    onProgress?.({ type: 'item', action: 'download', relPath });
                    log(`downloaded ${relPath}`);
                } else if (localChanged && driveChanged) {
                    if (localSha1 && driveSha1(driveFp) && localSha1 === driveSha1(driveFp)) {
                        db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                        result.skipped++;
                        onProgress?.({ type: 'item', action: 'skip', relPath });
                    } else {
                        await resolveConflict(relPath, D, L, localSha1!);
                        result.conflicts++;
                        onProgress?.({ type: 'item', action: 'conflict', relPath });
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
                    onProgress?.({ type: 'item', action: 'skip', relPath });
                }
                return;
            }

            // -- local present, drive missing (drive deleted it) --
            if (inLocal && !inDrive) {
                const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
                if (localChanged) {
                    if (!parentUid) throw new Error(`No parent for ${relPath}`);
                    const uid = await uploadFile(sdk, parentUid, path.posix.basename(relPath), L.absPath, transferReporter(relPath, 'upload'), localSha1 ?? undefined);
                    completedBytes += L.size;
                    completedFiles++;
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                    result.uploaded++;
                    onProgress?.({ type: 'item', action: 'upload', relPath });
                    log(`re-uploaded ${relPath} (Drive copy was deleted)`);
                } else {
                    localDeletions.push({ relPath });
                }
                return;
            }

            // -- drive present, local missing (local deleted it) --
            if (!inLocal && inDrive) {
                const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;
                if (driveChanged) {
                    await downloadTo(D.uid, relPath, path.join(localDir, relPath));
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: null, localSize: null, localMtime: null });
                    result.downloaded++;
                    onProgress?.({ type: 'item', action: 'download', relPath });
                    log(`restored ${relPath} (local copy was deleted)`);
                } else {
                    driveDeletions.push({ relPath, uid: D.uid });
                }
                return;
            }
        } catch (err) {
            // Skip-on-error: one bad file never aborts the whole sync.
            result.failed++;
            const reason = (err as Error)?.message ?? String(err);
            const line = `skipped ${relPath}: ${reason}`;
            log(line);
            onProgress?.({ type: 'log', message: line });
            onProgress?.({ type: 'item', action: 'skip-error', relPath });
        }
    }

    // ---- Transfer phase: bounded-concurrency reconcile over the file set ----
    // Files are independent (three-way merge per relPath; their parents are the
    // folders created above), so 2–4 parallel transfers roughly multiply
    // I/O-bound throughput. On abort we stop pulling new files, let in-flight
    // transfers finish, then throw — so no worker touches the DB after syncOnce
    // returns and the caller can close it safely.
    const transferConcurrency = Math.max(1, Math.floor(options.transferConcurrency ?? DEFAULT_TRANSFER_CONCURRENCY));
    {
        const queue = [...fileRelPaths];
        let abortError: Error | null = null;
        const workers = Array.from({ length: Math.min(transferConcurrency, queue.length) }, async () => {
            while (true) {
                if (abortError || shouldAbort?.()) {
                    abortError ??= new SyncAbortedError();
                    return;
                }
                const relPath = queue.shift();
                if (relPath === undefined) return;
                try {
                    await reconcileFile(relPath);
                } catch (err) {
                    if (err instanceof SyncAbortedError) {
                        abortError = err;
                        return;
                    }
                    throw err;
                }
            }
        });
        await Promise.all(workers);
        if (abortError) throw abortError;
    }

    // ---- Deletion barrier: tripwire over ALL deletions, then execute (soft) ----
    const totalDeletions = driveDeletions.length + localDeletions.length;
    checkAbort();
    if (totalDeletions > 0) {
        const trip = checkDeletionTripwire({ totalTracked: stored.length, deletions: totalDeletions, thresholdPct: deletionThresholdPct });
        if (trip.tripped && !allowDeletions) {
            throw new DeletionTripwireError({
                totalTracked: stored.length,
                deletions: totalDeletions,
                thresholdPct: trip.threshold,
                pct: trip.pct,
                driveTrash: driveDeletions.map((d) => d.relPath),
                localRecycle: localDeletions.map((d) => d.relPath),
            });
        }

        if (driveDeletions.length > 0) {
            await drain(sdk.trashNodes(driveDeletions.map((d) => d.uid)));
            for (const d of driveDeletions) {
                db.removeNode(pairId, d.relPath);
                onProgress?.({ type: 'item', action: 'trash-drive', relPath: d.relPath });
            }
            result.driveTrashed += driveDeletions.length;
            {
                const msg = `trashed ${driveDeletions.length} item(s) on Drive`;
                log(msg);
                onProgress?.({ type: 'log', message: msg });
            }
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
                onProgress?.({ type: 'item', action: 'recycle-local', relPath: d.relPath });
            }
            result.localRecycled += localDeletions.length;
            {
                const msg = `recycled ${localDeletions.length} item(s) to .pdn-trash`;
                log(msg);
                onProgress?.({ type: 'log', message: msg });
            }
        }
    }

    return result;
}
