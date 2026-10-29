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

export interface Pair {
    id: string;
    localDir: string;
    driveFolderName: string;
    driveFolderUid: string;
    /** Watch continuously (fixed 60s poll) while the server runs. */
    realTime: boolean;
    /** Sync on a schedule (intervalSeconds). */
    autoSync: boolean;
    /** Auto-sync frequency in seconds (0 = unset). */
    intervalSeconds: number;
    /** Epoch ms of the last completed sync, or null if never. */
    lastSyncAt: number | null;
    /** Run the duplicate scan after each sync for this pair. */
    dedupeEnabled: boolean;
    /** Min file size (bytes) for the duplicate scan; 0 = none (0-byte files are always skipped). */
    dedupeMinBytes: number;
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
    real_time: number;
    auto_sync: number;
    interval_seconds: number;
    last_sync_at: number | null;
    dedupe_enabled: number;
    dedupe_min_bytes: number;
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
        realTime: !!row.real_time,
        autoSync: !!row.auto_sync,
        intervalSeconds: row.interval_seconds ?? 0,
        lastSyncAt: row.last_sync_at ?? null,
        dedupeEnabled: !!row.dedupe_enabled,
        dedupeMinBytes: row.dedupe_min_bytes ?? 0,
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
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pairs (
                id TEXT PRIMARY KEY,
                local_dir TEXT NOT NULL,
                drive_folder_name TEXT NOT NULL,
                drive_folder_uid TEXT NOT NULL,
                real_time INTEGER NOT NULL DEFAULT 0,
                auto_sync INTEGER NOT NULL DEFAULT 0,
                interval_seconds INTEGER NOT NULL DEFAULT 0,
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
            CREATE TABLE IF NOT EXISTS dupe_ignored (
                pair_id TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                PRIMARY KEY (pair_id, rel_path)
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        this.migrate();
    }

    /** Add scheduling/dedupe columns to pre-existing pair tables (idempotent). */
    private migrate(): void {
        const cols = this.db.prepare('PRAGMA table_info(pairs)').all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        const add = (name: string, def: string) => {
            if (!names.has(name)) this.db.exec(`ALTER TABLE pairs ADD COLUMN ${name} ${def}`);
        };
        add('real_time', 'INTEGER NOT NULL DEFAULT 0');
        add('auto_sync', 'INTEGER NOT NULL DEFAULT 0');
        add('interval_seconds', 'INTEGER NOT NULL DEFAULT 0');
        add('last_sync_at', 'INTEGER');
        add('dedupe_enabled', 'INTEGER NOT NULL DEFAULT 0');
        add('dedupe_min_bytes', 'INTEGER NOT NULL DEFAULT 0');
    }

    upsertPair(pair: Pair): void {
        this.db
            .prepare(
                `
                INSERT INTO pairs (id, local_dir, drive_folder_name, drive_folder_uid, real_time, auto_sync, interval_seconds, last_sync_at, dedupe_enabled, dedupe_min_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    local_dir = excluded.local_dir,
                    drive_folder_name = excluded.drive_folder_name,
                    drive_folder_uid = excluded.drive_folder_uid,
                    real_time = excluded.real_time,
                    auto_sync = excluded.auto_sync,
                    interval_seconds = excluded.interval_seconds,
                    last_sync_at = excluded.last_sync_at,
                    dedupe_enabled = excluded.dedupe_enabled,
                    dedupe_min_bytes = excluded.dedupe_min_bytes
                `,
            )
            .run(
                pair.id,
                pair.localDir,
                pair.driveFolderName,
                pair.driveFolderUid,
                pair.realTime ? 1 : 0,
                pair.autoSync ? 1 : 0,
                pair.intervalSeconds,
                pair.lastSyncAt,
                pair.dedupeEnabled ? 1 : 0,
                pair.dedupeMinBytes,
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
        this.db.prepare('DELETE FROM dupe_ignored WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM pairs WHERE id = ?').run(id);
    }

    getNode(pairId: string, relPath: string): SyncNode | undefined {
        const row = this.db.prepare('SELECT * FROM nodes WHERE pair_id = ? AND rel_path = ?').get(pairId, relPath) as unknown as NodeRow | undefined;
        return row ? toNode(row) : undefined;
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

    allNodes(pairId: string): SyncNode[] {
        const rows = this.db.prepare('SELECT * FROM nodes WHERE pair_id = ? ORDER BY rel_path').all(pairId) as unknown as NodeRow[];
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

    close(): void {
        this.db.close();
    }
}
