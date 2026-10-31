import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DuplicateGroup, SyncDB } from '../state/syncDb';
import { recycleFiles } from '../fs/trash';

/**
 * Duplicate-file detection for a sync pair, built on the per-file SHA-1 hashes
 * the sync engine already persists in the state DB. Files are grouped by content
 * (sha1 + size); 0-byte files are always excluded, and a per-pair min-size floor
 * can raise the bar further. Deletion is soft (recycle to `.pdn-trash`); the
 * next sync trashes the Drive copies, behind the usual deletion tripwire.
 */

/** Scan a pair for content-duplicate files, dropping any that no longer exist on disk. */
export function scanDuplicates(db: SyncDB, pairId: string, localDir: string, minBytes: number): DuplicateGroup[] {
    const groups = db.listDuplicates(pairId, minBytes);
    const out: DuplicateGroup[] = [];
    for (const g of groups) {
        const files = g.files.filter((f) => existsSync(join(localDir, ...f.relPath.split('/'))));
        if (files.length >= 2) out.push({ ...g, files });
    }
    return out;
}

/**
 * Recycle the given duplicate files locally (soft delete). Enforces that at
 * least one copy of every content hash remains, and that every path still exists
 * on disk. Returns the number of files recycled.
 */
export async function recycleDuplicates(db: SyncDB, pairId: string, localDir: string, relPaths: string[]): Promise<number> {
    const unique = [...new Set(relPaths)];
    if (unique.length === 0) return 0;

    const nodes = db.allNodes(pairId).filter((n) => n.kind === 'file' && n.localSha1);
    const sha1ByPath = new Map<string, string>();
    const pathsBySha1 = new Map<string, Set<string>>();
    for (const n of nodes) {
        const sha1 = n.localSha1!;
        sha1ByPath.set(n.relPath, sha1);
        let s = pathsBySha1.get(sha1);
        if (!s) {
            s = new Set();
            pathsBySha1.set(sha1, s);
        }
        s.add(n.relPath);
    }

    const recycleBySha1 = new Map<string, string[]>();
    for (const rp of unique) {
        const sha1 = sha1ByPath.get(rp);
        if (!sha1) throw new Error(`Not a tracked local file: ${rp}`);
        const arr = recycleBySha1.get(sha1) ?? [];
        arr.push(rp);
        recycleBySha1.set(sha1, arr);
    }

    for (const [sha1, list] of recycleBySha1) {
        const total = pathsBySha1.get(sha1)?.size ?? 0;
        if (total - list.length < 1) {
            throw new Error('Refusing to remove every copy of a file: at least one duplicate must be kept.');
        }
    }

    for (const rp of unique) {
        if (!existsSync(join(localDir, ...rp.split('/')))) {
            throw new Error(`File no longer exists locally: ${rp}`);
        }
    }

    return recycleFiles(localDir, unique);
}
