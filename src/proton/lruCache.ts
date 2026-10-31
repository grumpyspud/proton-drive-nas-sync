import type { EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';

/**
 * Bounded, in-memory, least-recently-used cache.
 *
 * The SDK's default `MemoryCache` is unbounded, so on a large tree it grows to
 * hold every fetched entity (~100 KB per node) and can consume tens of GB of
 * RAM. This cache caps the number of entries instead: once the map exceeds
 * `maxEntries`, the least-recently-used entries are evicted so the process has a
 * predictable memory ceiling on smaller hosts.
 *
 * "Recently used" is tracked via a `Map` (insertion order == recency): a
 * `setEntity`/`getEntity` deletes and re-inserts the key to move it to the back,
 * so the front of the map is always the least-recently-used entry to evict.
 */
export class LruCache<T> implements ProtonDriveCache<T> {
    private readonly entries = new Map<string, T>();
    private readonly entriesByTag = new Map<string, Set<string>>();
    private readonly maxEntries: number;

    constructor(maxEntries: number) {
        if (!Number.isFinite(maxEntries) || maxEntries < 1) {
            throw new Error(`LruCache maxEntries must be a positive integer (got ${maxEntries})`);
        }
        this.maxEntries = Math.floor(maxEntries);
    }

    async clear(): Promise<void> {
        this.entries.clear();
        this.entriesByTag.clear();
    }

    private markUsed(key: string): void {
        if (!this.entries.has(key)) return;
        const value = this.entries.get(key) as T;
        this.entries.delete(key);
        this.entries.set(key, value);
    }

    private evict(): void {
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
            this.removeKeyFromAllTags(oldest);
        }
    }

    private removeKeyFromAllTags(key: string): void {
        for (const [tag, keys] of this.entriesByTag) {
            keys.delete(key);
            if (keys.size === 0) this.entriesByTag.delete(tag);
        }
    }

    async setEntity(key: string, value: T, tags?: string[]): Promise<void> {
        this.entries.delete(key);
        this.entries.set(key, value);
        this.removeKeyFromAllTags(key);
        if (tags) {
            for (const tag of tags) {
                let keys = this.entriesByTag.get(tag);
                if (!keys) {
                    keys = new Set();
                    this.entriesByTag.set(tag, keys);
                }
                keys.add(key);
            }
        }
        this.evict();
    }

    async getEntity(key: string): Promise<T> {
        if (!this.entries.has(key)) {
            throw new Error('Entity not found');
        }
        this.markUsed(key);
        return this.entries.get(key) as T;
    }

    async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<T>> {
        for (const key of keys) {
            if (this.entries.has(key)) {
                yield { key, ok: true, value: this.entries.get(key) as T };
            } else {
                yield { key, ok: false, error: 'Entity not found' };
            }
        }
    }

    async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<T>> {
        const keys = this.entriesByTag.get(tag);
        if (!keys) return;
        yield* this.iterateEntities([...keys]);
    }

    async removeEntities(keys: string[]): Promise<void> {
        for (const key of keys) {
            this.entries.delete(key);
            this.removeKeyFromAllTags(key);
        }
    }
}
