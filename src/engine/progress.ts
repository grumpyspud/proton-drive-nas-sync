/** Progress reporting types shared between the sync engine, the HTTP server,
 *  and the web UI. A sync emits a stream of these events; the UI renders
 *  per-transfer progress bars (% + bytes) plus an overall progress bar. */

export type TransferDirection = 'upload' | 'download';

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
    | {
          type: 'transfer';
          relPath: string;
          direction: TransferDirection;
          bytes: number;
          total: number;
          percent: number; // 0..100
      }
    | {
          type: 'overall';
          transferredBytes: number;
          totalBytes: number;
          percent: number; // 0..100, files-processed basis
          speedBps: number; // bytes/sec from the container NIC counters
          filesDone: number;
          totalFiles: number;
      }
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
    | {
          type: 'deletion-hold';
          pairId: string;
          totalTracked: number;
          deletions: number;
          pct: number;
          thresholdPct: number;
          driveTrash: string[];
          localRecycle: string[];
      }
    | { type: 'deletion-confirmed' }
    | { type: 'deletion-cancelled' };

export type ProgressHandler = (event: SyncProgressEvent) => void;
