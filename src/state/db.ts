import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface NodeRecord {
    relPath: string;
    kind: 'file' | 'folder';
    driveUid: string | null;
    sha256: string | null;
    size: number | null;
    mtimeMs: number | null;
}

interface Row {
    rel_path: string;
    kind: string;
    drive_uid: string | null;
    sha256: string | null;
    size: number | null;
    mtime_ms: number | null;
}

function toRecord(row: Row): NodeRecord {
    return {
        relPath: row.rel_path,
        kind: row.kind as NodeRecord['kind'],
        driveUid: row.drive_uid,
        sha256: row.sha256,
        size: row.size,
        mtimeMs: row.mtime_ms,
    };
}

/**
 * SQLite state store mapping a relative path to its Drive node + change-detection
 * metadata (SHA-256, size, mtime). This is the foundation for incremental
 * backup (M3) and bidirectional sync (M4).
 */
export class StateDB {
    private readonly db: DatabaseSync;

    constructor(filePath: string) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        this.db = new DatabaseSync(filePath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS node_map (
                rel_path TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                drive_uid TEXT,
                sha256 TEXT,
                size INTEGER,
                mtime_ms INTEGER,
                updated_at INTEGER NOT NULL
            );
        `);
    }

    get(relPath: string): NodeRecord | undefined {
        const row = this.db.prepare('SELECT * FROM node_map WHERE rel_path = ?').get(relPath) as Row | undefined;
        return row ? toRecord(row) : undefined;
    }

    upsert(rec: NodeRecord): void {
        this.db
            .prepare(
                `
                INSERT INTO node_map (rel_path, kind, drive_uid, sha256, size, mtime_ms, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(rel_path) DO UPDATE SET
                    kind = excluded.kind,
                    drive_uid = excluded.drive_uid,
                    sha256 = excluded.sha256,
                    size = excluded.size,
                    mtime_ms = excluded.mtime_ms,
                    updated_at = excluded.updated_at
                `,
            )
            .run(rec.relPath, rec.kind, rec.driveUid, rec.sha256, rec.size, rec.mtimeMs, Date.now());
    }

    remove(relPath: string): void {
        this.db.prepare('DELETE FROM node_map WHERE rel_path = ?').run(relPath);
    }

    all(): NodeRecord[] {
        const rows = this.db.prepare('SELECT * FROM node_map ORDER BY rel_path').all() as unknown as Row[];
        return rows.map(toRecord);
    }

    count(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM node_map').get() as { n: number };
        return row.n;
    }

    close(): void {
        this.db.close();
    }
}
