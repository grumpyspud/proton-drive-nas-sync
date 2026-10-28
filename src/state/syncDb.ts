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

export interface Pair {
    id: string;
    localDir: string;
    driveFolderName: string;
    driveFolderUid: string;
    /** Watch continuously (fixed 10s poll) while the server runs. */
    realTime: boolean;
    /** Sync on a schedule (intervalSeconds). */
    autoSync: boolean;
    /** Auto-sync frequency in seconds (0 = unset). */
    intervalSeconds: number;
    /** Epoch ms of the last completed sync, or null if never. */
    lastSyncAt: number | null;
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
    };
}

/**
 * Sync state store for the bidirectional engine. Unlike the M3 backup DB, this
 * tracks BOTH sides of a folder pair (drive fingerprint + local fingerprint) so
 * the engine can do a three-way reconcile (local vs drive vs last-synced). It
 * also stores per-pair scheduling (real-time / auto-sync) for the scheduler.
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
                last_sync_at INTEGER
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
        `);
        this.migrate();
    }

    /** Add scheduling columns to pre-existing pair tables (idempotent). */
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
    }

    upsertPair(pair: Pair): void {
        this.db
            .prepare(
                `
                INSERT INTO pairs (id, local_dir, drive_folder_name, drive_folder_uid, real_time, auto_sync, interval_seconds, last_sync_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    local_dir = excluded.local_dir,
                    drive_folder_name = excluded.drive_folder_name,
                    drive_folder_uid = excluded.drive_folder_uid,
                    real_time = excluded.real_time,
                    auto_sync = excluded.auto_sync,
                    interval_seconds = excluded.interval_seconds,
                    last_sync_at = excluded.last_sync_at
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

    close(): void {
        this.db.close();
    }
}
