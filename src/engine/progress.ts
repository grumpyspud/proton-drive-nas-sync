/** Progress reporting types shared between the sync engine, the HTTP server,
 *  and the web UI. A sync emits a stream of these events; the UI renders
 *  per-transfer progress bars (% + speed) plus an overall item counter. */

export type TransferDirection = 'upload' | 'download';

export interface SyncSummary {
    uploaded: number;
    downloaded: number;
    localRecycled: number;
    driveTrashed: number;
    conflicts: number;
    skipped: number;
}

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
    | { type: 'sync-plan'; totalBytes: number; totalFiles: number }
    | {
          type: 'transfer';
          relPath: string;
          direction: TransferDirection;
          bytes: number;
          total: number;
          percent: number; // 0..100
          speedBps: number; // bytes/sec over a sliding window
      }
    | {
          type: 'overall';
          transferredBytes: number;
          totalBytes: number;
          percent: number; // 0..100
          speedBps: number;
          filesDone: number;
          totalFiles: number;
      }
    | { type: 'item'; action: SyncAction; relPath: string }
    | { type: 'sync-complete'; summary: SyncSummary }
    | { type: 'sync-error'; message: string }
    | { type: 'sync-paused' }
    | { type: 'sync-resumed' }
    | { type: 'sync-stopped' }
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

/** Sliding-window bytes/sec meter. Feed it cumulative byte counts. */
export class SpeedMeter {
    private samples: Array<{ t: number; bytes: number }> = [];

    constructor(private readonly windowMs = 2000) {}

    /** Record a cumulative byte count; returns instantaneous bytes/sec. */
    sample(cumulativeBytes: number): number {
        const t = Date.now();
        this.samples.push({ t, bytes: cumulativeBytes });
        const cutoff = t - this.windowMs;
        this.samples = this.samples.filter((s) => s.t >= cutoff);
        if (this.samples.length < 2) return 0;
        const first = this.samples[0]!;
        const dt = (t - first.t) / 1000;
        const db = cumulativeBytes - first.bytes;
        return dt > 0 ? db / dt : 0;
    }
}
