import { rm } from 'node:fs/promises';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { SyncDB } from '../state/syncDb';
import type { ProgressHandler } from './progress';
import { assertSourceAvailable } from './safety';
import { drain } from './util';
import { driveSize, walkDriveTree, walkLocalTree } from './walk';
import {
    ReconcileContext,
    reconcileFile,
    reconcileFolder,
    runDeletionBarrier,
    SyncAbortedError,
    DEFAULT_TRANSFER_CONCURRENCY,
    MAX_TRANSFER_CONCURRENCY,
} from './reconcile';
import type { SyncResult } from './reconcile';

// Re-export the reconcile-core symbols the server and CLI already import, so
// their `from '../engine/sync'` imports keep working unchanged.
export { SyncAbortedError, DEFAULT_PROGRESS_MIN_BYTES, DEFAULT_TRANSFER_CONCURRENCY, MAX_TRANSFER_CONCURRENCY } from './reconcile';
export type { SyncResult } from './reconcile';

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

/**
 * One bidirectional sync cycle for a folder pair. Full three-way reconcile of
 * local vs Drive vs last-synced (DB). This is the FULL-WALK orchestrator: it
 * walks both trees completely, then drives the shared per-node reconcile from
 * `./reconcile`. The Phase 2+3 delta engine builds the same `ReconcileContext`
 * from targeted inputs and calls the same per-node operations.
 */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
    const { sdk, pairId, localDir, driveFolderUid, db, deletionThresholdPct, log = () => {}, onProgress, shouldAbort, progressMinBytes, allowDeletions } = options;

    const ctx = new ReconcileContext({
        sdk,
        pairId,
        localDir,
        driveFolderUid,
        db,
        deletionThresholdPct,
        log,
        onProgress,
        shouldAbort,
        progressMinBytes,
        allowDeletions,
    });

    onProgress?.({ type: 'sync-start', pairId, localDir, driveFolderName: options.driveFolderName ?? '' });

    // 1. Source-availability gate: a missing local dir halts, never mass-deletes.
    await assertSourceAvailable(localDir);

    // 2. Walk both sides, collecting leftover *.pdn-part temp files for cleanup.
    const localPartials: Array<{ relPath: string; absPath: string }> = [];
    const drivePartials: Array<{ relPath: string; uid: string }> = [];
    const orphanConflicts: Array<{ relPath: string; absPath: string; size: number; mtimeMs: number }> = [];
    const local = await walkLocalTree(localDir, {
        onPartial: (relPath, absPath) => {
            localPartials.push({ relPath, absPath });
        },
        onConflict: (relPath, absPath, size, mtimeMs) => {
            orphanConflicts.push({ relPath, absPath, size, mtimeMs });
        },
        onProgress: (stats) => onProgress?.({ type: 'walk', side: 'local', ...stats }),
    });
    const drive = await walkDriveTree(sdk, driveFolderUid, '', {
        onPartial: (relPath, uid) => {
            drivePartials.push({ relPath, uid });
        },
        onProgress: (stats) => onProgress?.({ type: 'walk', side: 'drive', ...stats }),
    });
    ctx.checkAbort();

    // Remove partial-transfer leftovers (never sync incomplete data). Local =
    // delete, Drive = trash (soft-delete), never a hard wipe.
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

    // Scan done: enter the prepare phase (load last-synced state, reconcile
    // folders, plan the file set).
    onProgress?.({ type: 'preparing', files: local.length + drive.length });

    for (const e of local) ctx.localByRel.set(e.relPath, e);
    for (const e of drive) ctx.driveByRel.set(e.relPath, e);
    const stored = await db.allNodesAsync(pairId);
    ctx.totalTracked = stored.length;
    for (const n of stored) ctx.storedByRel.set(n.relPath, n);

    // Record any `.conflict-*` copies the walk found (orphans from before this
    // feature or a prior run) so they surface in the Conflicts panel.
    for (const oc of orphanConflicts) {
        if (db.getConflict(pairId, oc.relPath)) continue;
        const canonRel = oc.relPath.replace(/\.conflict-\d+$/, '');
        const node = ctx.storedByRel.get(canonRel);
        db.upsertConflict({
            pairId,
            relPath: canonRel,
            conflictPath: oc.relPath,
            driveUid: node?.driveUid ?? null,
            localSha1: node?.localSha1 ?? null,
            localSize: node?.localSize ?? null,
            localMtime: node?.localMtime ?? null,
            conflictSha1: null,
            conflictSize: oc.size,
            conflictMtime: oc.mtimeMs,
            createdAt: oc.mtimeMs,
        });
    }

    // Files with an unresolved conflict are frozen this cycle (skipped).
    for (const c of db.listConflicts(pairId)) ctx.pendingConflictRelPaths.add(c.relPath);

    // ---- Folders (create both ways; defer deletions as a unit) ----
    const folderRelPaths = new Set<string>();
    for (const e of local) if (e.kind === 'folder') folderRelPaths.add(e.relPath);
    for (const e of drive) if (e.kind === 'folder') folderRelPaths.add(e.relPath);
    for (const n of stored) if (n.kind === 'folder') folderRelPaths.add(n.relPath);

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
    for (const e of local) if (e.kind === 'file') fileRelPaths.add(e.relPath);
    for (const e of drive) if (e.kind === 'file') fileRelPaths.add(e.relPath);
    for (const n of stored) if (n.kind === 'file') fileRelPaths.add(n.relPath);

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
    onProgress?.({ type: 'sync-plan', totalBytes: ctx.totalBytes, totalFiles: ctx.totalFiles });

    // ---- Transfer phase: bounded-concurrency reconcile over the file set ----
    const transferConcurrency = Math.min(MAX_TRANSFER_CONCURRENCY, Math.max(1, Math.floor(options.transferConcurrency ?? DEFAULT_TRANSFER_CONCURRENCY)));
    {
        const queue = [...fileRelPaths];
        let abortError: Error | null = null;
        const workers = Array.from({ length: Math.min(transferConcurrency, queue.length) }, async () => {
            let workerI = 0;
            while (true) {
                if (abortError || shouldAbort?.()) {
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
    }

    // ---- Deletion barrier: tripwire over ALL deletions, then execute (soft) ----
    await runDeletionBarrier(ctx);

    return ctx.result;
}
