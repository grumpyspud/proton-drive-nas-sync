import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../crypto/keySource';
import type { SyncProgressEvent } from '../engine/progress';

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

// Keep the error log small; it only receives errors/conflicts/warnings, so a
// generous cap is fine. Trim the oldest half if it somehow exceeds this.
const MAX_BYTES = 10 * 1024 * 1024;

export function errorLogPath(): string {
    return process.env.PDN_ERROR_LOG_FILE ?? path.join(configDir(), 'error.log');
}

function resetPath(): string {
    return path.join(configDir(), 'errorlog.reset');
}

/** Timestamp of the last "Reset" — entries newer than this are considered unseen. */
export function lastResetAt(): number {
    try {
        const p = resetPath();
        if (!existsSync(p)) return 0;
        const n = Number(readFileSync(p, 'utf8').trim());
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

export function setLastReset(ts: number): void {
    try {
        writeFileSync(resetPath(), String(ts));
    } catch {
        /* best-effort */
    }
}

function classify(event: SyncProgressEvent): { severity: ErrorSeverity; message: string } | null {
    switch (event.type) {
        case 'sync-error':
            return { severity: 'error', message: `Sync failed: ${event.message}` };
        case 'deletion-hold':
            return {
                severity: 'warning',
                message: `Deletion required confirmation: ${event.deletions} of ${event.totalTracked} tracked files (${event.pct.toFixed(1)}%) would be removed`,
            };
        case 'item':
            if (event.action === 'skip-error') {
                return {
                    severity: 'error',
                    message: event.message ? `Failed to sync ${event.relPath}: ${event.message}` : `Failed to sync ${event.relPath}`,
                };
            }
            if (event.action === 'conflict') {
                return { severity: 'conflict', message: `Conflict: kept local version of ${event.relPath} (Drive copy preserved)` };
            }
            return null;
        default:
            return null;
    }
}

/** Append an error/conflict/warning to the dedicated error log (best-effort). */
export function appendErrorLog(event: SyncProgressEvent): void {
    const entry = classify(event);
    if (!entry) return;
    try {
        const p = errorLogPath();
        if (existsSync(p) && statSync(p).size > MAX_BYTES) {
            const content = readFileSync(p, 'utf8');
            const half = Math.floor(content.length / 2);
            const idx = content.indexOf('\n', half);
            writeFileSync(p, idx >= 0 ? content.slice(idx + 1) : '');
        }
        const line = JSON.stringify({ ts: Date.now(), severity: entry.severity, message: entry.message });
        appendFileSync(p, `${line}\n`);
    } catch {
        /* never let logging break a sync */
    }
}

function readEntries(): ErrorLogEntry[] {
    try {
        const p = errorLogPath();
        if (!existsSync(p)) return [];
        const out: ErrorLogEntry[] = [];
        for (const line of readFileSync(p, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const o = JSON.parse(line) as { ts?: unknown; severity?: unknown; message?: unknown };
                out.push({
                    ts: typeof o.ts === 'number' ? o.ts : 0,
                    severity: o.severity === 'error' || o.severity === 'conflict' || o.severity === 'warning' ? o.severity : 'warning',
                    message: typeof o.message === 'string' ? o.message : '',
                });
            } catch {
                /* skip malformed lines */
            }
        }
        return out;
    } catch {
        return [];
    }
}

export function readErrorLog(): ErrorLogEntry[] {
    return readEntries();
}

export function errorLogStatus(): ErrorLogStatus {
    const entries = readEntries();
    const reset = lastResetAt();
    let unseen = 0;
    let unseenErrors = 0;
    let unseenConflicts = 0;
    let unseenWarnings = 0;
    for (const e of entries) {
        if (e.ts > reset) {
            unseen++;
            if (e.severity === 'error') unseenErrors++;
            else if (e.severity === 'conflict') unseenConflicts++;
            else unseenWarnings++;
        }
    }
    return { total: entries.length, unseen, unseenErrors, unseenConflicts, unseenWarnings };
}

export function clearErrorLog(): void {
    try {
        writeFileSync(errorLogPath(), '');
    } catch {
        /* best-effort */
    }
}
