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

/**
 * Sync state store for the bidirectional engine. Unlike the M3 backup DB, this
 * tracks BOTH sides of a folder pair (drive fingerprint + local fingerprint) so
 * the engine can do a three-way reconcile (local vs drive vs last-synced).
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
                drive_folder_uid TEXT NOT NULL
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
    }

    upsertPair(pair: Pair): void {
        this.db
            .prepare(
                `
                INSERT INTO pairs (id, local_dir, drive_folder_name, drive_folder_uid) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    local_dir = excluded.local_dir,
                    drive_folder_name = excluded.drive_folder_name,
                    drive_folder_uid = excluded.drive_folder_uid
                `,
            )
            .run(pair.id, pair.localDir, pair.driveFolderName, pair.driveFolderUid);
    }

    getPair(id: string): Pair | undefined {
        const row = this.db
            .prepare('SELECT * FROM pairs WHERE id = ?')
            .get(id) as { id: string; local_dir: string; drive_folder_name: string; drive_folder_uid: string } | undefined;
        return row ? { id: row.id, localDir: row.local_dir, driveFolderName: row.drive_folder_name, driveFolderUid: row.drive_folder_uid } : undefined;
    }

    listPairs(): Pair[] {
        const rows = this.db.prepare('SELECT * FROM pairs ORDER BY id').all() as unknown as {
            id: string;
            local_dir: string;
            drive_folder_name: string;
            drive_folder_uid: string;
        }[];
        return rows.map((r) => ({ id: r.id, localDir: r.local_dir, driveFolderName: r.drive_folder_name, driveFolderUid: r.drive_folder_uid }));
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
