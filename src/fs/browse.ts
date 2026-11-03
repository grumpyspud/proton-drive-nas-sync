import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isReservedDirName } from './reserved';
import { containingDataMount, dataMountPaths } from './volumes';

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
    /** Human label for the listing root (a bind-mount path, or "My Files"). */
    root: string;
    /** Parent path, or null when already at the root (nothing to go up to). */
    parent: string | null;
    folders: DirFolder[];
}

/** The first data mount (the default the local picker starts at). */
function firstRoot(): string {
    return dataMountPaths()[0] ?? '/data';
}

/** Resolves `requested` (absolute, or relative to the first mount). */
function resolveAbs(requested: string): string {
    return isAbsolute(requested) ? resolve(requested) : resolve(firstRoot(), requested);
}

/**
 * Lists the immediate subdirectories of `requested` (absolute, or relative to
 * the first data mount). Confined to the bind-mounted data volumes; reserved
 * `.pdn-*` folders are hidden. Throws if the path is outside an allowed mount,
 * missing, or not a directory (the picker surfaces these as a friendly note).
 */
export function listLocalDir(requested: string): DirListing {
    const abs = resolveAbs(requested);
    const root = containingDataMount(abs);
    if (!root) throw new Error('Path is outside the allowed root');
    if (!existsSync(abs)) throw new Error(`Path not found: ${abs}`);
    if (!statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);

    const folders: DirFolder[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && !isReservedDirName(entry.name)) {
            folders.push({ name: entry.name, path: join(abs, entry.name) });
        }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));

    const parent = abs === resolve(root) ? null : dirname(abs);
    return { path: abs, root, parent, folders };
}

/**
 * Creates a new subfolder `name` inside `parent` (absolute or relative to the
 * first data mount), confined to the bind-mounted data volumes. Reserved
 * `.pdn-*` names are rejected. Returns the new folder's absolute path.
 */
export function mkdirLocal(parent: string, name: string): { ok: boolean; path: string } {
    const clean = (name ?? '').trim();
    if (!clean) throw new Error('Folder name is required');
    if (/[\\/]/.test(clean) || clean === '.' || clean === '..') throw new Error('Invalid folder name');
    if (isReservedDirName(clean)) throw new Error('Reserved folder name');

    const abs = resolveAbs(parent);
    if (!containingDataMount(abs)) throw new Error('Path is outside the allowed root');
    const target = join(abs, clean);
    if (existsSync(target)) throw new Error(`Already exists: ${target}`);
    mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
}
