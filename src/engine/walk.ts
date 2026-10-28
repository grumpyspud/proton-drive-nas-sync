import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { NodeType } from '@protontech/drive-sdk';
import type { NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';

export interface LocalEntry {
    relPath: string; // posix-style, relative to the source root
    absPath: string;
    kind: 'file' | 'folder';
    size: number;
    mtimeMs: number;
}

export interface DriveEntry {
    relPath: string; // posix-style, relative to the walked folder
    uid: string;
    kind: 'file' | 'folder';
    fingerprint?: string; // content fingerprint for files ('' for folders)
    node?: NodeEntity;
}

/**
 * Content fingerprint for a Drive file, using the best signals the listing
 * exposes. Primary is `activeRevision.claimedDigests.sha1` (the SHA-1 the
 * uploader declared and the SDK verified); size and modification time are
 * fallbacks. Format: `sha1|claimedSize|mtimeMs`.
 */
export function driveFingerprint(node: NodeEntity): string {
    const rev = node.activeRevision;
    const sha1 = rev?.claimedDigests?.sha1 ?? '';
    const size = rev?.claimedSize ?? '';
    const mtime = (rev?.claimedModificationTime ?? node.modificationTime)?.getTime?.() ?? '';
    return `${sha1}|${size}|${mtime}`;
}

/** Best-effort byte size of a Drive file node (claimed size), or 0 if unknown. */
export function driveSize(node: NodeEntity | undefined): number {
    if (!node) return 0;
    const s = node.activeRevision?.claimedSize;
    if (typeof s === 'number') return s;
    if (typeof s === 'string') return Number(s) || 0;
    return 0;
}

export interface WalkLocalOptions {
    /** Entries whose name starts with this prefix are skipped (default `.pdn-`). */
    excludePrefix?: string;
    /** Invoked for each leftover `*.pdn-part` file (already excluded from results). */
    onPartial?: (relPath: string, absPath: string) => void | Promise<void>;
}

/**
 * Recursively walks a local directory tree (files + folders). Entries whose
 * name starts with `excludePrefix` (default `.pdn-` — the sync engine's
 * reserved namespace, e.g. `.pdn-trash`) are skipped. Symlinks are skipped.
 */
export async function walkLocalTree(root: string, options: WalkLocalOptions = {}): Promise<LocalEntry[]> {
    const { excludePrefix = '.pdn-', onPartial } = options;
    const entries: LocalEntry[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const d of dirents) {
            if (d.name.startsWith(excludePrefix)) continue;
            const abs = path.join(dir, d.name);
            const relPath = rel === '' ? d.name : `${rel}/${d.name}`;
            if (d.isDirectory()) {
                const st = await stat(abs);
                entries.push({ relPath, absPath: abs, kind: 'folder', size: st.size, mtimeMs: st.mtimeMs });
                await walk(abs, relPath);
            } else if (d.isFile()) {
                if (d.name.endsWith('.pdn-part')) {
                    await onPartial?.(relPath, abs);
                    continue;
                }
                const st = await stat(abs);
                entries.push({ relPath, absPath: abs, kind: 'file', size: st.size, mtimeMs: st.mtimeMs });
            }
        }
    }
    await walk(root, '');
    return entries;
}

export interface WalkDriveOptions {
    /** Invoked for each `*.pdn-part` file (already excluded from results). */
    onPartial?: (relPath: string, uid: string) => void | Promise<void>;
}

/** Recursively walks a Drive folder tree (files + folders). */
export async function walkDriveTree(sdk: ProtonDriveClient, folderUid: string, rel = '', options: WalkDriveOptions = {}): Promise<DriveEntry[]> {
    const { onPartial } = options;
    const entries: DriveEntry[] = [];
    for await (const child of sdk.iterateFolderChildren(folderUid)) {
        const name = nodeName(child.name);
        const relPath = rel === '' ? name : `${rel}/${name}`;
        const kind = child.type === NodeType.Folder ? 'folder' : 'file';
        if (name.endsWith('.pdn-part')) {
            if (kind === 'file') await onPartial?.(relPath, child.uid);
            continue;
        }
        entries.push({
            relPath,
            uid: child.uid,
            kind,
            fingerprint: kind === 'file' ? driveFingerprint(child) : '',
            node: child,
        });
        if (kind === 'folder') {
            entries.push(...(await walkDriveTree(sdk, child.uid, relPath, options)));
        }
    }
    return entries;
}
