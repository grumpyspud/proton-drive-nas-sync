import path from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { sha1OfFile } from '../fs/files';
import type { SyncNode } from '../state/syncDb';
import type { LocalDiff } from './localDiff';
import type { SyncTarget } from './mapping';
import type { ReconcileContext } from './reconcile';
import { driveFingerprint, statLocalEntry, type LocalEntry } from './walk';

/** Result of resolving moves: the targets and local diff that still need the
 *  general reconcile, after any cheap move/rename has been applied. */
export interface ResolvedMoves {
    targets: SyncTarget[];
    localDiff: LocalDiff;
}

type DriveMoveOutcome = 'moved' | 'fallback' | 'fullwalk';
type FolderMoveOutcome = 'moved' | 'fullwalk';
type LocalMoveOutcome = 'moved' | 'fallback';

/** A relPath prefix rewrite implied by a folder move: `oldPrefix` -> `newPrefix`. */
interface PrefixRewrite {
    oldPrefix: string;
    newPrefix: string;
}

/** Rewrite a relPath that lives under a moved folder, else return it unchanged. */
function rewriteRelPath(relPath: string | null, rewrites: PrefixRewrite[]): string | null {
    if (relPath == null) return relPath;
    for (const r of rewrites) {
        if (relPath === r.oldPrefix) return r.newPrefix;
        if (relPath.startsWith(r.oldPrefix + '/')) return r.newPrefix + relPath.slice(r.oldPrefix.length);
    }
    return relPath;
}

/** Rewrite a target's relPath/oldRelPath after folder moves. A `moved` whose old
 *  and new paths collapsed to the same path is really an in-place update (the
 *  node only "moved" because its ancestor folder was renamed). */
function rewriteTarget(t: SyncTarget, rewrites: PrefixRewrite[]): SyncTarget {
    const relPath = rewriteRelPath(t.relPath, rewrites);
    const oldRelPath = t.oldRelPath != null ? rewriteRelPath(t.oldRelPath, rewrites) : t.oldRelPath;
    if (t.op === 'moved' && relPath != null && oldRelPath != null && relPath === oldRelPath) {
        return { ...t, relPath, oldRelPath: null, op: 'updated' };
    }
    return { ...t, relPath, oldRelPath };
}

/**
 * Resolve moves/renames as cheap metadata operations before the general
 * reconcile, so a rename is a local + Drive rename plus a sync.db relPath
 * update instead of a delete + full re-transfer.
 *
 * Drive-side moves arrive as `moved` targets (the event mapper detected a
 * within-pair file or folder move). A file move renames the local file; a folder
 * move renames the local subtree and rewrites the sync.db relPath prefix, then
 * re-points any sibling targets that live under the moved folder. Local-side
 * moves are a `removed` + `added` pair with identical content (matched by
 * size+mtime and verified by SHA-1); the Drive node is renamed/moved to match.
 *
 * Returns null when a Drive-side move cannot be resolved surgically (its
 * `getNode` failed, or a folder move hit an occupied destination), signalling the
 * caller to fall back to the full walk. Any move that cannot be applied cleanly
 * is left in the result so the normal delete + create/upload path handles it.
 */
export async function resolveMoves(ctx: ReconcileContext, targets: SyncTarget[], localDiff: LocalDiff): Promise<ResolvedMoves | null> {
    // 1. Drive-side folder moves first: rename the local subtree + rewrite the
    //    sync.db relPath prefix, recording the rewrites so sibling targets (a
    //    file created/deleted/edited under the moved folder in the same feed
    //    batch) are re-pointed at the new path.
    const rewrites: PrefixRewrite[] = [];
    const afterFolders: SyncTarget[] = [];
    for (const t of targets) {
        if (t.op === 'moved' && t.kind === 'folder' && t.oldRelPath != null && t.relPath != null) {
            const outcome = await applyDriveFolderMove(ctx, t);
            if (outcome === 'fullwalk') return null;
            if (outcome === 'moved') rewrites.push({ oldPrefix: t.oldRelPath, newPrefix: t.relPath });
        } else {
            afterFolders.push(t);
        }
    }

    // 2. Re-point sibling targets that live under the moved folders.
    const rewritten = afterFolders.map((t) => rewriteTarget(t, rewrites));

    // 3. Drive-side file moves (event-driven, unambiguous).
    const afterFiles: SyncTarget[] = [];
    for (const t of rewritten) {
        if (t.op !== 'moved' || t.oldRelPath == null || t.relPath == null) {
            afterFiles.push(t);
            continue;
        }
        const outcome = await applyDriveMove(ctx, t);
        if (outcome === 'fullwalk') return null;
        if (outcome === 'fallback') {
            afterFiles.push({ ...t, op: 'deleted', relPath: t.oldRelPath, oldRelPath: null });
            afterFiles.push({ ...t, op: 'created', relPath: t.relPath, oldRelPath: null });
        }
        // 'moved': consumed.
    }

    // 4. Local-side moves: match a removed node to an added entry with the same
    //    size + mtime, then verify content by SHA-1 before renaming on Drive.
    const consumedRemoved = new Set<number>();
    const consumedAdded = new Set<number>();
    for (const [i, r] of localDiff.removed.entries()) {
        if (r.kind !== 'file') continue;
        for (const [j, a] of localDiff.added.entries()) {
            if (consumedAdded.has(j)) continue;
            if (a.kind !== 'file') continue;
            if (a.size !== r.localSize || a.mtimeMs !== r.localMtime) continue;
            const outcome = await applyLocalMove(ctx, r, a);
            if (outcome === 'moved') {
                consumedRemoved.add(i);
                consumedAdded.add(j);
            }
            break; // one match per removed node at most
        }
    }
    const removedRemaining: SyncNode[] = [];
    const addedRemaining: LocalEntry[] = [];
    for (const [i, r] of localDiff.removed.entries()) if (!consumedRemoved.has(i)) removedRemaining.push(r);
    for (const [j, a] of localDiff.added.entries()) if (!consumedAdded.has(j)) addedRemaining.push(a);

    return {
        targets: afterFiles,
        localDiff: { added: addedRemaining, modified: localDiff.modified, removed: removedRemaining },
    };
}

/** Drive-side folder move/rename: rename the local folder (moving its whole
 *  subtree) and rewrite the relPath prefix in sync.db. The node's driveUid and
 *  every descendant's driveUid are unchanged - only the path prefix changed - so
 *  this is a metadata op, not a transfer. */
async function applyDriveFolderMove(ctx: ReconcileContext, t: SyncTarget): Promise<FolderMoveOutcome> {
    const oldRel = t.oldRelPath!;
    const newRel = t.relPath!;

    const localOld = await statLocalEntry(ctx.localDir, oldRel);
    if (localOld?.kind !== 'folder') return 'fullwalk';

    // Destination must be free (local and DB), and a cross-parent move needs its
    // new parent to already exist locally (otherwise we would move into an
    // un-synced parent).
    const localNew = await statLocalEntry(ctx.localDir, newRel);
    if (localNew != null) return 'fullwalk';
    if (ctx.db.getNode(ctx.pairId, newRel) != null) return 'fullwalk';
    const newParent = path.posix.dirname(newRel);
    if (newParent !== path.posix.dirname(oldRel)) {
        const parentEntry = newParent === '.' ? { kind: 'folder' as const } : await statLocalEntry(ctx.localDir, newParent);
        if (parentEntry?.kind !== 'folder') return 'fullwalk';
    }

    try {
        await mkdir(path.dirname(path.join(ctx.localDir, newRel)), { recursive: true });
        await rename(path.join(ctx.localDir, oldRel), path.join(ctx.localDir, newRel));
        ctx.db.renameSubtree(ctx.pairId, oldRel, newRel);
    } catch {
        return 'fullwalk';
    }

    ctx.result.moved++;
    ctx.onProgress?.({ type: 'item', action: 'move', relPath: newRel, message: `folder moved from ${oldRel}` });
    return 'moved';
}

/** Drive-side file move: rename the (unchanged) local file oldRel -> newRel. */
async function applyDriveMove(ctx: ReconcileContext, t: SyncTarget): Promise<DriveMoveOutcome> {
    const oldRel = t.oldRelPath!;
    const newRel = t.relPath!;

    let node;
    try {
        node = await ctx.sdk.getNode(t.driveUid);
    } catch {
        return 'fullwalk';
    }
    const stored = ctx.db.getNode(ctx.pairId, oldRel);
    if (!stored || stored.kind !== 'file') return 'fallback';

    const localOld = await statLocalEntry(ctx.localDir, oldRel);
    const localNew = await statLocalEntry(ctx.localDir, newRel);
    const unchanged =
        localOld != null &&
        localOld.kind === 'file' &&
        stored.localSize != null &&
        stored.localMtime != null &&
        localOld.size === stored.localSize &&
        localOld.mtimeMs === stored.localMtime;

    // Fall back when the local file changed (move+edit), or the destination is
    // already occupied (would clobber). Those are the delete + re-transfer path.
    if (!unchanged || localNew != null) return 'fallback';

    try {
        await mkdir(path.dirname(path.join(ctx.localDir, newRel)), { recursive: true });
        await rename(path.join(ctx.localDir, oldRel), path.join(ctx.localDir, newRel));
    } catch {
        return 'fallback';
    }

    ctx.db.removeNode(ctx.pairId, oldRel);
    ctx.db.upsertNode({
        pairId: ctx.pairId,
        relPath: newRel,
        kind: 'file',
        driveUid: t.driveUid,
        driveFingerprint: driveFingerprint(node),
        localSha1: stored.localSha1,
        localSize: stored.localSize,
        localMtime: stored.localMtime,
    });
    ctx.result.moved++;
    ctx.onProgress?.({ type: 'item', action: 'move', relPath: newRel, message: `moved from ${oldRel}` });
    return 'moved';
}

/** Local-side move: rename/move the Drive node to match the new local path. */
async function applyLocalMove(ctx: ReconcileContext, removedNode: SyncNode, addedEntry: LocalEntry): Promise<LocalMoveOutcome> {
    const oldRel = removedNode.relPath;
    const newRel = addedEntry.relPath;
    if (!removedNode.driveUid || !removedNode.localSha1) return 'fallback';

    // Verify the "added" file is byte-identical to the removed one before
    // renaming on Drive; a same-size + same-mtime coincidence must not turn a
    // copy into a rename.
    let addedSha1: string;
    try {
        addedSha1 = await sha1OfFile(addedEntry.absPath);
    } catch {
        return 'fallback';
    }
    if (addedSha1 !== removedNode.localSha1) return 'fallback';

    const oldParent = path.posix.dirname(oldRel);
    const newParent = path.posix.dirname(newRel);
    try {
        if (oldParent === newParent) {
            await ctx.sdk.renameNode(removedNode.driveUid, path.posix.basename(newRel));
        } else {
            const parentUid = newParent === '.' ? ctx.driveFolderUid : ctx.db.getNode(ctx.pairId, newParent)?.driveUid;
            if (!parentUid) return 'fallback'; // new parent not on Drive yet
            for await (const r of ctx.sdk.moveNodes([removedNode.driveUid], parentUid)) {
                if (!r.ok) throw r.error;
            }
        }
    } catch {
        return 'fallback';
    }

    ctx.db.removeNode(ctx.pairId, oldRel);
    ctx.db.upsertNode({ ...removedNode, relPath: newRel, localSize: addedEntry.size, localMtime: addedEntry.mtimeMs });
    ctx.result.moved++;
    ctx.onProgress?.({ type: 'item', action: 'move', relPath: newRel, message: `moved from ${oldRel} (Drive rename)` });
    return 'moved';
}
