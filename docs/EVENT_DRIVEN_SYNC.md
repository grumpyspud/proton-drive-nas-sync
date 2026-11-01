# Event-Driven Incremental Sync

> **Superseded by `DELTA_SYNC.md`.** The check-then-sync loop described here is
> implemented and in production. Since then, auto-sync schedules were removed
> entirely: every pair is real-time (see DELTA_SYNC.md section 4.5). This doc is
> kept for the Phase 1 design history.

A plan to replace the fixed 60s full-walk scheduler with a check-then-sync loop
driven by the Proton Drive event feed and a local stat-scan, keeping the current
three-way walk as the fallback for `tree_refresh`, `fast_forward`, and first sync.

## Goal

- Make an idle sync cheap: skip the full Drive walk when nothing changed.
- Make `PDN_CACHE=disk` correct: the event feed marks only changed nodes stale,
  so a persisted cache can no longer silently miss a Drive-side modification.
- Keep every existing safety property intact (deletion tripwire, soft-delete,
  pending-conflict model, source-availability gate).

## Non-goals (this plan)

- No local filesystem watcher (inotify/chokidar). The local side is stat-scanned;
  there is no local change journal, and we accept that (scanning is cheap).
- No shared-folder sync. All pairs live under the single "My Files" volume, so one
  saved event ID covers every pair.

---

## How it works today

- `src/server/index.ts` runs `setInterval(schedulerTick, 60_000)`
  (`REAL_TIME_INTERVAL_MS = 60_000`).
- `duePairs()` returns any pair with `realTime` set (always due), or any
  `autoSync` pair whose `intervalSeconds` elapsed since `lastSyncAt`.
- Every due pair runs `runSync()` -> `syncOnce()`, which does a FULL
  `walkLocalTree()` + `walkDriveTree()` + three-way reconcile every time.
- There is no event-feed wiring anywhere (`latestEventId`, `core/v5/events`,
  `setNodesStale` all absent from `src/`).

Consequences:

- An idle sync still re-walks the whole Drive tree (~4 min warm, ~26 min cold).
- A persisted disk cache is unsafe: a file modified on Drive while the container
  is down is still served from cache, so `driveFingerprint` matches the stored
  value and the change is missed. (New/deleted files are still caught because
  folder child lists are re-fetched; only modified files are missed.)

---

## Proposed architecture

Two reliable layers plus a fallback:

1. **Event feed** -> Drive-side delta (what changed on Drive since last time).
2. **Stat-scan** -> local-side delta (what changed on the NAS since last time).
3. **Full walk** -> fallback (first sync, `tree_refresh`, `fast_forward`).

A single global check-then-sync loop, at `PDN_REALTIME_INTERVAL` seconds:

```
tick:
  if syncing || paused || pendingDeletion: return
  poll event feed for the "My Files" volume
  if no Drive events:
      stat-scan each real-time pair's local dir
  if Drive events OR local change OR tree_refresh/fast_forward:
      run sync for the affected pair(s)
  advance saved lastEventId to latest
```

The interval is how often we LOOK, not how often we sync. We sync only when a
change is found.

---

## Config surface

- `PDN_REALTIME_INTERVAL` (new, global env var): poll interval in seconds.
  Default `30`, clamped to `[10, 60]` (below 10 becomes 10, above 60 becomes 60).
  Parsed in `src/config.ts` alongside the other `PDN_*` vars.
- `real_time` pair flag (existing): now means "this pair participates in the
  check-then-sync loop" (its local dir is scanned each tick and it reacts to
  Drive events). `autoSync` + `intervalSeconds` (existing) are unchanged and
  still run the full scheduled walk.
- No DB schema change: the event ID lives in the existing `settings` key/value
  table.

---

## Phase 1 (build first): correctness + idle fast-path

Scope: wire the event feed and the check-then-sync loop. The sync itself remains
the existing full `syncOnce()` - we only change WHEN it runs and add feed wiring.
This is low-risk because the reconcile logic is untouched.

### 1.1 Event-feed wiring

- Get the "My Files" volume ID (`treeEventScopeId`) from the My Files root node
  (`getMyFilesRootFolder()` returns it; confirm `volumeId` vs `treeEventScopeId`
  at implementation time). All pairs share this one scope.
- Use `ProtonDriveClient.iterateEvents(treeEventScopeId, lastEventId, signal)`,
  the modern API. It:
  - yields `DriveEvent`s in order (types below),
  - runs each event through the SDK's own cache listeners, so changed nodes are
    marked stale automatically (this is what fixes the disk-cache bug),
  - when `lastEventId` is omitted, fetches the latest ID and yields a single
    `FastForward` event carrying that ID (our "start from latest" path).
- Event types we act on (`interface/events.ts`):
  - `node_created` / `node_updated` -> Drive-side change (Phase 1: set a dirty
    flag; Phase 2: reconcile just that node).
  - `node_deleted` -> Drive-side deletion (dirty flag; Phase 2: soft-delete).
  - `tree_refresh` -> full re-walk of the volume (fallback).
  - `tree_remove` -> volume removed; full re-walk / error.
  - `fast_forward` -> we fell too far behind; full re-walk and reset baseline.
  - `shared_with_me_updated` -> ignore (we do not sync shared folders).

### 1.2 Persist the event ID

- Store per-scope `lastEventId` in the existing `settings` table under keys like
  `lastEventId:<treeEventScopeId>` (future-proof for shared folders even though
  we only sync the one own volume now).
- After draining the feed, save the max `eventId` seen back to `settings`.
- On first run (no saved ID), `iterateEvents` yields `FastForward`; save its
  `eventId` as the new baseline and do a full sync.

### 1.3 Check-then-sync loop

Replace `setInterval(schedulerTick, 60_000)` with a loop at
`PDN_REALTIME_INTERVAL`. Each tick:

1. Guard on `syncing || paused || pendingDeletion` (same as today).
2. Poll the feed (1.1/1.2) once if any pair is real-time or due. Track
   `driveDirty`, `treeRefresh`, `fastForward`. The stale-marking side effect is
   what keeps every subsequent full walk correct, regardless of cache backend.
3. Run every due `autoSync` pair via its ORIGINAL full walk, unconditionally.
   Do NOT gate it on the feed: the feed is volume-wide and a real-time pair's
   drain consumes events for every pair, so "no new events since last poll" does
   not mean "this pair is clean", and the local scan is blind to Drive-side
   edits. (Confirmed on grumpy-1: a real-time pair drained an auto-sync pair's
   events; the auto-sync saw a clean feed + clean local scan and skipped a real
   change. Reverted to the full walk for scheduled pairs.)
4. For each `realTime` pair:
   - `driveDirty || treeRefresh || fastForward` -> full `syncOnce()`.
   - else stat-scan local: new/missing/differing path -> full `syncOnce()`.
   - else -> nothing (re-checked next tick).
5. Advance `lastEventId` to the drained max ID only after every triggered sync
   ran cleanly (no error / abort / tripwire). On any failure keep the old ID so
   the replayed events are re-processed next tick.

`autoSync` pairs keep the original scheduled full walk (user correction to
sign-off #3); only `realTime` pairs ride the feed + local scan fast path.

### 1.4 Self-write handling

Our own uploads/deletes generate Drive events, so the next tick re-drains them,
marks the just-written nodes stale, and runs one extra (no-op) full walk that
the existing fingerprint logic resolves as unchanged - no echo loop. We advance
`lastEventId` to the DRAINED max ID (not to "latest") and only after a clean
sync: jumping to "latest" via a `FastForward` probe would skip any external
event that landed mid-sync without marking its node stale, so the drained-max
approach is deliberately kept as the safe option. No verification round-trip -
the upload API already returns the new node, and the DB fingerprint is updated
from that response.

### 1.5 Deletion guard (unchanged)

`node_deleted` / any deletion still flows through `checkDeletionTripwire()` and
the soft-delete ("trash before delete") path inside `syncOnce()`. Phase 1 does
not touch this. Phase 2's delta-delete path reuses the same guard.

### 1.6 Acceptance criteria

- Idle sync (nothing changed) does not call `walkDriveTree()`; it costs one feed
  poll + one local stat-scan, well under a minute for ~180k files.
- A file modified on Drive while the container is down is detected on the next
  tick and pulled down (disk cache correctness).
- A file modified on the NAS is uploaded on the next tick.
- `tree_refresh` / `fast_forward` / first sync all fall back to the full walk.
- Deletion tripwire and soft-delete behavior are identical to today.
- `PDN_REALTIME_INTERVAL` clamping: 5 -> 10, 120 -> 60, unset -> 30.

---

## Phase 2 (sketch): per-node delta

Once Phase 1 is stable and measured, make a sync WITH changes cheap by
reconciling only the changed set instead of the full walk.

- **Event -> relPath mapping**: `node_updated`/`node_deleted` carry `nodeUid`;
  look up `relPath` via `db.nodes.drive_uid`. `node_created` needs its parent
  chain walked up to the pair root to compute the path.
- **Moves/renames**: a `node_updated` whose `parentNodeUid` changed is a move;
  update `db.nodes` relPath instead of treating it as delete + create.
- **Local delta**: reuse the stat-scan to produce the exact list of changed
  `relPath`s (new/modified/deleted), then run `reconcileFile()` only for those,
  not the whole tree.
- **Fallback unchanged**: `tree_refresh`, `fast_forward`, first sync, and any
  event the delta path cannot cleanly express still trigger the full walk.

This is the larger, fiddlier half (path mapping, move handling, parent-chain
walking) and is intentionally deferred so the high-value, low-risk Phase 1 ships
and is validated first.

---

## Risks and edge cases

- **Event-feed polling rate**: 30s (10s floor) is comfortably within Proton's
  limits; the SDK itself poll at 30s foreground. Do NOT drop below 10s.
- **`fast_forward` on long downtime**: Proton keeps a bounded event history, so
  a long-down container gets `fast_forward` -> full walk. Correct, just not
  incremental.
- **Local scan cost**: O(files) stat every tick even when idle. A few seconds
  for 180k files; acceptable at 30s. If it ever becomes the bottleneck, defer
  new-file discovery (readdir) to a less-frequent pass and stat only known paths
  in between.
- **Coarse pair granularity in Phase 1**: a Drive event does not map to a pair
  without Phase 2 path mapping, so any Drive change triggers sync for all
  real-time pairs. Correct but not minimal; Phase 2 resolves it.
- **Self-write echo**: no loop - drained-max advance plus the existing
  fingerprint match resolves our own uploads as unchanged (1.4). Downloads are
  read-only and generate no Drive events.

## Resolved decisions (user sign-off)

1. `PDN_REALTIME_INTERVAL` default 30s, clamp 10-60s - confirmed.
2. `real_time` now means "participates in the fast loop"; the old 60s full-walk
   scheduler is fully replaced.
3. `autoSync` pairs: reverted to their original scheduled full walk. Riding the
   feed + local scan (with an idle-skip) proved unsafe on a shared volume, so
   scheduled pairs no longer skip - only `realTime` pairs use the fast path.
