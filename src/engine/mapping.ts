import { NodeType } from '@protontech/drive-sdk';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';
import type { Pair, SyncDB } from '../state/syncDb';
import type { NodeEventInfo } from '../proton/events';

/** A single change resolved to a specific pair (and, when known, a relPath). */
export interface SyncTarget {
    pairId: string;
    relPath: string | null;
    /** For `moved`: the node's previous relPath (same pair). */
    oldRelPath?: string | null;
    op: 'created' | 'updated' | 'deleted' | 'moved';
    driveUid: string;
    kind: 'file' | 'folder' | null;
}

export interface MappingResult {
    /** Changes resolved to a specific pair. */
    targets: SyncTarget[];
    /** Events that could not be mapped to any pair (conservative: full-walk all). */
    unmappable: NodeEventInfo[];
}

/**
 * Map node-level events to the sync pair(s) they affect.
 *
 * Fast path: a node whose driveUid is already in sync.db is looked up in one
 * indexed query, yielding its pair and relPath. This covers `updated`/`deleted`
 * on known nodes, and the OLD location of a moved node.
 *
 * Ancestry path: a `created`/`updated` node (or one we have never synced) is
 * resolved by walking its parent chain up to the pair root whose driveFolderUid
 * appears in it. `getNode` calls are mostly cache hits.
 *
 * Move/rename: an `updated` node with a new parent is mapped to BOTH its old
 * pair (from sync.db) and its new pair (from ancestry), since the old pair lost
 * a file and the new pair gained one.
 *
 * Any event that cannot be resolved goes to `unmappable`; the caller must treat
 * that as "full-walk every pair" rather than risk missing a change.
 */
export async function mapEventsToTargets(
    sdk: ProtonDriveClient,
    events: NodeEventInfo[],
    pairs: Pair[],
    db: SyncDB,
): Promise<MappingResult> {
    const pairByDriveUid = new Map<string, Pair>();
    for (const p of pairs) pairByDriveUid.set(p.driveFolderUid, p);

    const targets: SyncTarget[] = [];
    const unmappable: NodeEventInfo[] = [];

    // Walk the node's ancestor chain up to a pair root; returns the pair plus
    // the node's relPath within it. null when the node is under no pair (or the
    // walk fails, e.g. the node was deleted concurrently).
    async function resolveNode(nodeUid: string): Promise<{ pairId: string; relPath: string; kind: 'file' | 'folder' } | null> {
        const parts: string[] = [];
        const visited = new Set<string>();
        let current: string | undefined = nodeUid;
        let kind: 'file' | 'folder' | null = null;
        while (current) {
            if (visited.has(current)) return null;
            visited.add(current);
            const pair = pairByDriveUid.get(current);
            if (pair) {
                return { pairId: pair.id, relPath: parts.reverse().join('/'), kind: kind ?? 'folder' };
            }
            let node;
            try {
                node = await sdk.getNode(current);
            } catch {
                return null;
            }
            if (kind === null) kind = node.type === NodeType.Folder ? 'folder' : 'file';
            parts.push(nodeName(node.name));
            current = node.parentUid ?? undefined;
        }
        return null;
    }

    for (const ev of events) {
        // A trashed node is gone from the active tree, whether the feed reports
        // it as node_updated (isTrashed) or node_deleted. Treat it as a deletion:
        // if we still track it, trash the local copy; if we already removed it
        // (our own trash echo), skip so it is not resurrected as a "created".
        if (ev.isTrashed) {
            const known = db.getNodeByDriveUid(ev.nodeUid);
            if (known) {
                targets.push({ pairId: known.pairId, relPath: known.relPath, op: 'deleted', driveUid: ev.nodeUid, kind: known.kind });
            }
            continue;
        }

        if (ev.type === 'deleted') {
            // The node is gone: prefer sync.db (we know where it was).
            const known = db.getNodeByDriveUid(ev.nodeUid);
            if (known) {
                targets.push({ pairId: known.pairId, relPath: known.relPath, op: 'deleted', driveUid: ev.nodeUid, kind: known.kind });
                continue;
            }
            // Never-synced deletion: resolve the surviving parent's pair.
            if (ev.parentNodeUid) {
                const parent = await resolveNode(ev.parentNodeUid);
                if (parent) {
                    targets.push({ pairId: parent.pairId, relPath: null, op: 'deleted', driveUid: ev.nodeUid, kind: null });
                    continue;
                }
            }
            unmappable.push(ev);
            continue;
        }

        // created / updated: the node exists, resolve its current location.
        const resolved = await resolveNode(ev.nodeUid);

        if (ev.type === 'created') {
            if (resolved) {
                targets.push({ pairId: resolved.pairId, relPath: resolved.relPath, op: 'created', driveUid: ev.nodeUid, kind: resolved.kind });
            } else {
                unmappable.push(ev);
            }
            continue;
        }

        // updated: an in-place content change stays 'updated'. A move or rename
        // (the node's current location differs from its stored one) becomes a
        // delete at the old relPath + a create at the new relPath, so the delta
        // engine can act on both ends surgically without a move op.
        const known = db.getNodeByDriveUid(ev.nodeUid);
        if (known && resolved) {
            if (known.pairId === resolved.pairId && known.relPath === resolved.relPath) {
                targets.push({ pairId: known.pairId, relPath: known.relPath, op: 'updated', driveUid: ev.nodeUid, kind: known.kind });
            } else if (known.pairId === resolved.pairId && known.kind === 'file') {
                // Within-pair file move/rename: a cheap rename instead of a
                // delete + re-download. Folder moves stay delete+create (M4
                // scopes to file moves; folder subtree moves are a later op).
                targets.push({ pairId: known.pairId, relPath: resolved.relPath, oldRelPath: known.relPath, op: 'moved', driveUid: ev.nodeUid, kind: 'file' });
            } else {
                // Cross-pair move, or a folder move: delete old + create new.
                targets.push({ pairId: known.pairId, relPath: known.relPath, op: 'deleted', driveUid: ev.nodeUid, kind: known.kind });
                targets.push({ pairId: resolved.pairId, relPath: resolved.relPath, op: 'created', driveUid: ev.nodeUid, kind: resolved.kind });
            }
        } else if (known && !resolved) {
            // Known node whose current location could not be resolved (deleted or
            // transient). Keep it as 'updated'; the delta path retries getNode and
            // falls back to a full walk if that still fails.
            targets.push({ pairId: known.pairId, relPath: known.relPath, op: 'updated', driveUid: ev.nodeUid, kind: known.kind });
        } else if (!known && resolved) {
            targets.push({ pairId: resolved.pairId, relPath: resolved.relPath, op: 'created', driveUid: ev.nodeUid, kind: resolved.kind });
        } else {
            unmappable.push(ev);
        }
    }

    return { targets, unmappable };
}
