import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { NodeType } from '@protontech/drive-sdk';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { nodeName } from '../fs/files';

export interface LocalEntry {
    relPath: string; // posix-style, relative to the source root
    absPath: string;
    kind: 'file' | 'folder';
    size: number;
    mtimeMs: number;
}

/** Recursively walks a local directory tree (files + folders). Symlinks are skipped. */
export async function walkLocalTree(root: string): Promise<LocalEntry[]> {
    const entries: LocalEntry[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const d of dirents) {
            const abs = path.join(dir, d.name);
            const relPath = rel === '' ? d.name : `${rel}/${d.name}`;
            if (d.isDirectory()) {
                const st = await stat(abs);
                entries.push({ relPath, absPath: abs, kind: 'folder', size: st.size, mtimeMs: st.mtimeMs });
                await walk(abs, relPath);
            } else if (d.isFile()) {
                const st = await stat(abs);
                entries.push({ relPath, absPath: abs, kind: 'file', size: st.size, mtimeMs: st.mtimeMs });
            }
        }
    }
    await walk(root, '');
    return entries;
}

export interface DriveEntry {
    relPath: string; // posix-style, relative to the walked folder
    uid: string;
    kind: 'file' | 'folder';
}

/** Recursively walks a Drive folder tree (files + folders). */
export async function walkDriveTree(sdk: ProtonDriveClient, folderUid: string, rel = ''): Promise<DriveEntry[]> {
    const entries: DriveEntry[] = [];
    for await (const child of sdk.iterateFolderChildren(folderUid)) {
        const name = nodeName(child.name);
        const relPath = rel === '' ? name : `${rel}/${name}`;
        const kind = child.type === NodeType.Folder ? 'folder' : 'file';
        entries.push({ relPath, uid: child.uid, kind });
        if (kind === 'folder') {
            entries.push(...(await walkDriveTree(sdk, child.uid, relPath)));
        }
    }
    return entries;
}
