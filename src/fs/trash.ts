import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fsRoot } from './browse';

export interface TrashItem {
    ts: number;
    relPath: string; // posix-style, relative to the pair folder root
    size: number;
    mtimeMs: number;
}

function trashRoot(localDir: string): string {
    return join(localDir, '.pdn-trash');
}

/** Resolve + confine a pair's localDir under fsRoot(). */
function resolveLocalDir(localDir: string): string {
    const root = fsRoot();
    const abs = isAbsolute(localDir) ? resolve(localDir) : resolve(root, localDir);
    const rel = relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('Pair folder is outside the allowed root');
    }
    return abs;
}

/** Resolve a specific trash item (ts + posix relPath) under the trash root, confined. */
function resolveItem(localDir: string, ts: string, relPath: string): string {
    if (!/^\d+$/.test(ts)) throw new Error('Invalid trash timestamp');
    const root = trashRoot(resolveLocalDir(localDir));
    const segs = relPath.split('/').filter((s) => s.length > 0);
    if (segs.length === 0 || segs.some((s) => s === '..' || s === '.')) {
        throw new Error('Invalid trash path');
    }
    const tsDir = join(root, ts);
    let p = tsDir;
    for (const s of segs) p = join(p, s);
    const rel = relative(tsDir, p);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes trash');
    return p;
}

export function listTrash(localDir: string): TrashItem[] {
    const root = trashRoot(resolveLocalDir(localDir));
    if (!existsSync(root)) return [];
    const items: TrashItem[] = [];
    for (const tsEntry of readdirSync(root, { withFileTypes: true })) {
        if (!tsEntry.isDirectory() || !/^\d+$/.test(tsEntry.name)) continue;
        collectFiles(join(root, tsEntry.name), '', Number(tsEntry.name), items);
    }
    items.sort((a, b) => b.ts - a.ts || a.relPath.localeCompare(b.relPath));
    return items;
}

function collectFiles(dir: string, rel: string, ts: number, out: TrashItem[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(abs, childRel, ts, out);
        } else if (entry.isFile()) {
            const st = statSync(abs);
            out.push({ ts, relPath: childRel, size: st.size, mtimeMs: st.mtimeMs });
        }
    }
}

export async function restoreTrashItem(localDir: string, ts: string, relPath: string): Promise<string> {
    const localAbs = resolveLocalDir(localDir);
    const src = resolveItem(localDir, ts, relPath);
    const dest = join(localAbs, ...relPath.split('/'));
    if (existsSync(dest)) throw new Error(`Destination already exists: ${relPath}`);
    await mkdir(dirname(dest), { recursive: true });
    await rename(src, dest);
    await removeEmptyParents(dirname(src), trashRoot(localAbs));
    return dest;
}

export async function deleteTrashItem(localDir: string, ts: string, relPath: string): Promise<void> {
    const src = resolveItem(localDir, ts, relPath);
    await rm(src, { recursive: true, force: true });
    await removeEmptyParents(dirname(src), trashRoot(resolveLocalDir(localDir)));
}

export async function clearTrash(localDir: string): Promise<void> {
    await rm(trashRoot(resolveLocalDir(localDir)), { recursive: true, force: true });
}

/**
 * Recycle a batch of local files into a single timestamped `.pdn-trash`
 * subfolder, preserving each file's relative path (restores keep structure).
 * Missing files are skipped. Returns the number of files moved.
 */
export async function recycleFiles(localDir: string, relPaths: string[]): Promise<number> {
    const localAbs = resolveLocalDir(localDir);
    const root = trashRoot(localAbs);
    const ts = Date.now();
    const batchDir = join(root, String(ts));
    await mkdir(batchDir, { recursive: true });
    let moved = 0;
    for (const relPath of relPaths) {
        const segs = relPath.split('/').filter((s) => s.length > 0);
        if (segs.length === 0 || segs.some((s) => s === '..' || s === '.')) continue;
        const src = join(localAbs, ...segs);
        if (!existsSync(src)) continue;
        const dst = join(batchDir, ...segs);
        await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
        moved++;
    }
    if (moved === 0) await rm(batchDir, { recursive: true, force: true });
    return moved;
}

/** Remove now-empty parent dirs (up to, but not including, `stopAt`). */
async function removeEmptyParents(dir: string, stopAt: string): Promise<void> {
    const stop = resolve(stopAt);
    let cur = resolve(dir);
    while (cur.startsWith(stop + sep)) {
        try {
            if (readdirSync(cur).length > 0) break;
            await rm(cur, { recursive: true, force: true });
        } catch {
            break;
        }
        cur = dirname(cur);
    }
}
