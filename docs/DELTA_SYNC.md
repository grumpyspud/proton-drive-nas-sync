# Phase 2+3: Surgical Delta Sync Engine

Status: plan (not yet built). Replaces the Phase 2-only sketch and folds Phase 3 into it, per the decision that event-to-pair mapping is a prerequisite of event-to-node mapping, so building them separately is throwaway work.

Related: `docs/EVENT_DRIVEN_SYNC.md` (Phase 1 - the check-then-sync loop this builds on).

---

## 1. Objective

Today a sync cycle is a full three-way reconcile: walk every local path (`stat`), list every Drive folder (`iterateFolderChildren`), compare against `sync.db`, then hash/transfer only the changed files. The expensive part is the **Drive listing** (one network round-trip per folder) plus hashing of changed files. The local `stat` walk is cheap and is also how we detect local changes.

Goal: stop full-walking when we already know *which specific nodes changed*. Drive-side changes come from the event feed (targeted, by `nodeUid`). Local-side changes come from the existing `stat` scan diffed against `sync.db` (also targeted). For each changed node, apply a single targeted operation - upload, download, delete, mkdir, move - instead of re-walking the whole tree.

Non-goals: this is NOT a filesystem watcher. Local detection stays a `stat` scan (see section 5 for why). The full three-way walk is NOT removed - it becomes the fallback for the cases the delta cannot express.

---

## 2. The core idea

Two change sources feed one shared reconcile:

```
                    +---------------------------+
   Drive event feed | node_created / updated /  |
   (targeted)  ---> | deleted  (nodeUid)        |--+
                    +---------------------------+  |
                                                    |   map to (pair, relPath)
                    +---------------------------+  |
   Local stat-scan  | size/mtime diff vs sync.db|  |
   (targeted)  ---> | added / modified / removed|--+
                    +---------------------------  |
                                                   v
                              +--------------------------------------+
                              |  targeted three-way reconcile        |
                              |  (one op per changed node)           |
                              +--------------------------------------+
                                                   |
                          tree_refresh / fast_forward / first sync / unmappable
                                                   |
                                                   v
                              +--------------------------------------+
                              |  full syncOnce() fallback (today)    |
                              +--------------------------------------+
```

The key realization: a "targeted" operation still needs the *other* side to make the right call (upload vs conflict, download vs conflict). That cross-check is a single `stat` (local) or a single `getNode` (Drive, cached) - never a full listing.

---

## 3. Current state (what exists)

- `src/engine/sync.ts` - `syncOnce()`: full walk + three-way reconcile + deletion barrier. The reconcile logic (folder create, file upload/download/conflict/skip, soft-delete) is inline in `reconcileFile` / the folder loop / the deletion barrier.
- `src/proton/events.ts` - `pollEvents()`: drains the feed but returns only booleans (`driveChanged`, `treeRefresh`, `fastForward`, `lastEventId`), not the events themselves. It discards `nodeUid` / `parentNodeUid`.
- `src/engine/walk.ts` - `walkLocalTree()` (`readdir` + `stat` -> `size`/`mtimeMs`), `walkDriveTree()` (recursive `iterateFolderChildren`), `driveFingerprint()`.
- `src/state/syncDb.ts` - `nodes` table maps `driveUid` -> `(pairId, relPath, kind, driveFingerprint, localSha1, localSize, localMtime)`.
- `src/server/index.ts` - scheduler: polls feed once, then real-time pairs use `localDirty` check-then-sync; due auto-sync pairs full-walk unconditionally (the stopgap from the shared-feed bug, commit `c8b206d`).
- SDK: `getNodeHierarchy(nodeUid)` walks a node's ancestor chain; `getNode(uid)` fetches one node; `iterateEvents` marks changed nodes stale in the entity cache.

Change detection today (from `reconcileFile`):
- `localChanged = stored.localSha1 != null && rehashedSha1 !== stored.localSha1` (rehash is skipped when `stored.localSize === L.size && stored.localMtime === L.mtimeMs`).
- `driveChanged = stored.driveFingerprint != null && currentFingerprint !== stored.driveFingerprint`.

---

## 4. Architecture

### 4.1 Reconcile-core extraction (foundation)

Extract the inline reconcile into reusable per-node operations that take explicit state, so both the full walk and the delta engine call the *same* code (one reconcile, one set of safety nets):

```
reconcileFolder({ pairId, relPath, local?, drive?, stored? })  // create both ways, defer delete
reconcileFile({ pairId, relPath, local?, drive?, stored? })    // the 6-branch three-way merge
reconcileDeletions({ pairId, deletions })                       // tripwire + soft-delete
```

Each keeps the shared helpers: `downloadTo`, `recordConflict`, `transferReporter`, result counters, `checkAbort`, skip-on-error. This is a pure refactor with zero behavior change - full-walk output stays byte-identical. It is the safety foundation; both paths sit on it.

### 4.2 Event-to-target mapping (Drive side)

`pollEvents` changes to return the actual events, not just booleans:

```
interface NodeEvent { type; nodeUid; parentNodeUid?; isTrashed; eventId }
pollEvents(...) -> { events: NodeEvent[]; treeRefresh; fastForward; lastEventId }
```

Then `mapEventsToTargets(events, pairs, db, sdk)` resolves each event to a target:

1. **Fast path - sync.db**: `WHERE drive_uid = nodeUid` -> `(pairId, relPath)`. Covers `node_updated` / `node_deleted` on nodes we have already synced. Zero API calls.
2. **Ancestry walk** - for `node_created` (or any node not in `sync.db`): `getNodeHierarchy(nodeUid)` and find which pair's `driveFolderUid` sits in the ancestor chain. Produces the pair and, combined with the node name, the `relPath`.
3. **Fallback** - `tree_refresh` / `fast_forward` / `tree_remove`, or an ancestry walk that errors, mark that pair as "full-walk required".

Output: `Target = { pairId, relPath, op: 'created'|'updated'|'deleted', driveUid }`.

The `iterateEvents` side effect (marking changed nodes stale) already runs regardless, so any node we later `getNode` or full-walk is re-fetched fresh from the API - this keeps the persisted `disk` cache correct in the delta path.

### 4.3 Local stat-scan delta (local side)

Extract `diffLocal(localDir, db, pairId)` - the same size/mtime comparison `localDirty` already does, but returning the exact set instead of a boolean:

```
{ added: relPath[], modified: relPath[], removed: relPath[] }
```

This is the local-side "event feed": there is no push notification for local writes on a NAS share (see section 5), so the `stat` scan is the only reliable detector. It is cheap - `readdir` + `stat` per entry, no hashing, no network.

### 4.4 Targeted reconcile (the action)

For each resolved change, run a single targeted operation. The reconcile needs the *other* side to decide upload-vs-conflict, so each op does one cheap cross-check:

| Trigger | Cross-check needed | Result |
|---|---|---|
| Drive event `updated` (file F) | `stat` local F vs stored size/mtime | unchanged locally -> download; also changed -> conflict check |
| Drive event `created` | local existence | download / mkdir |
| Drive event `deleted` | local existence | soft-delete local |
| Local `added` / `modified` | `getNode(stored.driveUid)` fingerprint vs stored | drive unchanged -> upload; also changed -> conflict check |
| Local `removed` | drive fingerprint vs stored | drive unchanged -> soft-delete drive; also changed -> download |

The three-way *decision* is identical to `reconcileFile` today - we are narrowing the input set from "all files" to "the changed files", not rewriting the merge logic.

### 4.5 Scheduler integration

```
every REALTIME_INTERVAL_SECONDS:
  poll feed once (drain + stale-mark)
  if treeRefresh or fastForward -> full walk the affected pair(s)
  map events -> per-pair targets
  for each real-time pair: diffLocal -> local targets
  run targeted reconcile on the union of targets (per pair)
  run the deletion barrier (batched per tick)
  advance lastEventId only after a clean tick
```

Scheduled auto-sync pairs flip back from "always full walk" (the `c8b206d` stopgap) to "check-then-skip" - now correct, because mapping is pair-scoped, so a scheduled pair only syncs when an event maps into *its* folder (or its local scan is dirty). This resolves the original shared-feed bug at the root rather than by disabling the optimization.

---

## 5. Why the local side stays a stat-scan (not a watcher)

The local folder is a NAS share mounted into the container. NFS and SMB do not emit `inotify` events for writes made from *another* machine - a file dropped into the share from a laptop fires zero events inside the container. That is exactly the case a sync tool exists to catch, so a watcher would silently miss it.

The `stat` scan reads actual filesystem state and never misses. It is cheap: `readdir` + `stat` per entry, a few seconds for ~180k files, no hashing, no network. "Surgical" is about the *action* (only touch changed nodes), not the *detection* (which must stay a full scan on the local side).

Optional later optimization (not required): prune unchanged subdirectories using directory mtime, so we only descend into dirs whose contents may have changed. Content edits do not change a directory's mtime, so this only prunes for add/remove/rename, not content edits - a partial win, not a substitute for the scan.

---

## 6. Safety-net parity

Every safety net that lives inside the full walk must carry over to the delta path. Per-node, not per-walk:

| Safety net | Full walk today | Delta path |
|---|---|---|
| Source-availability gate (`assertSourceAvailable`) | start of cycle | start of tick (cheap, keep) |
| Deletion tripwire (`checkDeletionTripwire`) | over the whole cycle's delete set | batched over the tick's deletes; folder-delete counts its subtree (see open decision 1) |
| Soft-delete (local `.pdn-trash`, Drive trash) | yes | unchanged - targeted deletes still soft-delete |
| Conflict detection (`.conflict-*`) | three-way | cross-check of the other side on each targeted op |
| Dedupe (upload `expectedSha1`) | yes | keep passing `localSha1` |
| Partial-file cleanup (`*.pdn-part`) | walk-time | `downloadTo`/`uploadFile` already temp-file; unchanged |
| Skip-on-error per file | `try/catch` in `reconcileFile` | keep per-node |
| Frozen conflicts (`pendingConflictRelPaths`) | skip | keep per-node check |
| Abort / pause | `shouldAbort` between nodes | keep |

---

## 7. Per-node operation catalog

Each delta trigger maps to an existing `reconcileFile` / folder-loop branch, so behavior is identical:

| Event / local diff | Operation | reconcile branch |
|---|---|---|
| Drive `created` file | download | "new Drive file" |
| Drive `created` folder | mkdir local | "inDrive && !inLocal" folder |
| Drive `updated` file (local unchanged) | download (overwrite) | "driveChanged && !localChanged" |
| Drive `updated` file (local also changed) | conflict or skip | "localChanged && driveChanged" |
| Drive `deleted` file | soft-delete local | "inDrive false -> localDeletions" |
| Drive `deleted` folder | soft-delete local subtree | folder deletion (subtree) |
| Local `added` file | upload | "new local file" |
| Local `added` folder | mkdir Drive | "inLocal && !inDrive" folder |
| Local `modified` (drive unchanged) | upload revision | "localChanged && !driveChanged" |
| Local `modified` (drive also changed) | conflict or skip | "localChanged && driveChanged" |
| Local `removed` (drive unchanged) | soft-delete Drive | "driveDeletions" |
| Local `removed` (drive also changed) | download | "driveChanged && !inLocal" |

---

## 8. Edge cases

### 8.1 Move / rename

`node_updated` with a changed parent. Detect by comparing the node's new `relPath` (from ancestry) against the stored `relPath` (from `sync.db`). If they differ, it is a move:

- Sync the old pair (from `sync.db`) - its subtree lost an entry.
- Sync the new pair (from ancestry) - it gained one.
- Clean up the old local path, materialize the new one.

This is the single trickiest mapping case. `parentNodeUid` is on the event, so the ancestry walk is bounded; the risk is a *folder* move, which moves a whole subtree (many nodes) - handled as a folder-level operation, not per-file.

### 8.2 Folder delete

A `node_deleted` on a folder means the whole subtree is gone. Enumerate the subtree from `sync.db` by `relPath` prefix and soft-delete each local path under the deletion tripwire. The tripwire must count the subtree, not 1 (see open decision 1).

### 8.3 Self-write echo

Our own upload/download writes back to Drive and emits a `node_updated` on the next poll. Because we update `sync.db` to the exact new fingerprint during the transfer, re-processing our own echo hits the "unchanged -> skip" branch - a cheap no-op (one `stat` + one `getNode`), not a correctness bug. The reconcile is idempotent. Optional later: a `recentlySyncedUid -> relPath` set with a short TTL to skip the no-op entirely.

### 8.4 Deletion tripwire in the delta path

This is the one place targeted deletes are *less* safe than the full walk. A single `node_deleted` -> one file -> always under any threshold, so the tripwire would never fire. But a catastrophic Drive-side delete would emit *many* `node_deleted` events, which we would process one at a time across ticks without ever tripping an aggregate. Mitigation: batch all deletions within a tick (or short window) and tripwire over the batch; count folder deletes by subtree size. See open decision 1.

### 8.5 Event ordering / races

Events between the `stat` scan and the feed poll can race (a file changes on Drive right as we stat it). This is already tolerated by the full walk's three-way model: the stored fingerprint is the anchor, and any mismatch resolves to "re-fetch and compare". The delta path inherits the same tolerance; worst case is an extra targeted op, never data loss.

---

## 9. Fallback triggers (always available)

Full `syncOnce()` remains and is used whenever the delta cannot safely express the change:

- `tree_refresh` (changed but unspecified)
- `fast_forward` (fell too far behind / fresh start)
- `tree_remove` (volume gone)
- first sync / empty `sync.db` baseline
- any event that fails mapping (ancestry walk error, unknown parent)
- manual "Sync now" (explicit user intent - full reconcile)

An env flag (e.g. `PDN_DELTA=off`) forces the full walk for every pair, so we can revert to today's behavior instantly if the delta path misbehaves in production.

---

## 10. Milestones (each testable on grumpy-1)

**M0 - Reconcile-core extraction (pure refactor, no behavior change).**
Extract `reconcileFolder` / `reconcileFile` / `reconcileDeletions` with explicit `{local, drive, stored}` inputs. Full walk keeps calling them. Gate: full-sync output byte-identical to `c8b206d` (same counts, same transfers).

**M1 - Event-to-target mapping (Drive side).**
`pollEvents` returns `NodeEvent[]`; add `mapEventsToTargets`. Deploy behind the existing flag so mapping runs but still full-walks matched pairs. Gate: mapping verified correct against live grumpy-1 data before it is used to skip anything.

**M2 - Local stat-scan delta.**
Add `diffLocal` returning `{added, modified, removed}`. No behavior change yet - the full walk still runs; this just exposes the delta.

**M3 - Delta engine wiring (the surgical path).**
Scheduler builds per-pair targeted change sets and runs the M0 per-node reconcile on only those relPaths (with targeted `getNode`/`stat` cross-checks). Fallback to full walk on section 9 triggers. Scheduled auto-sync pairs switch back to check-then-skip. Gate: same end-state as a full walk, measurably less Drive listing.

**M4 - Hard cases.** Moves/renames, folder-delete subtree handling, self-write echo suppression, deletion-tripwire batching.

**M5 - Hardening + measurement.** Measure stat-scan vs full-walk on the ~173k tree; confirm the delta path skips the Drive listing; soak-test with real data; keep `PDN_DELTA=off` reachable.

---

## 11. Resolved decisions

1. **Deletion-tripwire granularity.** Batch all deletions per tick (plus folder-delete subtree counts) and run `checkDeletionTripwire` over the batch. Confirmed.
2. **Self-write echo.** Accept the idempotent no-op - we write the new fingerprint to `sync.db` during the transfer, so re-processing our own echo hits "unchanged -> skip". The `recentlySyncedUid` TTL set is a later micro-optimization only if the no-op ever shows up as a cost. Confirmed.
3. **Directory-mtime pruning** (local scan optimization). Deferred. Intended approach: check folder change times and narrow down until reaching the changed file(s). Note the pruning only helps for add/remove/rename - content edits do not bump a directory's mtime. Revisit only if measurement shows the stat-scan is a bottleneck.
4. **Move/rename scope.** File moves first (bounded), folder moves as a folder-level subtree op later. Confirmed.
