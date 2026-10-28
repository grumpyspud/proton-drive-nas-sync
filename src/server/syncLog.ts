import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../crypto/keySource';
import type { SyncProgressEvent } from '../engine/progress';

const MAX_BYTES = 20 * 1024 * 1024; // rotate (truncate oldest half) above 20 MiB

export function syncLogPath(): string {
    return process.env.PDN_LOG_FILE ?? path.join(configDir(), 'sync.log');
}

function lineFor(event: SyncProgressEvent): string | null {
    switch (event.type) {
        case 'sync-start':
            return `[sync-start] ${event.driveFolderName || '(root)'} local=${event.localDir}`;
        case 'item':
            return `[${event.action}] ${event.relPath}`;
        case 'sync-complete':
            return `[sync-complete] uploaded=${event.summary.uploaded} downloaded=${event.summary.downloaded} skipped=${event.summary.skipped} conflicts=${event.summary.conflicts} driveTrashed=${event.summary.driveTrashed} localRecycled=${event.summary.localRecycled}`;
        case 'sync-error':
            return `[sync-error] ${event.message}`;
        case 'sync-paused':
            return '[sync-paused]';
        case 'sync-resumed':
            return '[sync-resumed]';
        case 'sync-stopped':
            return '[sync-stopped]';
        case 'transfer':
            return null; // per-transfer progress is too noisy for the log
        default:
            return null;
    }
}

/** Append a human-readable sync event to the persistent log (best-effort). */
export function appendSyncLog(event: SyncProgressEvent): void {
    const line = lineFor(event);
    if (line == null) return;
    try {
        const p = syncLogPath();
        if (existsSync(p) && statSync(p).size > MAX_BYTES) {
            const content = readFileSync(p, 'utf8');
            const half = Math.floor(content.length / 2);
            const idx = content.indexOf('\n', half);
            writeFileSync(p, idx >= 0 ? content.slice(idx + 1) : '');
        }
        appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
    } catch {
        /* best-effort; never let logging break a sync */
    }
}

export interface LogQuery {
    q?: string;
    limit?: number;
    offset?: number;
}

export function querySyncLog(query: LogQuery): { lines: string[]; total: number; truncated: boolean } {
    try {
        const p = syncLogPath();
        if (!existsSync(p)) return { lines: [], total: 0, truncated: false };
        const all = readFileSync(p, 'utf8').split('\n').filter(Boolean);
        const q = (query.q ?? '').trim().toLowerCase();
        const filtered = q ? all.filter((l) => l.toLowerCase().includes(q)) : all;
        const total = filtered.length;
        const offset = Math.max(0, query.offset ?? 0);
        const limit = Math.max(1, query.limit ?? 500);
        const lines = filtered.slice(offset, offset + limit);
        return { lines, total, truncated: offset + limit < total };
    } catch {
        return { lines: [], total: 0, truncated: false };
    }
}
