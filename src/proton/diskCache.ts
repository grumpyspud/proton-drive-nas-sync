import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';

/**
 * Persistent, disk-backed cache for the Drive SDK's entity cache.
 *
 * The SDK's default `MemoryCache` holds every fetched entity in RAM, which on a
 * large tree consumes many gigabytes. This cache instead writes each entity through
 * to a SQLite database on disk, so memory stays bounded and the cache survives a
 * container restart (no cold re-scan). A bounded in-memory LRU front (sized by
 * `maxEntries`) keeps hot entries in RAM for fast reads; `maxEntries` of 0 skips
 * the front entirely and serves every read straight from disk.
 *
 * Only used for the entity cache (`ProtonDriveCache<string>`): the SDK already
 * serializes entities to JSON strings, so there is nothing to transform. The
 * crypto cache stays in-memory because its values are opaque crypto objects
 * (`PrivateKey` / `SessionKey` / `Uint8Array`) that do not serialize cleanly, and
 * it is small enough that it is not the memory problem.
 *
 * The SQLite operations are synchronous (`node:sqlite` `DatabaseSync`), so each
 * individual read/write blocks the event loop only for microseconds (WAL +
 * NORMAL synchronous, single-row ops). Bulk iterators yield every `YIELD_EVERY`
 * entries to keep `/api/health` responsive.
 */
export class DiskCache implements ProtonDriveCache<string> {
    private static readonly YIELD_EVERY = 200;

    private readonly db: DatabaseSync;
    private readonly mem = new Map<string, string>();
    private readonly maxEntries: number;

    constructor(dir: string, maxEntries: number) {
        if (!Number.isFinite(maxEntries) || maxEntries < 0) {
            throw new Error(`DiskCache maxEntries must be a non-negative integer (got ${maxEntries})`);
        }
        this.maxEntries = Math.floor(maxEntries);
        mkdirSync(dir, { recursive: true });
        this.db = new DatabaseSync(path.join(dir, 'cache.db'));
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS entities (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tags (
                tag TEXT NOT NULL,
                key TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
            CREATE INDEX IF NOT EXISTS idx_tags_key ON tags(key);
        `);
    }

    /** Number of entries currently held in the in-memory LRU front (0 when disabled). */
    residentCount(): number {
        return this.mem.size;
    }

    /** Closes the underlying database (checkpoints the WAL). Safe to call once. */
    close(): void {
        this.db.close();
    }

    async clear(): Promise<void> {
        this.db.exec('DELETE FROM entities');
        this.db.exec('DELETE FROM tags');
        this.mem.clear();
    }

    async setEntity(key: string, value: string, tags?: string[]): Promise<void> {
        this.db.prepare('INSERT OR REPLACE INTO entities (key, value) VALUES (?, ?)').run(key, value);
        this.db.prepare('DELETE FROM tags WHERE key = ?').run(key);
        if (tags && tags.length > 0) {
            const insert = this.db.prepare('INSERT INTO tags (tag, key) VALUES (?, ?)');
            for (const tag of tags) insert.run(tag, key);
        }
        this.touchMem(key, value);
    }

    async getEntity(key: string): Promise<string> {
        const cached = this.mem.get(key);
        if (cached !== undefined) {
            this.touchMem(key, cached);
            return cached;
        }
        const row = this.db.prepare('SELECT value FROM entities WHERE key = ?').get(key) as { value: string } | undefined;
        if (!row) throw new Error('Entity not found');
        this.touchMem(key, row.value);
        return row.value;
    }

    async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<string>> {
        let i = 0;
        for (const key of keys) {
            try {
                yield { key, ok: true, value: await this.getEntity(key) };
            } catch {
                yield { key, ok: false, error: 'Entity not found' };
            }
            if (++i % DiskCache.YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
        }
    }

    async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
        const rows = this.db.prepare('SELECT key FROM tags WHERE tag = ?').all(tag) as Array<{ key: string }>;
        let i = 0;
        for (const { key } of rows) {
            try {
                yield { key, ok: true, value: await this.getEntity(key) };
            } catch {
                yield { key, ok: false, error: 'Entity not found' };
            }
            if (++i % DiskCache.YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
        }
    }

    async removeEntities(keys: string[]): Promise<void> {
        const delEntity = this.db.prepare('DELETE FROM entities WHERE key = ?');
        const delTags = this.db.prepare('DELETE FROM tags WHERE key = ?');
        for (const key of keys) {
            delEntity.run(key);
            delTags.run(key);
            this.mem.delete(key);
        }
    }

    /** Write-through is already durable, so eviction only trims the RAM front. */
    private touchMem(key: string, value: string): void {
        if (this.maxEntries === 0) return;
        this.mem.delete(key);
        this.mem.set(key, value);
        while (this.mem.size > this.maxEntries) {
            const oldest = this.mem.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.mem.delete(oldest);
        }
    }
}
