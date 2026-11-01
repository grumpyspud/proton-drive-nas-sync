import type { Pair, SyncDB, SyncNode } from '../state/syncDb';
import { walkLocalTree, type LocalEntry } from './walk';
import { logger } from '../logger';

/** The exact set of local changes vs the last-synced state in sync.db. */
export interface LocalDiff {
    /** Present on disk, absent from sync.db (new local file/folder). */
    added: LocalEntry[];
    /** Present on both, but kind/size/mtime diverged. */
    modified: LocalEntry[];
    /** Present in sync.db, gone from disk. */
    removed: SyncNode[];
}

/** True when the diff carries no changes at all. */
export function localDiffEmpty(d: LocalDiff): boolean {
    return d.added.length === 0 && d.modified.length === 0 && d.removed.length === 0;
}

/**
 * Stat-scan the pair's local dir and diff it against sync.db, returning the
 * exact changed nodes (added / modified / removed) rather than a boolean.
 * No hashing: files are matched by size + mtime; folders by presence only
 * (their mtime changes on any child change, which the file checks capture).
 *
 * This is the local-side counterpart to mapEventsToTargets: detection stays a
 * full stat-scan (NAS NFS/SMB mounts do not emit inotify events for remote
 * writes), but it yields the precise node set the delta engine can act on
 * surgically instead of full-walking the pair.
 */
export async function diffLocal(db: SyncDB, pair: Pair): Promise<LocalDiff> {
    const t0 = Date.now();
    const stored = await db.allNodesAsync(pair.id);
    const t1 = Date.now();
    const storedByRel = new Map(stored.map((n) => [n.relPath, n]));
    const local = await walkLocalTree(pair.localDir);
    const t2 = Date.now();

    const added: LocalEntry[] = [];
    const modified: LocalEntry[] = [];
    const localByRel = new Set<string>();

    for (const e of local) {
        localByRel.add(e.relPath);
        const s = storedByRel.get(e.relPath);
        if (!s) {
            added.push(e);
        } else if (s.kind !== e.kind || (e.kind === 'file' && (s.localSize !== e.size || s.localMtime !== e.mtimeMs))) {
            modified.push(e);
        }
    }

    const removed: SyncNode[] = [];
    for (const rel of storedByRel.keys()) {
        if (!localByRel.has(rel)) removed.push(storedByRel.get(rel)!);
    }

    const t3 = Date.now();
    logger.info(
        `stat-scan ${pair.id}: db=${t1 - t0}ms walk=${t2 - t1}ms diff=${t3 - t2}ms (${stored.length} stored, ${local.length} local)`
    );

    return { added, modified, removed };
}
