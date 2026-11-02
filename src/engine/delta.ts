import path from 'node:path';
import { NodeType } from '@protontech/drive-sdk';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import type { SyncDB } from '../state/syncDb';
import type { ProgressHandler } from './progress';
import { assertSourceAvailable } from './safety';
import type { LocalDiff } from './localDiff';
import type { SyncTarget } from './mapping';
import {
    ReconcileContext,
    runReconcile,
    StaleParentError,
    DEFAULT_TRANSFER_CONCURRENCY,
    MAX_TRANSFER_CONCURRENCY,
} from './reconcile';
import type { SyncResult } from './reconcile';
import { driveFingerprint, statLocalEntry } from './walk';
import { resolveMoves } from './moves';

export interface SyncDeltaOptions {
    sdk: ProtonDriveClient;
    pairId: string;
    localDir: string;
    driveFolderUid: string;
    driveFolderName?: string;
    db: SyncDB;
    /** Drive-side changes mapped to this pair (created/updated/deleted). */
    targets: SyncTarget[];
    /** Local-side changes (added/modified/removed) from the stat-scan. */
    localDiff: LocalDiff;
    deletionThresholdPct?: number;
    log?: (msg: string) => void;
    onProgress?: ProgressHandler;
    shouldAbort?: () => boolean;
    progressMinBytes?: number;
    transferConcurrency?: number;
    allowDeletions?: boolean;
    /** Re-upload local items missing on Drive (restore path); the delta will
     *  fall back to the full walk on a stale parent regardless. */
    restoreToDrive?: boolean;
}

/**
 * Surgical delta sync: reconcile ONLY the nodes the Drive event feed and the
 * local stat-scan flagged as changed, instead of full-walking both trees. The
 * Drive listing (the dominant cost) is replaced with targeted `getNode` calls;
 * local detection stays a full stat-scan (cheap, and required because NAS
 * NFS/SMB mounts emit no inotify for remote writes). Local-side changes resolve
 * their Drive counterpart from sync.db (stored driveUid/fingerprint) rather than
 * re-listing, so a local edit uploads a revision with zero Drive listing.
 *
 * Returns null when it cannot complete surgically (a Drive target's `getNode`
 * failed - node vanished or a transient error), signalling the caller to fall
 * back to the full walk.
 */
export async function syncDelta(options: SyncDeltaOptions): Promise<SyncResult | null> {
    const {
        sdk,
        pairId,
        localDir,
        driveFolderUid,
        db,
        targets,
        localDiff,
        deletionThresholdPct,
        log = () => {},
        onProgress,
        shouldAbort,
        progressMinBytes,
        allowDeletions,
        restoreToDrive,
    } = options;

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
        restoreToDrive,
    });

    onProgress?.({ type: 'sync-start', pairId, localDir, driveFolderName: options.driveFolderName ?? '' });

    // 1. Source-availability gate (same safety net as the full walk).
    await assertSourceAvailable(localDir);

    // 1b. Resolve moves/renames as cheap renames first (M4), so the general
    //     reconcile never sees a "deleted old + created new" pair and re-transfers.
    const resolved = await resolveMoves(ctx, targets, localDiff);
    if (resolved === null) return null; // Drive-side move unresolved - full walk
    const { targets: effTargets, localDiff: effLocalDiff } = resolved;

    // 2. Collect affected relPaths and close them under ancestors so every
    //    targeted file/folder has its parent folders present for reconcile
    //    (parent UIDs are needed to create/upload into subfolders).
    const affected = new Set<string>();
    const addWithAncestors = (relPath: string): void => {
        let p = relPath;
        for (;;) {
            affected.add(p);
            const parent = path.posix.dirname(p);
            if (parent === '.' || parent === p) break;
            p = parent;
        }
    };
    for (const t of effTargets) if (t.relPath !== null) addWithAncestors(t.relPath);
    for (const e of effLocalDiff.added) addWithAncestors(e.relPath);
    for (const e of effLocalDiff.modified) addWithAncestors(e.relPath);
    for (const n of effLocalDiff.removed) addWithAncestors(n.relPath);

    // 3. Local side: seed from the diff (already has stat data), then stat any
    //    remaining affected relPath (Drive-targeted nodes and ancestors).
    for (const e of effLocalDiff.added) ctx.localByRel.set(e.relPath, e);
    for (const e of effLocalDiff.modified) ctx.localByRel.set(e.relPath, e);
    for (const relPath of affected) {
        if (ctx.localByRel.has(relPath)) continue;
        const le = await statLocalEntry(localDir, relPath);
        if (le) ctx.localByRel.set(relPath, le);
    }

    // 4. Drive side: created/updated targets fetch their node (targeted getNode);
    //    deleted targets are absent (nothing to fetch). Then backfill any affected
    //    relPath that has a stored node with a known driveUid, so local changes
    //    resolve their Drive side from sync.db without an API call. relPaths with a
    //    `deleted` target are skipped in the backfill: the node is gone from Drive,
    //    so backfilling it would make reconcile treat it as "still present" and
    //    skip the recycle instead of soft-deleting the local copy.
    const deletedRelPaths = new Set<string>();
    for (const t of effTargets) {
        if (t.op === 'deleted' && t.relPath !== null) deletedRelPaths.add(t.relPath);
    }
    for (const t of effTargets) {
        if (t.relPath === null) continue;
        if (t.op === 'deleted') continue;
        let node;
        try {
            node = await sdk.getNode(t.driveUid);
        } catch {
            return null; // node vanished / transient - fall back to the full walk
        }
        const kind = node.type === NodeType.Folder ? 'folder' : 'file';
        ctx.driveByRel.set(t.relPath, {
            relPath: t.relPath,
            uid: t.driveUid,
            kind,
            fingerprint: kind === 'file' ? driveFingerprint(node) : '',
            node,
        });
    }
    for (const relPath of affected) {
        if (ctx.driveByRel.has(relPath)) continue;
        if (deletedRelPaths.has(relPath)) continue;
        const s = db.getNode(pairId, relPath);
        if (s && s.driveUid) {
            ctx.driveByRel.set(relPath, {
                relPath,
                uid: s.driveUid,
                kind: s.kind,
                fingerprint: s.kind === 'file' ? (s.driveFingerprint ?? '') : '',
            });
        }
    }

    // 5. Stored side: load only the affected nodes (targeted).
    for (const relPath of affected) {
        const s = db.getNode(pairId, relPath);
        if (s) ctx.storedByRel.set(relPath, s);
    }
    ctx.totalTracked = db.countNodes(pairId);

    // 6. Freeze unresolved conflicts this cycle.
    for (const c of db.listConflicts(pairId)) ctx.pendingConflictRelPaths.add(c.relPath);

    // 7. Drive the shared per-node reconcile over the sparse context.
    const transferConcurrency = Math.min(MAX_TRANSFER_CONCURRENCY, Math.max(1, Math.floor(options.transferConcurrency ?? DEFAULT_TRANSFER_CONCURRENCY)));
    try {
        await runReconcile(ctx, transferConcurrency);
    } catch (err) {
        // A stale parent (Drive wiped or recreated externally) means our sparse
        // Drive-side view is wrong; fall back to the full walk, which re-lists
        // Drive authoritatively instead of aborting the whole sync on one folder.
        if (err instanceof StaleParentError) {
            const msg = `delta: falling back to full walk (${err.message})`;
            log(msg);
            onProgress?.({ type: 'log', message: msg });
            return null;
        }
        throw err;
    }

    return ctx.result;
}
