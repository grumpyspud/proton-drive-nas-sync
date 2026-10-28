import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface DirFolder {
    name: string;
    path: string;
}

/**
 * A directory listing shared by both pickers:
 *  - local: `path` is an absolute filesystem path (e.g. "/data/photos")
 *  - drive: `path` is a slash-separated name path (e.g. "Backups/Photos")
 */
export interface DirListing {
    path: string;
    /** Human label for the listing root ("/data" or "My Files"). */
    root: string;
    /** Parent path, or null when already at the root (nothing to go up to). */
    parent: string | null;
    folders: DirFolder[];
}

/** The filesystem root the local picker may browse (never above it). */
export function fsRoot(): string {
    return resolve(process.env.PDN_FS_ROOT ?? '/data');
}

/**
 * Lists the immediate subdirectories of `requested`, which may be absolute
 * or relative to `fsRoot()`. Throws if the path is outside the allowed root,
 * missing, or not a directory (the picker surfaces these as a friendly note).
 */
export function listLocalDir(requested: string): DirListing {
    const root = fsRoot();
    const abs = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
    const rel = relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('Path is outside the allowed root');
    }
    if (!existsSync(abs)) throw new Error(`Path not found: ${abs}`);
    if (!statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);

    const folders: DirFolder[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) folders.push({ name: entry.name, path: join(abs, entry.name) });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));

    const parent = abs === root ? null : dirname(abs);
    return { path: abs, root, parent, folders };
}
