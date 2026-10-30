import { useEffect, useState } from 'react';
import { getLogs } from '../api';

interface Props {
    onClose: () => void;
}

/**
 * Searchable, downloadable view of the server's on-disk sync log (the
 * in-browser "Activity log" is capped at 200 items; this shows the file at
 * /config/sync.log, which is rotated when it grows large).
 */
export function LogsModal({ onClose }: Props) {
    const [q, setQ] = useState('');
    const [lines, setLines] = useState<string[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(() => {
            getLogs(q, 2000, 0)
                .then((r) => {
                    if (!cancelled) {
                        setLines(r.lines);
                        setTotal(r.total);
                        setError(null);
                    }
                })
                .catch((e: Error) => {
                    if (!cancelled) setError(e.message);
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        }, 200);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [q]);

    async function download() {
        setDownloading(true);
        try {
            const res = await fetch('/api/logs/download');
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'sync.log';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setDownloading(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Sync log</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <div className="logs-toolbar">
                    <input
                        className="logs-search"
                        autoFocus
                        value={q}
                        placeholder="Search the log…"
                        onChange={(e) => setQ(e.target.value)}
                        spellCheck={false}
                    />
                    <button className="btn btn-ghost btn-sm" onClick={() => void download()} disabled={downloading}>
                        {downloading ? 'Downloading…' : 'Download'}
                    </button>
                </div>
                {error && <div className="alert">{error}</div>}
                <div className="logs-meta">
                    {total} line{total === 1 ? '' : 's'}
                    {q ? ` matching "${q}"` : ''}
                    {loading ? ' · loading…' : ''}
                </div>
                <pre className="logs-body">{lines.length === 0 ? (loading ? 'Loading…' : 'No log entries yet.') : lines.join('\n')}</pre>
            </div>
        </div>
    );
}
