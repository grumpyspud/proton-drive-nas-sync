export interface Pair {
    id: string;
    localDir: string;
    driveFolderName: string;
    driveFolderUid: string;
    lastSyncAt: number | null;
    dedupeEnabled: boolean;
    dedupeMinBytes: number;
}

export interface Device {
    uid: string;
    name: string;
    type: string;
    rootFolderUid: string;
    creationTime: number;
    lastSyncTime: number | null;
}

export interface SyncSummary {
    uploaded: number;
    downloaded: number;
    localRecycled: number;
    driveTrashed: number;
    conflicts: number;
    skipped: number;
    failed: number;
    moved: number;
}

export type TransferDirection = 'upload' | 'download';

export type SyncAction =
    | 'upload'
    | 'download'
    | 'skip'
    | 'skip-error'
    | 'trash-drive'
    | 'recycle-local'
    | 'cleanup-partial'
    | 'conflict'
    | 'mkdir-drive'
    | 'mkdir-local'
    | 'move';

export type SyncProgressEvent =
    | { type: 'sync-start'; pairId: string; localDir: string; driveFolderName: string }
    | { type: 'walk'; side: 'local' | 'drive'; files: number; folders: number }
    | { type: 'sync-plan'; totalBytes: number; totalFiles: number }
    | { type: 'preparing'; files: number }
    | { type: 'hashing'; relPath: string; hashed: number; total: number }
    | { type: 'transfer'; relPath: string; direction: TransferDirection; bytes: number; total: number; percent: number }
    | { type: 'overall'; transferredBytes: number; totalBytes: number; percent: number; speedBps: number; filesDone: number; totalFiles: number }
    | { type: 'hash-progress'; pairId: string; done: number; total: number }
    | { type: 'hash-complete'; pairId: string; hashed: number; total: number }
    | { type: 'hash-cancelled'; pairId: string }
    | { type: 'item'; action: SyncAction; relPath: string; message?: string }
    | { type: 'sync-complete'; pairId: string; summary: SyncSummary }
    | { type: 'sync-error'; message: string }
    | { type: 'sync-paused' }
    | { type: 'sync-resumed' }
    | { type: 'sync-stopped' }
    | { type: 'log'; message: string }
    | { type: 'deletion-hold'; pairId: string; totalTracked: number; deletions: number; pct: number; thresholdPct: number; driveTrash: string[]; localRecycle: string[] }
    | { type: 'deletion-confirmed' }
    | { type: 'deletion-restoring' }
    | { type: 'deletion-cancelled' };

export interface TransferState {
    relPath: string;
    direction: TransferDirection;
    bytes: number;
    total: number;
    percent: number;
}

export interface OverallState {
    transferredBytes: number;
    totalBytes: number;
    percent: number;
    speedBps: number;
    filesDone: number;
    totalFiles: number;
}

export interface DeletionHold {
    pairId: string;
    totalTracked: number;
    deletions: number;
    pct: number;
    thresholdPct: number;
    driveTrash: string[];
    localRecycle: string[];
}

export interface StorageInfo {
    usedBytes: number;
    maxBytes: number;
    driveBytes: number;
    email: string;
    displayName: string;
}

export interface LocalVolume {
    path: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
}

export interface DirFolder {
    name: string;
    path: string;
}

export interface DirListing {
    path: string;
    root: string;
    parent: string | null;
    folders: DirFolder[];
}

export interface TrashItem {
    ts: number;
    relPath: string;
    size: number;
    mtimeMs: number;
}

export interface DriveTrashItem {
    uid: string;
    name: string;
    kind: 'file' | 'folder';
    size: number | null;
    trashedAt: number | null;
}

export interface DuplicateFile {
    relPath: string;
    size: number;
    mtimeMs: number;
}

export interface DuplicateGroup {
    sha1: string;
    size: number;
    files: DuplicateFile[];
}

export interface IgnoredGroup {
    sha1: string | null;
    size: number | null;
    files: string[];
}

/** A pending sync conflict: the local version (relPath) vs the preserved Drive
 *  version (conflictPath, a `.conflict-<ts>` copy). */
export interface Conflict {
    pairId: string;
    relPath: string;
    conflictPath: string;
    driveUid: string | null;
    localSha1: string | null;
    localSize: number | null;
    localMtime: number | null;
    conflictSha1: string | null;
    conflictSize: number | null;
    conflictMtime: number | null;
    createdAt: number;
}

export type ErrorSeverity = 'error' | 'conflict' | 'warning';

export interface ErrorLogEntry {
    ts: number;
    severity: ErrorSeverity;
    message: string;
}

export interface ErrorLogStatus {
    total: number;
    unseen: number;
    unseenErrors: number;
    unseenConflicts: number;
    unseenWarnings: number;
}

