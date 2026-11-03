import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SyncNode {
    pairId: string;
    relPath: string;
    kind: 'file' | 'folder';
    driveUid: string | null;
    driveFingerprint: string | null;
    localSha1: string | null;
    localSize: number | null;
    localMtime: number | null;
}

export interface DuplicateFile {
    relPath: string;
    size: number;
    mtimeMs: number;
}

export interface DuplicateGroup {
    sha1: string;
    size: number;
    files: DuplicateFile[];
}

/** A pending sync conflict: the local version (at relPath) vs the preserved
 *  Drive version (at conflictPath, a `.conflict-<ts>` copy). */
export interface ConflictRecord {
    pairId: string;
    relPath: string;
    conflictPath: string;
    driveUid: string | null;
    localSha1: string | null;
    localSize: number | null;
    localMtime: number | null;
    conflictSha1: string | null;
    conflictSize: number | null;
    conflictMtime: number | null;
    createdAt: number;
}

export interface Pair {
    id: string;
    localDir: string;
    driveFolderName: string;
    driveFolderUid: string;
    /** Epoch ms of the last completed sync, or null if never. */
    lastSyncAt: number | null;
    /** Run the duplicate scan after each sync for this pair. */
    dedupeEnabled: boolean;
    /** Min file size (bytes) for the duplicate scan; 0 = none (0-byte files are always skipped). */
    dedupeMinBytes: number;
    /** Proton device uid when this pair syncs a Computers device (null = My Files pair). */
    deviceUid: string | null;
    /** Owning device-sync group id (null = My Files pair). */
    deviceSyncId: string | null;
}

/** A device sync: one NAS folder mirrored to the root folders of one or more
 *  Computers devices. Each member device is its own pair sharing this group's
 *  localDir. */
export interface DeviceSync {
    id: string;
    localDir: string;
    /** Auto add/remove devices on each sync run (at most one sync may enable this). */
    autoAddRemove: boolean;
    createdAt: number;
}

interface NodeRow {
    pair_id: string;
    rel_path: string;
    kind: string;
    drive_uid: string | null;
    drive_fingerprint: string | null;
    local_sha1: string | null;
    local_size: number | null;
    local_mtime: number | null;
}

interface PairRow {
    id: string;
    local_dir: string;
    drive_folder_name: string;
    drive_folder_uid: string;
    last_sync_at: number | null;
    dedupe_enabled: number;
    dedupe_min_bytes: number;
    device_uid: string | null;
    device_sync_id: string | null;
}

interface DeviceSyncRow {
    id: string;
    local_dir: string;
    auto_add_remove: number;
    created_at: number;
}

function toNode(row: NodeRow): SyncNode {
    return {
        pairId: row.pair_id,
        relPath: row.rel_path,
        kind: row.kind as SyncNode['kind'],
        driveUid: row.drive_uid,
        driveFingerprint: row.drive_fingerprint,
        localSha1: row.local_sha1,
        localSize: row.local_size,
        localMtime: row.local_mtime,
    };
}

function toPair(row: PairRow): Pair {
    return {
        id: row.id,
        localDir: row.local_dir,
        driveFolderName: row.drive_folder_name,
        driveFolderUid: row.drive_folder_uid,
        lastSyncAt: row.last_sync_at ?? null,
        dedupeEnabled: !!row.dedupe_enabled,
        dedupeMinBytes: row.dedupe_min_bytes ?? 0,
        deviceUid: row.device_uid ?? null,
        deviceSyncId: row.device_sync_id ?? null,
    };
}

function toDeviceSync(row: DeviceSyncRow): DeviceSync {
    return {
        id: row.id,
        localDir: row.local_dir,
        autoAddRemove: !!row.auto_add_remove,
        createdAt: row.created_at,
    };
}

interface ConflictRow {
    pair_id: string;
    rel_path: string;
    conflict_path: string;
    drive_uid: string | null;
    local_sha1: string | null;
    local_size: number | null;
    local_mtime: number | null;
    conflict_sha1: string | null;
    conflict_size: number | null;
    conflict_mtime: number | null;
    created_at: number;
}

function toConflict(row: ConflictRow): ConflictRecord {
    return {
        pairId: row.pair_id,
        relPath: row.rel_path,
        conflictPath: row.conflict_path,
        driveUid: row.drive_uid,
        localSha1: row.local_sha1,
        localSize: row.local_size,
        localMtime: row.local_mtime,
        conflictSha1: row.conflict_sha1,
        conflictSize: row.conflict_size,
        conflictMtime: row.conflict_mtime,
        createdAt: row.created_at,
    };
}

/**
 * Sync state store for the bidirectional engine. Unlike the M3 backup DB, this
 * tracks BOTH sides of a folder pair (drive fingerprint + local fingerprint) so
 * the engine can do a three-way reconcile (local vs drive vs last-synced). It
 * also stores per-pair scheduling (real-time / auto-sync) for the scheduler,
 * plus the duplicate-scan settings and ignore list.
 */
export class SyncDB {
    private readonly db: DatabaseSync;

    constructor(filePath: string) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        this.db = new DatabaseSync(filePath);
        // WAL + NORMAL synchronous cut per-write latency (no fsync-on-every-commit
        // like the default rollback journal). A power failure can lose the last few
        // committed rows but never corrupt the DB, and the sync is idempotent (a
        // rescan re-detects any diff).
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pairs (
                id TEXT PRIMARY KEY,
                local_dir TEXT NOT NULL,
                drive_folder_name TEXT NOT NULL,
                drive_folder_uid TEXT NOT NULL,
                last_sync_at INTEGER,
                dedupe_enabled INTEGER NOT NULL DEFAULT 0,
                dedupe_min_bytes INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS nodes (
                pair_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                kind TEXT NOT NULL,
                drive_uid TEXT,
                drive_fingerprint TEXT,
                local_sha1 TEXT,
                local_size INTEGER,
                local_mtime INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (pair_id, rel_path)
            );
            CREATE TABLE IF NOT EXISTS dir_mtimes (
                pair_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                mtime INTEGER NOT NULL,
                PRIMARY KEY (pair_id, rel_path)
            );
            CREATE TABLE IF NOT EXISTS dupe_ignored (
                pair_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                PRIMARY KEY (pair_id, rel_path)
            );
            CREATE TABLE IF NOT EXISTS conflicts (
                pair_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                conflict_path TEXT NOT NULL,
                drive_uid TEXT,
                local_sha1 TEXT,
                local_size INTEGER,
                local_mtime INTEGER,
                conflict_sha1 TEXT,
                conflict_size INTEGER,
                conflict_mtime INTEGER,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (pair_id, conflict_path)
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_syncs (
                id TEXT PRIMARY KEY,
                local_dir TEXT NOT NULL,
                auto_add_remove INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
        `);
        // Fast lookup of a node by its Drive uid (event -> pair mapping).
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_drive_uid ON nodes(drive_uid)');
        this.migrate();
    }

    /** Add scheduling/dedupe columns to pre-existing pair tables (idempotent). */
    private migrate(): void {
        const cols = this.db.prepare('PRAGMA table_info(pairs)').all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        const add = (name: string, def: string) => {
            if (!names.has(name)) this.db.exec(`ALTER TABLE pairs ADD COLUMN ${name} ${def}`);
        };
        add('last_sync_at', 'INTEGER');
        add('dedupe_enabled', 'INTEGER NOT NULL DEFAULT 0');
        add('dedupe_min_bytes', 'INTEGER NOT NULL DEFAULT 0');
        add('device_uid', 'TEXT');
        add('device_sync_id', 'TEXT');
        // A Computers device may belong to at most one device sync (enforced at the
        // DB level; NULL device_uid = a regular My Files pair, and multiple NULLs
        // are allowed by SQLite's partial-index semantics).
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pairs_device_uid ON pairs(device_uid) WHERE device_uid IS NOT NULL');
    }

    upsertPair(pair: Pair): void {
        this.db
            .prepare(
                `
                INSERT INTO pairs (id, local_dir, drive_folder_name, drive_folder_uid, last_sync_at, dedupe_enabled, dedupe_min_bytes, device_uid, device_sync_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    local_dir = excluded.local_dir,
                    drive_folder_name = excluded.drive_folder_name,
                    drive_folder_uid = excluded.drive_folder_uid,
                    last_sync_at = excluded.last_sync_at,
                    dedupe_enabled = excluded.dedupe_enabled,
                    dedupe_min_bytes = excluded.dedupe_min_bytes,
                    device_uid = excluded.device_uid,
                    device_sync_id = excluded.device_sync_id
                `,
            )
            .run(
                pair.id,
                pair.localDir,
                pair.driveFolderName,
                pair.driveFolderUid,
                pair.lastSyncAt,
                pair.dedupeEnabled ? 1 : 0,
                pair.dedupeMinBytes,
                pair.deviceUid,
                pair.deviceSyncId,
            );
    }

    getPair(id: string): Pair | undefined {
        const row = this.db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as unknown as PairRow | undefined;
        return row ? toPair(row) : undefined;
    }

    listPairs(): Pair[] {
        const rows = this.db.prepare('SELECT * FROM pairs ORDER BY id').all() as unknown as PairRow[];
        return rows.map(toPair);
    }

    /** Stamp the last completed sync time (drives the auto-sync scheduler). */
    markSynced(id: string): void {
        this.db.prepare('UPDATE pairs SET last_sync_at = ? WHERE id = ?').run(Date.now(), id);
    }

    removePair(id: string): void {
        this.db.prepare('DELETE FROM nodes WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM dir_mtimes WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM dupe_ignored WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM conflicts WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM pairs WHERE id = ?').run(id);
    }

    upsertDeviceSync(ds: DeviceSync): void {
        this.db
            .prepare(
                `INSERT INTO device_syncs (id, local_dir, auto_add_remove, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET local_dir = excluded.local_dir, auto_add_remove = excluded.auto_add_remove`,
            )
            .run(ds.id, ds.localDir, ds.autoAddRemove ? 1 : 0, ds.createdAt);
    }

    getDeviceSync(id: string): DeviceSync | undefined {
        const row = this.db.prepare('SELECT * FROM device_syncs WHERE id = ?').get(id) as unknown as DeviceSyncRow | undefined;
        return row ? toDeviceSync(row) : undefined;
    }

    listDeviceSyncs(): DeviceSync[] {
        const rows = this.db.prepare('SELECT * FROM device_syncs ORDER BY created_at').all() as unknown as DeviceSyncRow[];
        return rows.map(toDeviceSync);
    }

    /** Member pairs of a device sync (each member is a pair whose deviceUid is set). */
    listDeviceSyncPairs(syncId: string): Pair[] {
        const rows = this.db.prepare('SELECT * FROM pairs WHERE device_sync_id = ? ORDER BY id').all(syncId) as unknown as PairRow[];
        return rows.map(toPair);
    }

    /** Remove a device sync: drop every member pair (and its nodes/conflicts/etc),
     *  then the group row. Local files are left untouched. */
    removeDeviceSync(id: string): void {
        const memberIds = this.db.prepare('SELECT id FROM pairs WHERE device_sync_id = ?').all(id) as unknown as { id: string }[];
        for (const m of memberIds) this.removePair(m.id);
        this.db.prepare('DELETE FROM device_syncs WHERE id = ?').run(id);
    }

    getNode(pairId: string, relPath: string): SyncNode | undefined {
        const row = this.db.prepare('SELECT * FROM nodes WHERE pair_id = ? AND rel_path = ?').get(pairId, relPath) as unknown as NodeRow | undefined;
        return row ? toNode(row) : undefined;
    }

    /** Total tracked node count for a pair (deletion-tripwire denominator). */
    countNodes(pairId: string): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE pair_id = ?').get(pairId) as unknown as { n: number };
        return row.n;
    }

    /** Count a folder's whole subtree (itself + every descendant node). */
    countSubtree(pairId: string, relPath: string): number {
        const row = this.db
            .prepare('SELECT COUNT(*) AS n FROM nodes WHERE pair_id = ? AND (rel_path = ? OR rel_path LIKE ?)')
            .get(pairId, relPath, `${relPath}/%`) as unknown as { n: number };
        return row.n;
    }

    /** Rewrite a folder's relPath prefix for the folder itself and every
     *  descendant node, so a folder rename is a single atomic UPDATE instead of
     *  a delete + re-transfer. The drive_uid of every row is unchanged (a rename
     *  does not change a node's uid), only rel_path moves. Returns rows updated. */
    renameSubtree(pairId: string, oldRelPath: string, newRelPath: string): number {
        // Escape LIKE wildcards in the prefix so names with `_` or `%` match
        // literally; descendants are matched by the `/<rest>` tail after the prefix.
        const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
        return Number(
            this.db
                .prepare(
                    `UPDATE nodes SET rel_path = ? || substr(rel_path, ?)
                     WHERE pair_id = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')`,
                )
                .run(newRelPath, oldRelPath.length + 1, pairId, oldRelPath, `${escapeLike(oldRelPath)}/%`).changes,
        );
    }

    upsertNode(node: SyncNode): void {
        this.db
            .prepare(
                `
                INSERT INTO nodes (pair_id, rel_path, kind, drive_uid, drive_fingerprint, local_sha1, local_size, local_mtime, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(pair_id, rel_path) DO UPDATE SET
                    kind = excluded.kind,
                    drive_uid = excluded.drive_uid,
                    drive_fingerprint = excluded.drive_fingerprint,
                    local_sha1 = excluded.local_sha1,
                    local_size = excluded.local_size,
                    local_mtime = excluded.local_mtime,
                    updated_at = excluded.updated_at
                `,
            )
            .run(node.pairId, node.relPath, node.kind, node.driveUid, node.driveFingerprint, node.localSha1, node.localSize, node.localMtime, Date.now());
    }

    removeNode(pairId: string, relPath: string): void {
        this.db.prepare('DELETE FROM nodes WHERE pair_id = ? AND rel_path = ?').run(pairId, relPath);
    }

    /** Delete a node and every descendant. When the node is a folder this is the
     *  whole subtree (itself + all children at any depth); when it is a file the
     *  subtree is just itself. A folder deletion MUST use this and not removeNode,
     *  otherwise the children are left orphaned in sync.db and the next stat-scan
     *  misreads them as "deleted locally" and trashes their Drive copies. */
    removeSubtree(pairId: string, relPath: string): number {
        const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
        return Number(
            this.db
                .prepare(
                    `DELETE FROM nodes WHERE pair_id = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')`,
                )
                .run(pairId, relPath, `${escapeLike(relPath)}/%`).changes,
        );
    }

    allNodes(pairId: string): SyncNode[] {
        const rows = this.db.prepare('SELECT * FROM nodes WHERE pair_id = ? ORDER BY rel_path').all(pairId) as unknown as NodeRow[];
        return rows.map(toNode);
    }

    /** First node across all pairs whose Drive uid matches (event -> pair lookup). */
    getNodeByDriveUid(driveUid: string): SyncNode | undefined {
        const row = this.db.prepare('SELECT * FROM nodes WHERE drive_uid = ? LIMIT 1').get(driveUid) as unknown as NodeRow | undefined;
        return row ? toNode(row) : undefined;
    }

    /** Async variant of allNodes: streams the pair's rows in batches and yields
     *  to the event loop every `yieldEvery` rows, so a very large pair can't hold
     *  the single-threaded event loop (and block /api/health) for seconds at a time.
     *  Returns the same shape as allNodes. */
    async allNodesAsync(pairId: string, yieldEvery = 2000): Promise<SyncNode[]> {
        const stmt = this.db.prepare('SELECT * FROM nodes WHERE pair_id = ? ORDER BY rel_path');
        const out: SyncNode[] = [];
        let n = 0;
        for (const row of stmt.iterate(pairId) as unknown as Iterable<NodeRow>) {
            out.push(toNode(row));
            if (++n % yieldEvery === 0) await new Promise<void>((r) => setImmediate(r));
        }
        return out;
    }

    /** Stored directory mtimes for a pair (relPath -> mtime), the baseline the
     *  pruned local scan compares against. Empty until a scan populates it. The
     *  pair root is keyed as the empty string. */
    getDirMtimes(pairId: string): Map<string, number> {
        const rows = this.db.prepare('SELECT rel_path, mtime FROM dir_mtimes WHERE pair_id = ?').all(pairId) as unknown as Array<{ rel_path: string; mtime: number }>;
        return new Map(rows.map((r) => [r.rel_path, r.mtime]));
    }

    /** Record a directory's current mtime (the pruning baseline). */
    upsertDirMtime(pairId: string, relPath: string, mtime: number): void {
        this.db
            .prepare('INSERT INTO dir_mtimes (pair_id, rel_path, mtime) VALUES (?, ?, ?) ON CONFLICT(pair_id, rel_path) DO UPDATE SET mtime = excluded.mtime')
            .run(pairId, relPath, mtime);
    }

    /** Drop all stored dir mtimes for a pair. */
    clearDirMtimes(pairId: string): void {
        this.db.prepare('DELETE FROM dir_mtimes WHERE pair_id = ?').run(pairId);
    }

    /** Files that have been pulled from Drive but never hashed locally
     *  (local_sha1 IS NULL): the set a backfill pass must hash so the
     *  dedupe scan can see them. */
    listNodesWithNullSha1(pairId: string): SyncNode[] {
        const rows = this.db.prepare(`SELECT * FROM nodes WHERE pair_id = ? AND kind = 'file' AND local_sha1 IS NULL ORDER BY rel_path`).all(pairId) as unknown as NodeRow[];
        return rows.map(toNode);
    }

    /** RelPaths the user has asked to keep out of future duplicate scans. */
    ignoredPaths(pairId: string): Set<string> {
        const rows = this.db.prepare('SELECT rel_path FROM dupe_ignored WHERE pair_id = ?').all(pairId) as unknown as Array<{ rel_path: string }>;
        return new Set(rows.map((r) => r.rel_path));
    }

    ignorePaths(pairId: string, relPaths: string[]): void {
        const insert = this.db.prepare('INSERT OR IGNORE INTO dupe_ignored (pair_id, rel_path) VALUES (?, ?)');
        for (const rp of relPaths) insert.run(pairId, rp);
    }

    /** Remove the given relPaths from the pair's ignore list; returns rows removed. */
    unignorePaths(pairId: string, relPaths: string[]): number {
        const del = this.db.prepare('DELETE FROM dupe_ignored WHERE pair_id = ? AND rel_path = ?');
        let n = 0;
        for (const rp of relPaths) n += Number(del.run(pairId, rp).changes);
        return n;
    }

    /** Clear the pair's entire ignore list; returns rows removed. */
    clearIgnoredPaths(pairId: string): number {
        return Number(this.db.prepare('DELETE FROM dupe_ignored WHERE pair_id = ?').run(pairId).changes);
    }

    /**
     * Ignored relPaths grouped by content hash, so a duplicate group of N files is
     * listed (and un-ignored) as one unit. Paths whose node no longer resolves (or
     * has no hash) become single-file groups with a null sha1.
     */
    ignoredGroups(pairId: string): Array<{ sha1: string | null; size: number | null; files: string[] }> {
        const rows = this.db
            .prepare(
                `SELECT i.rel_path AS rel_path, n.local_sha1 AS sha1, n.local_size AS size
                 FROM dupe_ignored i
                 LEFT JOIN nodes n ON n.pair_id = i.pair_id AND n.rel_path = i.rel_path
                 WHERE i.pair_id = ?`,
            )
            .all(pairId) as unknown as Array<{ rel_path: string; sha1: string | null; size: number | null }>;

        const map = new Map<string, { sha1: string | null; size: number | null; files: string[] }>();
        for (const r of rows) {
            const key = r.sha1 ?? `orphan:${r.rel_path}`;
            let g = map.get(key);
            if (!g) {
                g = { sha1: r.sha1, size: r.size, files: [] };
                map.set(key, g);
            }
            g.files.push(r.rel_path);
        }

        const out = [...map.values()];
        for (const g of out) g.files.sort((a, b) => a.localeCompare(b));
        out.sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || (a.files[0] ?? '').localeCompare(b.files[0] ?? ''));
        return out;
    }

    /**
     * Group file nodes by content (sha1 + size), returning only groups with 2+
     * files. Excludes 0-byte files (always) and files below `minBytes`, plus any
     * relPath on the pair's ignore list.
     */
    listDuplicates(pairId: string, minBytes: number): DuplicateGroup[] {
        const ignored = this.ignoredPaths(pairId);
        const rows = this.db
            .prepare(
                `SELECT rel_path, local_sha1, local_size, local_mtime
                 FROM nodes
                 WHERE pair_id = ? AND kind = 'file' AND local_sha1 IS NOT NULL AND local_size IS NOT NULL AND local_size > 0
                 ORDER BY local_sha1, local_size, rel_path`,
            )
            .all(pairId) as unknown as Array<{ rel_path: string; local_sha1: string; local_size: number; local_mtime: number | null }>;

        const groups = new Map<string, DuplicateGroup>();
        for (const r of rows) {
            if (r.local_size < minBytes) continue;
            if (ignored.has(r.rel_path)) continue;
            const key = `${r.local_sha1}|${r.local_size}`;
            let g = groups.get(key);
            if (!g) {
                g = { sha1: r.local_sha1, size: r.local_size, files: [] };
                groups.set(key, g);
            }
            g.files.push({ relPath: r.rel_path, size: r.local_size, mtimeMs: r.local_mtime ?? 0 });
        }

        const out: DuplicateGroup[] = [];
        for (const g of groups.values()) {
            if (g.files.length >= 2) out.push(g);
        }
        out.sort((a, b) => b.size - a.size || a.sha1.localeCompare(b.sha1));
        for (const g of out) g.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
        return out;
    }

    /** Read a global setting by key (string-valued), or null when unset. */
    getSetting(key: string): string | null {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as { value: string } | undefined;
        return row?.value ?? null;
    }

    setSetting(key: string, value: string): void {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }

    /** Pending conflicts for a pair, oldest first. */
    listConflicts(pairId: string): ConflictRecord[] {
        const rows = this.db.prepare('SELECT * FROM conflicts WHERE pair_id = ? ORDER BY created_at').all(pairId) as unknown as ConflictRow[];
        return rows.map(toConflict);
    }

    upsertConflict(c: ConflictRecord): void {
        this.db
            .prepare(
                `INSERT INTO conflicts (pair_id, rel_path, conflict_path, drive_uid, local_sha1, local_size, local_mtime, conflict_sha1, conflict_size, conflict_mtime, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(pair_id, conflict_path) DO UPDATE SET
                    rel_path = excluded.rel_path,
                    drive_uid = excluded.drive_uid,
                    local_sha1 = excluded.local_sha1,
                    local_size = excluded.local_size,
                    local_mtime = excluded.local_mtime,
                    conflict_sha1 = excluded.conflict_sha1,
                    conflict_size = excluded.conflict_size,
                    conflict_mtime = excluded.conflict_mtime,
                    created_at = excluded.created_at`,
            )
            .run(c.pairId, c.relPath, c.conflictPath, c.driveUid, c.localSha1, c.localSize, c.localMtime, c.conflictSha1, c.conflictSize, c.conflictMtime, c.createdAt);
    }

    getConflict(pairId: string, conflictPath: string): ConflictRecord | undefined {
        const row = this.db.prepare('SELECT * FROM conflicts WHERE pair_id = ? AND conflict_path = ?').get(pairId, conflictPath) as unknown as ConflictRow | undefined;
        return row ? toConflict(row) : undefined;
    }

    removeConflict(pairId: string, conflictPath: string): void {
        this.db.prepare('DELETE FROM conflicts WHERE pair_id = ? AND conflict_path = ?').run(pairId, conflictPath);
    }

    close(): void {
        this.db.close();
    }
}
