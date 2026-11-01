import { DriveEventType } from '@protontech/drive-sdk';
import type { ProtonDriveClient } from '@protontech/drive-sdk';

/** A node-level change from the event feed (created/updated/deleted). */
export interface NodeEventInfo {
    type: 'created' | 'updated' | 'deleted';
    nodeUid: string;
    parentNodeUid?: string;
    isTrashed: boolean;
    isShared: boolean;
}

export interface EventPollResult {
    /** Node-level events since lastEventId, in feed order. */
    nodeEvents: NodeEventInfo[];
    /** A tree_refresh event: something changed but the feed cannot say what. */
    treeRefresh: boolean;
    /** A fast_forward event: we fell too far behind (or started fresh). */
    fastForward: boolean;
    /** A tree_remove event: the volume is gone. */
    treeRemove: boolean;
    /** The highest event ID processed, or the input lastEventId when none. */
    lastEventId: string | null;
}

/**
 * Drain the Drive event feed for a tree scope, replaying every event since
 * `lastEventId`. Side effect: `iterateEvents` runs each event through the SDK's
 * own cache listeners, so changed nodes are marked stale in the entity cache.
 * That is exactly what makes a persisted (`disk`) cache safe: a node marked
 * stale is re-fetched from the API on the next walk instead of being served
 * from the stale cache.
 *
 * When `lastEventId` is null (first run, or no saved ID), the SDK fetches the
 * latest ID and yields a single `fast_forward` event carrying it, then stops.
 * The caller persists the returned `lastEventId` so events are not replayed.
 */
export async function pollEvents(
    sdk: ProtonDriveClient,
    treeEventScopeId: string,
    lastEventId: string | null,
): Promise<EventPollResult> {
    const nodeEvents: NodeEventInfo[] = [];
    let treeRefresh = false;
    let fastForward = false;
    let treeRemove = false;
    let latest = lastEventId;

    for await (const ev of sdk.iterateEvents(treeEventScopeId, lastEventId ?? undefined)) {
        switch (ev.type) {
            case DriveEventType.NodeCreated:
                nodeEvents.push({ type: 'created', nodeUid: ev.nodeUid, parentNodeUid: ev.parentNodeUid, isTrashed: ev.isTrashed, isShared: ev.isShared });
                break;
            case DriveEventType.NodeUpdated:
                nodeEvents.push({ type: 'updated', nodeUid: ev.nodeUid, parentNodeUid: ev.parentNodeUid, isTrashed: ev.isTrashed, isShared: ev.isShared });
                break;
            case DriveEventType.NodeDeleted:
                nodeEvents.push({ type: 'deleted', nodeUid: ev.nodeUid, parentNodeUid: ev.parentNodeUid, isTrashed: false, isShared: false });
                break;
            case DriveEventType.TreeRefresh:
                treeRefresh = true;
                break;
            case DriveEventType.FastForward:
                fastForward = true;
                break;
            case DriveEventType.TreeRemove:
                treeRemove = true;
                break;
            case DriveEventType.SharedWithMeUpdated:
                // We do not sync shared folders.
                break;
        }
        if (ev.eventId !== 'none') latest = ev.eventId;
    }

    return { nodeEvents, treeRefresh, fastForward, treeRemove, lastEventId: latest };
}
