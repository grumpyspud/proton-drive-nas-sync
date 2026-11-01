import { DriveEventType } from '@protontech/drive-sdk';
import type { ProtonDriveClient } from '@protontech/drive-sdk';

export interface EventPollResult {
    /** True when any node_created / node_updated / node_deleted event was seen. */
    driveChanged: boolean;
    /** A tree_refresh event: something changed but the feed cannot say what. */
    treeRefresh: boolean;
    /** A fast_forward event: we fell too far behind (or started fresh). */
    fastForward: boolean;
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
    let driveChanged = false;
    let treeRefresh = false;
    let fastForward = false;
    let latest = lastEventId;

    for await (const ev of sdk.iterateEvents(treeEventScopeId, lastEventId ?? undefined)) {
        switch (ev.type) {
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated:
            case DriveEventType.NodeDeleted:
                driveChanged = true;
                break;
            case DriveEventType.TreeRefresh:
                treeRefresh = true;
                break;
            case DriveEventType.FastForward:
                fastForward = true;
                break;
            case DriveEventType.TreeRemove:
            case DriveEventType.SharedWithMeUpdated:
                // tree_remove: the volume is gone; surfaced via the full-walk/error
                // path. shared_with_me_updated: we do not sync shared folders.
                break;
        }
        if (ev.eventId !== 'none') latest = ev.eventId;
    }

    return { driveChanged, treeRefresh, fastForward, lastEventId: latest };
}
