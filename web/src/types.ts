export interface Pair {
    id: string;
    localDir: string;
    driveFolderName: string;
    driveFolderUid: string;
    realTime: boolean;
    autoSync: boolean;
    intervalSeconds: number;
    lastSyncAt: number | null;
}

export interface SyncSummary {
    uploaded: number;
    downloaded: number;
    localRecycled: number;
    driveTrashed: number;
    conflicts: number;
    skipped: number;
}

export type TransferDirection = 'upload' | 'download';

export type SyncAction =
    | 'upload'
    | 'download'
    | 'skip'
    | 'trash-drive'
    | 'recycle-local'
    | 'conflict'
    | 'mkdir-drive'
    | 'mkdir-local';

export type SyncProgressEvent =
    | { type: 'sync-start'; pairId: string; localDir: string; driveFolderName: string }
    | { type: 'transfer'; relPath: string; direction: TransferDirection; bytes: number; total: number; percent: number; speedBps: number }
    | { type: 'item'; action: SyncAction; relPath: string }
    | { type: 'sync-complete'; summary: SyncSummary }
    | { type: 'sync-error'; message: string };

export interface TransferState {
    relPath: string;
    direction: TransferDirection;
    bytes: number;
    total: number;
    percent: number;
    speedBps: number;
}

export interface StorageInfo {
    usedBytes: number;
    maxBytes: number;
    driveBytes: number;
    email: string;
    displayName: string;
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
