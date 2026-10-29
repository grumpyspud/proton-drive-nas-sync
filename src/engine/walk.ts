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
    /** Throttled live counter while the tree is being scanned (for progress UIs). */
    onProgress?: (stats: WalkProgress) => void;
}

/** Live scan stats emitted during a walk. */
export interface WalkProgress {
    files: number;
    folders: number;
}

/** Time-throttled emitter so a fast walk doesn't flood the event stream. */
function throttledProgress(onProgress: ((stats: WalkProgress) => void) | undefined, intervalMs = 500) {
    let last = 0;
    return (files: number, folders: number, force = false): void => {
        const now = Date.now();
        if (force || now - last >= intervalMs) {
            last = now;
            onProgress?.({ files, folders });
        }
    };
}

/**
 * Recursively walks a local directory tree (files + folders). Entries whose
 * name starts with `excludePrefix` (default `.pdn-` — the sync engine's
 * reserved namespace, e.g. `.pdn-trash`) are skipped. Symlinks are skipped.
 */
export async function walkLocalTree(root: string, options: WalkLocalOptions = {}): Promise<LocalEntry[]> {
    const { excludePrefix = '.pdn-', onPartial, onProgress } = options;
    const entries: LocalEntry[] = [];
    let files = 0;
    let folders = 0;
    const emit = throttledProgress(onProgress);
    async function walk(dir: string, rel: string): Promise<void> {
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const d of dirents) {
            if (d.name.startsWith(excludePrefix)) continue;
            const abs = path.join(dir, d.name);
            const relPath = rel === '' ? d.name : `${rel}/${d.name}`;
            if (d.isDirectory()) {
                const st = await stat(abs);
                folders++;
                entries.push({ relPath, absPath: abs, kind: 'folder', size: st.size, mtimeMs: st.mtimeMs });
                emit(files, folders);
                await walk(abs, relPath);
            } else if (d.isFile()) {
                if (d.name.endsWith('.pdn-part')) {
                    await onPartial?.(relPath, abs);
                    continue;
                }
                const st = await stat(abs);
                files++;
                entries.push({ relPath, absPath: abs, kind: 'file', size: st.size, mtimeMs: st.mtimeMs });
                emit(files, folders);
            }
        }
    }
    await walk(root, '');
    emit(files, folders, true);
    return entries;
}

export interface WalkDriveOptions {
    /** Invoked for each `*.pdn-part` file (already excluded from results). */
    onPartial?: (relPath: string, uid: string) => void | Promise<void>;
    /** Throttled live counter while the tree is being scanned (for progress UIs). */
    onProgress?: (stats: WalkProgress) => void;
}

/** Max concurrent Drive `iterateFolderChildren` calls during a walk. */
const DRIVE_WALK_CONCURRENCY = 8;
/** Transient listing errors (rate-limit, 5xx, network) are retried this many times. */
const DRIVE_LIST_MAX_RETRIES = 3;
/** Initial backoff (ms) for listing retries; doubles each attempt. */
const DRIVE_LIST_BASE_DELAY_MS = 500;

/** Rate-limit + server errors + transport failures are retryable; auth/validation (4xx) is not. */
function isRetryable(err: unknown): boolean {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (typeof status === 'number') return status === 429 || status >= 500;
    return true; // no HTTP status => network/transport error (fetch failed, reset, timeout, ...)
}

/** Lists one folder's children, retrying transient errors with exponential backoff. */
async function listFolderChildren(sdk: ProtonDriveClient, uid: string): Promise<NodeEntity[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= DRIVE_LIST_MAX_RETRIES; attempt++) {
        try {
            const children: NodeEntity[] = [];
            for await (const child of sdk.iterateFolderChildren(uid)) children.push(child);
            return children;
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === DRIVE_LIST_MAX_RETRIES) throw err;
            await new Promise((r) => setTimeout(r, DRIVE_LIST_BASE_DELAY_MS * 2 ** attempt));
        }
    }
    throw lastErr;
}

/**
 * Recursively walks a Drive folder tree (files + folders). Folder listings are
 * the dominant cost of a large sync (one network round-trip each), so they run
 * with bounded concurrency and transient errors are retried with backoff. Walk
 * ORDER is not meaningful to callers (they map by relPath), so parallelism is safe.
 */
export async function walkDriveTree(sdk: ProtonDriveClient, folderUid: string, rel = '', options: WalkDriveOptions = {}): Promise<DriveEntry[]> {
    const { onPartial, onProgress } = options;
    const entries: DriveEntry[] = [];
    let files = 0;
    let folders = 0;
    const emit = throttledProgress(onProgress);

    // Counting semaphore capping concurrent listing calls across the whole walk.
    let active = 0;
    const waiters: Array<() => void> = [];
    const acquire = async (): Promise<void> => {
        if (active < DRIVE_WALK_CONCURRENCY) {
            active++;
            return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        active++;
    };
    const release = (): void => {
        active--;
        const next = waiters.shift();
        if (next) next();
    };

    async function walk(folderUidInner: string, relInner: string): Promise<void> {
        const subfolders: Array<{ uid: string; rel: string }> = [];
        await acquire();
        try {
            for (const child of await listFolderChildren(sdk, folderUidInner)) {
                const name = nodeName(child.name);
                const childRel = relInner === '' ? name : `${relInner}/${name}`;
                const kind = child.type === NodeType.Folder ? 'folder' : 'file';
                if (name.endsWith('.pdn-part')) {
                    if (kind === 'file') await onPartial?.(childRel, child.uid);
                    continue;
                }
                entries.push({ relPath: childRel, uid: child.uid, kind, fingerprint: kind === 'file' ? driveFingerprint(child) : '', node: child });
                if (kind === 'folder') {
                    folders++;
                    subfolders.push({ uid: child.uid, rel: childRel });
                } else {
                    files++;
                }
                emit(files, folders);
            }
        } finally {
            release();
        }
        await Promise.all(subfolders.map((f) => walk(f.uid, f.rel)));
    }

    await walk(folderUid, rel);
    emit(files, folders, true);
    return entries;
}
