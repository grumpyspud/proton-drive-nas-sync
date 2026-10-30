import { useCallback, useEffect, useState } from 'react';
import { clearErrorLog, getErrorLog, resetErrorLog } from '../api';
import type { ErrorLogEntry } from '../types';

interface Props {
    onClose: () => void;
}

/**
 * Dedicated, persistent error log (errors / conflicts / warnings only). The
 * main sync log is rotated out at 20 MiB, so early problems on a large sync
 * would otherwise be lost. This modal shows that surviving subset, colour-coded
 * by severity, with Reset (mark seen) / Clear (delete) / Save (download .txt).
 */
export function ErrorLogModal({ onClose }: Props) {
    const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        getErrorLog()
            .then((r) => {
                setEntries(r.entries);
                setError(null);
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    async function doReset() {
        setBusy(true);
        try {
            await resetErrorLog();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function doClear() {
        setBusy(true);
        try {
            await clearErrorLog();
            setEntries([]);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function doSave() {
        try {
            const res = await fetch('/api/errorlog/download');
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'error-log.txt';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError((e as Error).message);
        }
    }

    const reversed = entries.slice().reverse();

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Error log</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <div className="errorlog-toolbar">
                    <button className="btn btn-ghost btn-sm" onClick={() => void doReset()} disabled={busy} title="Mark all current entries as seen (clears the Logs button colour)">
                        Reset
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void doClear()} disabled={busy} title="Delete every error log entry">
                        Clear
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void doSave()} disabled={entries.length === 0} title="Download the full log as a .txt file">
                        Save
                    </button>
                </div>
                {error && <div className="alert">{error}</div>}
                <div className="logs-meta">
                    {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
                    {loading ? ' · loading…' : ''}
                </div>
                <div className="errorlog-body">
                    {reversed.length === 0 ? (
                        <div className="muted">{loading ? 'Loading…' : 'No errors, conflicts or warnings recorded.'}</div>
                    ) : (
                        <ul>
                            {reversed.map((e, i) => (
                                <li key={i} className={`errorlog-${e.severity}`}>
                                    <span className="errorlog-ts">{new Date(e.ts).toLocaleString()}</span>
                                    <span className={`tag tag-errorlog-${e.severity}`}>{e.severity}</span>
                                    <span className="errorlog-msg">{e.message}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
