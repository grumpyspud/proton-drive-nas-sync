import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { downloadFile, sha1OfFile, uploadFile, uploadFileRevision } from '../fs/files';
import type { TransferProgress } from '../fs/files';
import type { SyncDB } from '../state/syncDb';
import type { ProgressHandler } from './progress';
import { NetRateMeter } from './netrate';
import { assertSourceAvailable, checkDeletionTripwire, DeletionTripwireError } from './safety';
import { drain } from './util';
import { driveMtime, driveSize, walkDriveTree, walkLocalTree } from './walk';
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

/** Hard upper bound on transfer concurrency (global setting + env). Going above 4
 *  risks Proton rate-limiting, so this is a deliberate ceiling enforced by both the
 *  server setting clamp and this engine clamp. */
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
 *  Fallback for files synced to Drive by another tool (no declared SHA-1):
 *  compare size — same size is treated as identical, so adopting an
 *  already-populated Drive doesn't churn every file into a spurious conflict. */
function contentMatches(localSha1: string, localSize: number, driveFp: string | null | undefined, driveNode: DriveEntry['node']): boolean {
    const sha = driveSha1(driveFp);
    if (sha) return localSha1 === sha;
    return localSize === driveSize(driveNode);
}

/**
 * One bidirectional sync cycle for a folder pair. Three-way reconcile of
 * local vs Drive vs last-synced (DB). Deletions are soft on BOTH sides
 * (trash on Drive, recycle to `.pdn-trash` locally) and are gated by the
 * deletion-rate tripwire — never a hard delete.
 *
 * Progress: emits `sync-start`, then per-item events and per-transfer
 * `transfer` events (cumulative bytes, percent) plus `overall` events
 * (files-processed percent + NIC-derived rate). The caller emits
 * `sync-complete` (with the returned summary) or `sync-error`.
 */
export async function syncOnce(options: SyncOptions): Promise<SyncResult> {
    const { sdk, pairId, localDir, driveFolderUid, db, deletionThresholdPct, log = () => {}, onProgress, shouldAbort, progressMinBytes = DEFAULT_PROGRESS_MIN_BYTES, allowDeletions } = options;
    const result: SyncResult = { uploaded: 0, downloaded: 0, localRecycled: 0, driveTrashed: 0, conflicts: 0, skipped: 0, failed: 0 };
    const checkAbort = (): void => {
        if (shouldAbort?.()) throw new SyncAbortedError();
    };

    // Job-level progress tracking. `filesDone`/`totalFiles` count EVERY file the
    // reconcile processes (uploads, downloads, conflicts, AND skipped/unchanged
    // files), so a follow-up sync that is mostly "skips" still advances the bar.
    // `completedBytes`/`totalBytes` are the actual DATA moved (0 during skips).
    let completedBytes = 0;
    let filesDone = 0;
    let totalBytes = 0;
    let totalFiles = 0;
    // Overall rate is sampled from the container's NIC counters (/proc/net/dev),
    // not the backend's per-tick estimate — that spiked to "—"/"1.0 GB/s" because
    // progress callbacks fire in bursts. The NIC counter is stable ground truth.
    const netRate = new NetRateMeter();
    // Bytes in flight per relPath (parallel transfers), so the overall bar sums
    // ALL active transfers instead of only the most recently reported one.
    const inFlightBytes = new Map<string, number>();
    const sumInFlightBytes = (): number => {
        let s = 0;
        for (const b of inFlightBytes.values()) s += b;
        return s;
    };
    const finishTransfer = (relPath: string, size: number): void => {
        inFlightBytes.delete(relPath);
        completedBytes += size;
    };
    /** Emit the job-level `overall` event: files-processed percent + NIC rate.
     *  Throttled to ~20/s so a fast skip/re-hash phase (thousands of unchanged
     *  files) can't flood the SSE stream with one event per file. */
    let lastOverallAt = 0;
    const emitOverall = (): void => {
        if (!onProgress) return;
        const now = Date.now();
        const isFinal = totalFiles > 0 && filesDone >= totalFiles;
        if (!isFinal && now - lastOverallAt < 50) return;
        lastOverallAt = now;
        const jobBytes = completedBytes + sumInFlightBytes();
        onProgress({
            type: 'overall',
            transferredBytes: jobBytes,
            totalBytes,
            percent: totalFiles > 0 ? Math.min(100, (filesDone / totalFiles) * 100) : 0,
            speedBps: netRate.sample(),
            filesDone,
            totalFiles,
        });
    };

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

    // Record any `.conflict-*` copies the walk found (orphans from before this
    // feature or a prior run) so they surface in the Conflicts panel. Idempotent:
    // a copy already in the table is left alone.
    for (const oc of orphanConflicts) {
        if (db.getConflict(pairId, oc.relPath)) continue;
        const canonRel = oc.relPath.replace(/\.conflict-\d+$/, '');
        const node = storedByRel.get(canonRel);
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

    // Files with an unresolved conflict are frozen this cycle (skipped, not
    // transferred) until the user resolves them in the Conflicts panel.
    const pendingConflictRelPaths = new Set(db.listConflicts(pairId).map((c) => c.relPath));

    const driveDeletions: DriveDeletion[] = [];
    const localDeletions: LocalDeletion[] = [];
    const deletedFolderPrefixes = new Set<string>();

    /** Builds a byte-level reporter. Emits a per-file `transfer` event (only for
     *  files at/above progressMinBytes) plus a job-level `overall` event. */
    function transferReporter(relPath: string, direction: 'upload' | 'download'): TransferProgress {
        return (bytes, total) => {
            const percent = total > 0 ? Math.min(100, (bytes / total) * 100) : 100;
            if (total >= progressMinBytes) {
                onProgress?.({ type: 'transfer', relPath, direction, bytes, total, percent });
            }
            inFlightBytes.set(relPath, bytes);
            emitOverall();
        };
    }

    async function downloadTo(uid: string, relPath: string, localPath: string): Promise<{ sha1: string; size: number; mtimeMs: number }> {
        await mkdir(path.dirname(localPath), { recursive: true });
        let size = 0;
        const rep = transferReporter(relPath, 'download');
        const info = await downloadFile(sdk, uid, localPath, (bytes, total) => {
            size = total;
            rep(bytes, total);
        });
        finishTransfer(relPath, size);
        const st = await stat(localPath);
        return { sha1: info.sha1, size: info.size, mtimeMs: st.mtimeMs };
    }

    // Record a conflict for manual review: the Drive version is preserved
    // locally as `<relPath>.conflict-<ts>`, but nothing is uploaded or
    // overwritten — both sides stay put until the user picks a winner in the
    // Conflicts panel. The file is frozen (skipped) until then.
    async function recordConflict(relPath: string, D: DriveEntry, L: LocalEntry, localSha1: string): Promise<void> {
        const ts = Date.now();
        const conflictRel = `${relPath}.conflict-${ts}`;
        const conflictPath = path.join(localDir, conflictRel);
        await mkdir(path.dirname(conflictPath), { recursive: true });
        const info = await downloadFile(sdk, D.uid, conflictPath, transferReporter(relPath, 'download'));
        inFlightBytes.delete(relPath);
        completedBytes += info.size;
        db.upsertConflict({
            pairId,
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
        log(`conflict on ${relPath}: Drive version saved as ${path.basename(conflictRel)} — pending review`);
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

    // ---- Plan pass: count every file the reconcile will PROCESS (drives the
    //      files-based overall bar) and estimate the DATA that will move (drives
    //      the "X/Y transferred" readout). Cheap signals only (no hashing).
    //      `localChanged`/`driveChanged` mirror the reconcile's logic: a null
    //      stored hash/fingerprint means "unknown, not changed" (the reconcile
    //      fills it in-place on the follow-up sync without re-transferring), so
    //      a second sync that only re-hashes doesn't inflate `totalBytes`. ----
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

        totalFiles++; // every file in the reconcile set counts as work
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

            // Frozen by an unresolved conflict: skip (still counts as processed).
            if (pendingConflictRelPaths.has(relPath)) {
                result.skipped++;
                onProgress?.({ type: 'item', action: 'conflict', relPath, message: 'pending review — resolve in the Conflicts panel' });
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
                finishTransfer(relPath, L.size);
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                driveByRel.set(relPath, { relPath, uid, kind: 'file', fingerprint: `${localSha1}|${L.size}|${L.mtimeMs}`, node: undefined });
                result.uploaded++;
                onProgress?.({ type: 'item', action: 'upload', relPath });
                log(`uploaded ${relPath}`);
                return;
            }

            // -- new Drive file --
            if (!inLocal && inDrive && !inDb) {
                const dl = await downloadTo(D.uid, relPath, path.join(localDir, relPath));
                db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: dl.sha1, localSize: dl.size, localMtime: dl.mtimeMs });
                result.downloaded++;
                onProgress?.({ type: 'item', action: 'download', relPath });
                log(`downloaded ${relPath}`);
                return;
            }

            // -- both new (first-sync collision) --
            if (inLocal && inDrive && !inDb) {
                if (localSha1 && contentMatches(localSha1, L.size, driveFp, D.node)) {
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                    result.skipped++;
                    onProgress?.({ type: 'item', action: 'skip', relPath });
                } else {
                    await recordConflict(relPath, D, L, localSha1!);
                    result.conflicts++;
                    onProgress?.({ type: 'item', action: 'conflict', relPath, message: 'Drive version preserved — pending review' });
                }
                return;
            }

            // -- both present and previously synced --
            if (inLocal && inDrive) {
                const localChanged = S!.localSha1 != null && localSha1 !== S!.localSha1;
                const driveChanged = S!.driveFingerprint != null && driveFp !== S!.driveFingerprint;

                if (localChanged && !driveChanged) {
                    const uid = await uploadFileRevision(sdk, D.uid, L.absPath, transferReporter(relPath, 'upload'), localSha1 ?? undefined);
                    finishTransfer(relPath, L.size);
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: uid, driveFingerprint: null, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                    result.uploaded++;
                    onProgress?.({ type: 'item', action: 'upload', relPath });
                    log(`uploaded revision ${relPath}`);
                } else if (!localChanged && driveChanged) {
                    const dl = await downloadTo(D.uid, relPath, path.join(localDir, relPath));
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: dl.sha1, localSize: dl.size, localMtime: dl.mtimeMs });
                    result.downloaded++;
                    onProgress?.({ type: 'item', action: 'download', relPath });
                    log(`downloaded ${relPath}`);
                } else if (localChanged && driveChanged) {
                    if (localSha1 && contentMatches(localSha1, L.size, driveFp, D.node)) {
                        db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1, localSize: L.size, localMtime: L.mtimeMs });
                        result.skipped++;
                        onProgress?.({ type: 'item', action: 'skip', relPath });
                    } else {
                        await recordConflict(relPath, D, L, localSha1!);
                        result.conflicts++;
                        onProgress?.({ type: 'item', action: 'conflict', relPath, message: 'Drive version preserved — pending review' });
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
                    finishTransfer(relPath, L.size);
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
                    const dl = await downloadTo(D.uid, relPath, path.join(localDir, relPath));
                    db.upsertNode({ pairId, relPath, kind: 'file', driveUid: D.uid, driveFingerprint: driveFp, localSha1: dl.sha1, localSize: dl.size, localMtime: dl.mtimeMs });
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
            onProgress?.({ type: 'item', action: 'skip-error', relPath, message: reason });
        } finally {
            // A file is "processed" once its three-way merge finishes — including
            // unchanged files (the common case on a steady-state sync). Bump + emit
            // so the overall bar advances through the skip phase instead of
            // stalling at "0 files, 0.0%" while the log scrolls skips.
            filesDone++;
            emitOverall();
        }
    }

    // ---- Transfer phase: bounded-concurrency reconcile over the file set ----
    // Files are independent (three-way merge per relPath; their parents are the
    // folders created above), so 2–4 parallel transfers roughly multiply
    // I/O-bound throughput. On abort we stop pulling new files, let in-flight
    // transfers finish, then throw — so no worker touches the DB after syncOnce
    // returns and the caller can close it safely.
    const transferConcurrency = Math.min(MAX_TRANSFER_CONCURRENCY, Math.max(1, Math.floor(options.transferConcurrency ?? DEFAULT_TRANSFER_CONCURRENCY)));
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
