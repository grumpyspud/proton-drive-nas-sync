import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { downloadFile, sha1OfFile, uploadFile, uploadFileRevision } from '../fs/files';
import type { TransferProgress } from '../fs/files';
import type { SyncDB, SyncNode } from '../state/syncDb';
import type { ProgressHandler } from './progress';
import { NetRateMeter } from './netrate';
import { checkDeletionTripwire, DeletionTripwireError } from './safety';
import { drain } from './util';
import { driveMtime, driveSize } from './walk';
import type { DriveEntry, LocalEntry } from './walk';

/** Per-cycle result counters. Identical shape to the full walk's summary. */
export interface SyncResult {
    uploaded: number;
    downloaded: number;
    localRecycled: number;
    driveTrashed: number;
    conflicts: number;
    skipped: number;
    failed: number;
    moved: number;
}

/** Thrown when a pause/stop is requested mid-cycle. */
export class SyncAbortedError extends Error {
    constructor() {
        super('Sync aborted');
        this.name = 'SyncAbortedError';
    }
}

/**
 * A folder could not be created on Drive because the parent node this reconcile
 * is using no longer exists (a stale uid from a prior state - e.g. the Drive was
 * wiped or the parent was recreated externally), or the name is already taken by
 * a node our sparse view does not know about. The delta engine must fall back to
 * the full walk, which re-lists Drive and rebuilds the tree authoritatively.
 */
export class StaleParentError extends Error {
    constructor(relPath: string, cause?: unknown) {
        super(`Cannot create Drive folder ${relPath}: parent missing or stale`);
        this.name = 'StaleParentError';
        if (cause !== undefined) this.cause = cause;
    }
}

/** Files smaller than this get no individual progress bar (avoids UI flicker on
 *  floods of small files); the job-level bar still tracks them. */
export const DEFAULT_PROGRESS_MIN_BYTES = 5 * 1024 * 1024;

/** Max concurrent file transfers (up/downloads) during a sync cycle. */
export const DEFAULT_TRANSFER_CONCURRENCY = 3;

/** Hard upper bound on transfer concurrency (global setting + env). */
export const MAX_TRANSFER_CONCURRENCY = 4;

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

/** True when the local file's content matches the Drive file's.
 *  Primary: SHA-1 (present only when the uploader declared `expectedSha1`).
 *  Fallback: compare size (for files synced to Drive by another tool). */
function contentMatches(localSha1: string, localSize: number, driveFp: string | null | undefined, driveNode: DriveEntry['node']): boolean {
    const sha = driveSha1(driveFp);
    if (sha) return localSha1 === sha;
    return localSize === driveSize(driveNode);
}

export interface ReconcileContextOptions {
    sdk: ProtonDriveClient;
    pairId: string;
    localDir: string;
    driveFolderUid: string;
    db: SyncDB;
    deletionThresholdPct?: number;
    log: (msg: string) => void;
    onProgress?: ProgressHandler;
    shouldAbort?: () => boolean;
    progressMinBytes?: number;
    allowDeletions?: boolean;
}

/**
 * Mutable state shared by a single reconcile pass. Both the full walk
 * (`syncOnce`) and the delta engine (Phase 2+3) build one of these and feed
 * the same per-node operations, so the three-way merge logic and its safety
 * nets (conflict, dedupe, soft-delete, tripwire) live in exactly one place.
 *
 * The maps are populated by the caller: the full walk fills every entry from a
 * complete tree walk; the delta engine fills only the targeted entries it
 * resolved from the event feed / local stat-scan.
 */
export class ReconcileContext {
    readonly sdk: ProtonDriveClient;
    readonly pairId: string;
    readonly localDir: string;
    readonly driveFolderUid: string;
    readonly db: SyncDB;
    readonly deletionThresholdPct?: number;
    readonly log: (msg: string) => void;
    readonly onProgress?: ProgressHandler;
    readonly shouldAbort?: () => boolean;
    readonly progressMinBytes: number;
    readonly allowDeletions?: boolean;

    readonly localByRel = new Map<string, LocalEntry>();
    readonly driveByRel = new Map<string, DriveEntry>();
    readonly storedByRel = new Map<string, SyncNode>();
    readonly pendingConflictRelPaths = new Set<string>();
    readonly deletedFolderPrefixes = new Set<string>();

    readonly result: SyncResult = { uploaded: 0, downloaded: 0, localRecycled: 0, driveTrashed: 0, conflicts: 0, skipped: 0, failed: 0, moved: 0 };

    readonly driveDeletions: DriveDeletion[] = [];
    readonly localDeletions: LocalDeletion[] = [];

    /** Total tracked nodes for this pair (full count, not the targeted subset).
     *  The deletion tripwire percentage is relative to the WHOLE pair. */
    totalTracked = 0;

    completedBytes = 0;
    filesDone = 0;
    totalBytes = 0;
    totalFiles = 0;
    filesHashed = 0;

    private netRate = new NetRateMeter();
    private inFlightBytes = new Map<string, number>();
    private lastOverallAt = 0;
    private lastHashingAt = 0;

    constructor(opts: ReconcileContextOptions) {
        this.sdk = opts.sdk;
        this.pairId = opts.pairId;
        this.localDir = opts.localDir;
        this.driveFolderUid = opts.driveFolderUid;
        this.db = opts.db;
        this.deletionThresholdPct = opts.deletionThresholdPct;
        this.log = opts.log;
        this.onProgress = opts.onProgress;
        this.shouldAbort = opts.shouldAbort;
        this.progressMinBytes = opts.progressMinBytes ?? DEFAULT_PROGRESS_MIN_BYTES;
        this.allowDeletions = opts.allowDeletions;
    }

    checkAbort(): void {
        if (this.shouldAbort?.()) throw new SyncAbortedError();
    }

    private sumInFlightBytes(): number {
        let s = 0;
        for (const b of this.inFlightBytes.values()) s += b;
        return s;
    }

    finishTransfer(relPath: string, size: number): void {
        this.inFlightBytes.delete(relPath);
        this.completedBytes += size;
    }

    /** Job-level `overall` event: files-processed percent + NIC rate. Throttled. */
    emitOverall(): void {
        if (!this.onProgress) return;
        const now = Date.now();
        const isFinal = this.totalFiles > 0 && this.filesDone >= this.totalFiles;
        if (!isFinal && now - this.lastOverallAt < 50) return;
        this.lastOverallAt = now;
        const jobBytes = this.completedBytes + this.sumInFlightBytes();
        this.onProgress({
            type: 'overall',
            transferredBytes: jobBytes,
            totalBytes: this.totalBytes,
            percent: this.totalFiles > 0 ? Math.min(100, (this.filesDone / this.totalFiles) * 100) : 0,
            speedBps: this.netRate.sample(),
            filesDone: this.filesDone,
            totalFiles: this.totalFiles,
        });
    }

    /** Throttled "hashing" signal (file being verified + running count). */
    emitHashing(relPath: string): void {
        if (!this.onProgress) return;
        const now = Date.now();
        if (now - this.lastHashingAt < 100) return;
        this.lastHashingAt = now;
        this.onProgress({ type: 'hashing', relPath, hashed: this.filesHashed, total: this.totalFiles });
    }

    /** Per-file `transfer` reporter (only for files at/above progressMinBytes). */
    transferReporter(relPath: string, direction: 'upload' | 'download'): TransferProgress {
        return (bytes, total) => {
            const percent = total > 0 ? Math.min(100, (bytes / total) * 100) : 100;
            if (total >= this.progressMinBytes) {
                this.onProgress?.({ type: 'transfer', relPath, direction, bytes, total, percent });
            }
            this.inFlightBytes.set(relPath, bytes);
            this.emitOverall();
        };
    }

    /** Download a Drive file to `localPath`, returning its local sha1/size/mtime. */
    async downloadTo(uid: string, relPath: string, localPath: string): Promise<{ sha1: string; size: number; mtimeMs: number }> {
        await mkdir(path.dirname(localPath), { recursive: true });
        let size = 0;
        const rep = this.transferReporter(relPath, 'download');
        const info = await downloadFile(this.sdk, uid, localPath, (bytes, total) => {
            size = total;
            rep(bytes, total);
        });
        this.finishTransfer(relPath, size);
        const st = await stat(localPath);
        return { sha1: info.sha1, size: info.size, mtimeMs: st.mtimeMs };
    }

    /** Record a conflict for manual review: preserve the Drive version locally. */
    async recordConflict(relPath: string, D: DriveEntry, L: LocalEntry, localSha1: string): Promise<void> {
        const ts = Date.now();
        const conflictRel = `${relPath}.conflict-${ts}`;
        const conflictPath = path.join(this.localDir, conflictRel);
        await mkdir(path.dirname(conflictPath), { recursive: true });
        const info = await downloadFile(this.sdk, D.uid, conflictPath, this.transferReporter(relPath, 'download'));
        this.inFlightBytes.delete(relPath);
        this.completedBytes += info.size;
        this.db.upsertConflict({
            pairId: this.pairId,
            relPath,
            conflictPath: conflictRel,
            driveUid: D.uid,
            localSha1,
            localSize: L.size,
            localMtime: L.mtimeMs,
            conflictSha1: info.sha1,
            conflictSize: info.size,
            conflictMtime: driveMtime(D.node),
            createdAt: ts,
        });
        this.log(`conflict on ${relPath}: Drive version saved as ${path.basename(conflictRel)}: pending review`);
    }

    /** True when relPath is inside a folder scheduled for deletion this cycle. */
    isUnderDeletedFolder(relPath: string): boolean {
        for (const p of this.deletedFolderPrefixes) {
            if (relPath === p || relPath.startsWith(`${p}/`)) return true;
        }
        return false;
    }

    /** Deletion size of a relPath: 1 for a file, whole subtree for a folder. */
    deletionSize(relPath: string): number {
        const node = this.db.getNode(this.pairId, relPath);
        if (!node || node.kind !== 'folder') return 1;
        return this.db.countSubtree(this.pairId, relPath);
    }
}

/**
 * Reconcile ONE folder (three-way: local / Drive / stored). Creates folders in
 * both directions; deletions are deferred to `runDeletionBarrier`.
 */
export async function reconcileFolder(ctx: ReconcileContext, relPath: string): Promise<void> {
    const L = ctx.localByRel.get(relPath);
    const D = ctx.driveByRel.get(relPath);
    const S = ctx.storedByRel.get(relPath);
    const inLocal = !!L;
    const inDrive = !!D;
    const inDb = !!S;

    if (inLocal && !inDrive && !inDb) {
        const parentRel = path.posix.dirname(relPath);
        const parentUid = parentRel === '.' ? ctx.driveFolderUid : ctx.driveByRel.get(parentRel)?.uid;
        if (!parentUid) throw new Error(`No parent for folder ${relPath}`);
        let created;
        try {
            created = await ctx.sdk.createFolder(parentUid, path.posix.basename(relPath));
        } catch (err) {
            // Parent uid is stale (Drive wiped / recreated externally) or the name
            // already exists in a view this sparse context does not hold. Either
            // way the delta's Drive-side picture is wrong: signal a full-walk
            // fallback instead of aborting the whole sync on one folder.
            throw new StaleParentError(relPath, err);
        }
        ctx.driveByRel.set(relPath, { relPath, uid: created.uid, kind: 'folder', fingerprint: '', node: created });
        ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'folder', driveUid: created.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
        ctx.onProgress?.({ type: 'item', action: 'mkdir-drive', relPath });
        ctx.log(`created folder on Drive: ${relPath}`);
    } else if (!inLocal && inDrive && !inDb) {
        await mkdir(path.join(ctx.localDir, relPath), { recursive: true });
        ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'folder', driveUid: D!.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
        ctx.onProgress?.({ type: 'item', action: 'mkdir-local', relPath });
        ctx.log(`created folder locally: ${relPath}`);
    } else if (inLocal && inDrive) {
        if (!inDb) {
            ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'folder', driveUid: D!.uid, driveFingerprint: null, localSha1: null, localSize: null, localMtime: null });
        }
        // both present: nothing to do
    } else if (inLocal && !inDrive && inDb) {
        ctx.deletedFolderPrefixes.add(relPath);
        ctx.localDeletions.push({ relPath });
    } else if (!inLocal && inDrive && inDb) {
        ctx.deletedFolderPrefixes.add(relPath);
        ctx.driveDeletions.push({ relPath, uid: D!.uid });
    } else if (!inLocal && !inDrive && inDb) {
        ctx.db.removeNode(ctx.pairId, relPath);
    }
}

/**
 * Reconcile ONE file (three-way merge + transfer). Extracted from the former
 * sequential loop so the transfer phase can run with bounded concurrency, and
 * so the delta engine can invoke it per targeted node. `checkAbort` sits
 * outside the try so a pause/stop throws SyncAbortedError, not skip-on-error.
 */
export async function reconcileFile(ctx: ReconcileContext, relPath: string): Promise<void> {
    ctx.checkAbort();
    if (ctx.isUnderDeletedFolder(relPath)) return; // covered by the folder deletion

    const L = ctx.localByRel.get(relPath);
    const D = ctx.driveByRel.get(relPath);
    const S = ctx.storedByRel.get(relPath);
    const inLocal = !!L;
    const inDrive = !!D;
    const inDb = !!S;

    try {
        if (!inLocal && !inDrive) {
            if (inDb) ctx.db.removeNode(ctx.pairId, relPath);
            return;
        }

        // Frozen by an unresolved conflict: skip (still counts as processed).
        if (ctx.pendingConflictRelPaths.has(relPath)) {
            ctx.result.skipped++;
            ctx.onProgress?.({ type: 'item', action: 'conflict', relPath, message: 'pending review: resolve in the Conflicts panel' });
            return;
        }

        const parentRel = path.posix.dirname(relPath);
        const parentUid = parentRel === '.' ? ctx.driveFolderUid : ctx.driveByRel.get(parentRel)?.uid;

        // Local content hash (fast-path: reuse stored sha1 when size+mtime match).
        let localSha1: string | null = null;
        if (L) {
            if (S && S.localSha1 && S.localSize === L.size && S.localMtime === L.mtimeMs) {
                localSha1 = S.localSha1;
            } else {
                ctx.filesHashed++;
                ctx.emitHashing(relPath);
                localSha1 = await sha1OfFile(L.absPath);
            }
        }

        const driveFp = D?.fingerprint ?? null;

        // -- new local file --
        if (inLocal && !inDrive && !inDb) {
            if (!parentUid) throw new Error(`No parent for ${relPath}`);
            const uid = await uploadFile(ctx.sdk, parentUid, path.posix.basename(relPath), L!.absPath, ctx.transferReporter(relPath, 'upload'), localSha1 ?? undefined);
            ctx.finishTransfer(relPath, L!.size);
            ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L!.size, localMtime: L!.mtimeMs });
            ctx.driveByRel.set(relPath, { relPath, uid, kind: 'file', fingerprint: `${localSha1}|${L!.size}|${L!.mtimeMs}`, node: undefined });
            ctx.result.uploaded++;
            ctx.onProgress?.({ type: 'item', action: 'upload', relPath });
            ctx.log(`uploaded ${relPath}`);
            return;
        }

        // -- new Drive file --
        if (!inLocal && inDrive && !inDb) {
            const dl = await ctx.downloadTo(D!.uid, relPath, path.join(ctx.localDir, relPath));
            ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: D!.uid, driveFingerprint: driveFp, localSha1: dl.sha1, localSize: dl.size, localMtime: dl.mtimeMs });
            ctx.result.downloaded++;
            ctx.onProgress?.({ type: 'item', action: 'download', relPath });
            ctx.log(`downloaded ${relPath}`);
            return;
        }

        // -- both new (first-sync collision) --
        if (inLocal && inDrive && !inDb) {
            if (localSha1 && contentMatches(localSha1, L!.size, driveFp, D!.node)) {
                ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: D!.uid, driveFingerprint: driveFp, localSha1, localSize: L!.size, localMtime: L!.mtimeMs });
                ctx.result.skipped++;
                ctx.onProgress?.({ type: 'item', action: 'skip', relPath });
            } else {
                await ctx.recordConflict(relPath, D!, L!, localSha1!);
                ctx.result.conflicts++;
                ctx.onProgress?.({ type: 'item', action: 'conflict', relPath, message: 'Drive version preserved: pending review' });
            }
            return;
        }

        // -- both present and previously synced --
        if (inLocal && inDrive) {
            const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
            const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;

            if (localChanged && !driveChanged) {
                const uid = await uploadFileRevision(ctx.sdk, D!.uid, L!.absPath, ctx.transferReporter(relPath, 'upload'), localSha1 ?? undefined);
                ctx.finishTransfer(relPath, L!.size);
                ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L!.size, localMtime: L!.mtimeMs });
                ctx.result.uploaded++;
                ctx.onProgress?.({ type: 'item', action: 'upload', relPath });
                ctx.log(`uploaded revision ${relPath}`);
            } else if (!localChanged && driveChanged) {
                const dl = await ctx.downloadTo(D!.uid, relPath, path.join(ctx.localDir, relPath));
                ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: D!.uid, driveFingerprint: driveFp, localSha1: dl.sha1, localSize: dl.size, localMtime: dl.mtimeMs });
                ctx.result.downloaded++;
                ctx.onProgress?.({ type: 'item', action: 'download', relPath });
                ctx.log(`downloaded ${relPath}`);
            } else if (localChanged && driveChanged) {
                if (localSha1 && contentMatches(localSha1, L!.size, driveFp, D!.node)) {
                    ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: D!.uid, driveFingerprint: driveFp, localSha1, localSize: L!.size, localMtime: L!.mtimeMs });
                    ctx.result.skipped++;
                    ctx.onProgress?.({ type: 'item', action: 'skip', relPath });
                } else {
                    await ctx.recordConflict(relPath, D!, L!, localSha1!);
                    ctx.result.conflicts++;
                    ctx.onProgress?.({ type: 'item', action: 'conflict', relPath, message: 'Drive version preserved: pending review' });
                }
            } else {
                // unchanged: fill any null fingerprints with observed values
                ctx.db.upsertNode({
                    pairId: ctx.pairId,
                    relPath,
                    kind: 'file',
                    driveUid: D!.uid,
                    driveFingerprint: driveFp ?? S!.driveFingerprint,
                    localSha1: localSha1 ?? S!.localSha1,
                    localSize: L!.size,
                    localMtime: L!.mtimeMs,
                });
                ctx.result.skipped++;
                ctx.onProgress?.({ type: 'item', action: 'skip', relPath });
            }
            return;
        }

        // -- local present, drive missing (drive deleted it) --
        if (inLocal && !inDrive) {
            const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
            if (localChanged) {
                if (!parentUid) throw new Error(`No parent for ${relPath}`);
                const uid = await uploadFile(ctx.sdk, parentUid, path.posix.basename(relPath), L!.absPath, ctx.transferReporter(relPath, 'upload'), localSha1 ?? undefined);
                ctx.finishTransfer(relPath, L!.size);
                ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L!.size, localMtime: L!.mtimeMs });
                ctx.result.uploaded++;
                ctx.onProgress?.({ type: 'item', action: 'upload', relPath });
                ctx.log(`re-uploaded ${relPath} (Drive copy was deleted)`);
            } else {
                ctx.localDeletions.push({ relPath });
            }
            return;
        }

        // -- drive present, local missing (local deleted it) --
        if (!inLocal && inDrive) {
            const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;
            if (driveChanged) {
                const dl = await ctx.downloadTo(D!.uid, relPath, path.join(ctx.localDir, relPath));
                ctx.db.upsertNode({ pairId: ctx.pairId, relPath, kind: 'file', driveUid: D!.uid, driveFingerprint: driveFp, localSha1: dl.sha1, localSize: dl.size, localMtime: dl.mtimeMs });
                ctx.result.downloaded++;
                ctx.onProgress?.({ type: 'item', action: 'download', relPath });
                ctx.log(`restored ${relPath} (local copy was deleted)`);
            } else {
                ctx.driveDeletions.push({ relPath, uid: D!.uid });
            }
            return;
        }
    } catch (err) {
        // Skip-on-error: one bad file never aborts the whole sync.
        ctx.result.failed++;
        const reason = (err as Error)?.message ?? String(err);
        const line = `skipped ${relPath}: ${reason}`;
        ctx.log(line);
        ctx.onProgress?.({ type: 'log', message: line });
        ctx.onProgress?.({ type: 'item', action: 'skip-error', relPath, message: reason });
    } finally {
        // A file is "processed" once its three-way merge finishes (including
        // unchanged files). Bump + emit so the overall bar advances through the
        // skip phase instead of stalling at "0 files, 0.0%".
        ctx.filesDone++;
        ctx.emitOverall();
    }
}

/**
 * Deletion barrier: tripwire over ALL pending deletions, then execute them as
 * soft deletes (trash on Drive, recycle to `.pdn-trash` locally). Never a hard
 * delete.
 */
export async function runDeletionBarrier(ctx: ReconcileContext): Promise<void> {
    // Subtree-weighted: a folder deletion counts its whole subtree, so a mass
    // folder delete can't slip under the tripwire as a single deletion.
    let totalDeletions = 0;
    for (const d of ctx.driveDeletions) totalDeletions += ctx.deletionSize(d.relPath);
    for (const d of ctx.localDeletions) totalDeletions += ctx.deletionSize(d.relPath);
    ctx.checkAbort();
    if (totalDeletions > 0) {
        const trip = checkDeletionTripwire({ totalTracked: ctx.totalTracked, deletions: totalDeletions, thresholdPct: ctx.deletionThresholdPct });
        if (trip.tripped && !ctx.allowDeletions) {
            throw new DeletionTripwireError({
                totalTracked: ctx.totalTracked,
                deletions: totalDeletions,
                thresholdPct: trip.threshold,
                pct: trip.pct,
                driveTrash: ctx.driveDeletions.map((d) => d.relPath),
                localRecycle: ctx.localDeletions.map((d) => d.relPath),
            });
        }

        if (ctx.driveDeletions.length > 0) {
            await drain(ctx.sdk.trashNodes(ctx.driveDeletions.map((d) => d.uid)));
            for (const d of ctx.driveDeletions) {
                ctx.db.removeSubtree(ctx.pairId, d.relPath);
                ctx.onProgress?.({ type: 'item', action: 'trash-drive', relPath: d.relPath });
            }
            ctx.result.driveTrashed += ctx.driveDeletions.length;
            {
                const msg = `trashed ${ctx.driveDeletions.length} item(s) on Drive`;
                ctx.log(msg);
                ctx.onProgress?.({ type: 'log', message: msg });
            }
        }

        if (ctx.localDeletions.length > 0) {
            const trashRoot = path.join(ctx.localDir, '.pdn-trash', String(Date.now()));
            await mkdir(trashRoot, { recursive: true });
            for (const d of ctx.localDeletions) {
                const src = path.join(ctx.localDir, d.relPath);
                const dst = path.join(trashRoot, d.relPath);
                await mkdir(path.dirname(dst), { recursive: true });
                await rename(src, dst);
                ctx.db.removeSubtree(ctx.pairId, d.relPath);
                ctx.onProgress?.({ type: 'item', action: 'recycle-local', relPath: d.relPath });
            }
            ctx.result.localRecycled += ctx.localDeletions.length;
            {
                const msg = `recycled ${ctx.localDeletions.length} item(s) to .pdn-trash`;
                ctx.log(msg);
                ctx.onProgress?.({ type: 'log', message: msg });
            }
        }
    }
}

/**
 * Drive the reconcile over an already-populated context: reconcile folders
 * parent-first, plan + run the file transfer phase with bounded concurrency,
 * then execute the deletion barrier. Shared by the full walk (`syncOnce`) and
 * the targeted delta path (`syncDelta`), so both use the exact same per-node
 * logic. Reads only from the context's maps, so it works for a complete map
 * (full walk) or a targeted subset (delta).
 */
export async function runReconcile(ctx: ReconcileContext, transferConcurrency: number): Promise<void> {
    // ---- Folders (create both ways; defer deletions as a unit) ----
    const folderRelPaths = new Set<string>();
    for (const [rp, e] of ctx.localByRel) if (e.kind === 'folder') folderRelPaths.add(rp);
    for (const [rp, e] of ctx.driveByRel) if (e.kind === 'folder') folderRelPaths.add(rp);
    for (const [rp, n] of ctx.storedByRel) if (n.kind === 'folder') folderRelPaths.add(rp);

    const sortedFolders = [...folderRelPaths]
        .map((p) => ({ p, depth: p.split('/').length }))
        .sort((a, b) => a.depth - b.depth)
        .map((x) => x.p);
    let folderI = 0;
    for (const relPath of sortedFolders) {
        ctx.checkAbort();
        if (++folderI % 500 === 0) await new Promise<void>((r) => setImmediate(r));
        await reconcileFolder(ctx, relPath);
    }

    // ---- Files ----
    const fileRelPaths = new Set<string>();
    for (const [rp, e] of ctx.localByRel) if (e.kind === 'file') fileRelPaths.add(rp);
    for (const [rp, e] of ctx.driveByRel) if (e.kind === 'file') fileRelPaths.add(rp);
    for (const [rp, n] of ctx.storedByRel) if (n.kind === 'file') fileRelPaths.add(rp);

    // ---- Plan pass: count every file the reconcile will PROCESS and estimate
    //      the DATA that will move (drives the overall bar readouts). Cheap
    //      signals only (no hashing). ----
    let planI = 0;
    for (const relPath of fileRelPaths) {
        if (++planI % 2000 === 0) await new Promise<void>((r) => setImmediate(r));
        if (ctx.isUnderDeletedFolder(relPath)) continue;
        const L = ctx.localByRel.get(relPath);
        const D = ctx.driveByRel.get(relPath);
        const S = ctx.storedByRel.get(relPath);
        const inLocal = !!L;
        const inDrive = !!D;
        const inDb = !!S;
        const dSize = driveSize(D?.node);
        let bytes = 0;

        if (inLocal && !inDrive && !inDb) {
            bytes = L!.size;
        } else if (!inLocal && inDrive && !inDb) {
            bytes = dSize;
        } else if (inLocal && inDrive && !inDb) {
            bytes = L!.size + dSize; // assume conflict
        } else if (inLocal && inDrive) {
            const localChanged = S!.localSha1 != null && (S!.localSize !== L!.size || S!.localMtime !== L!.mtimeMs);
            const driveChanged = S!.driveFingerprint != null && D!.fingerprint !== S!.driveFingerprint;
            if (localChanged && !driveChanged) bytes = L!.size;
            else if (!localChanged && driveChanged) bytes = dSize;
            else if (localChanged && driveChanged) bytes = L!.size + dSize;
        } else if (inLocal && !inDrive) {
            const localChanged = S!.localSha1 != null && (S!.localSize !== L!.size || S!.localMtime !== L!.mtimeMs);
            if (localChanged) bytes = L!.size;
        } else if (!inLocal && inDrive) {
            const driveChanged = S!.driveFingerprint != null && D!.fingerprint !== S!.driveFingerprint;
            if (driveChanged) bytes = dSize;
        }

        ctx.totalFiles++;
        ctx.totalBytes += bytes;
    }
    ctx.onProgress?.({ type: 'sync-plan', totalBytes: ctx.totalBytes, totalFiles: ctx.totalFiles });

    // ---- Transfer phase: bounded-concurrency reconcile over the file set ----
    const queue = [...fileRelPaths];
    let abortError: Error | null = null;
    const workers = Array.from({ length: Math.min(transferConcurrency, queue.length) }, async () => {
        let workerI = 0;
        while (true) {
            if (abortError || ctx.shouldAbort?.()) {
                abortError ??= new SyncAbortedError();
                return;
            }
            const relPath = queue.shift();
            if (relPath === undefined) return;
            try {
                await reconcileFile(ctx, relPath);
            } catch (err) {
                if (err instanceof SyncAbortedError) {
                    abortError = err;
                    return;
                }
                throw err;
            }
            // Yield a real macrotask every N files so the healthcheck stays responsive.
            if (++workerI % 50 === 0) await new Promise<void>((r) => setImmediate(r));
        }
    });
    await Promise.all(workers);
    if (abortError) throw abortError;

    // ---- Deletion barrier: tripwire over ALL deletions, then execute (soft) ----
    await runDeletionBarrier(ctx);
}
