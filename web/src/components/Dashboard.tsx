import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { addPair, clearTrash, deleteTrashItem, getStorage, getSyncStatus, listPairs, listTrash, logout, removePair, restoreTrashItem, setSyncPaused, startSync, stopSync, updatePair, type PairSettings } from '../api';
import type { Pair, StorageInfo, SyncProgressEvent, SyncSummary, TransferState, TrashItem } from '../types';
import { formatBytes } from '../format';
import { ProgressBar } from './ProgressBar';
import { FolderBrowser } from './FolderBrowser';
import { LogsModal } from './LogsModal';

const MAX_LOG = 200;

const AUTO_SYNC_INTERVALS: Array<{ label: string; value: number }> = [
    { label: '15 min', value: 900 },
    { label: '30 min', value: 1800 },
    { label: '1 hour', value: 3600 },
    { label: '6 hours', value: 21600 },
    { label: '12 hours', value: 43200 },
    { label: '24 hours', value: 86400 },
];

function intervalLabel(seconds: number): string {
    const match = AUTO_SYNC_INTERVALS.find((i) => i.value === seconds);
    return match ? match.label : seconds > 0 ? `every ${Math.round(seconds / 60)} min` : '—';
}

interface Props {
    uid?: string;
    theme: 'dark' | 'light';
    onToggleTheme: () => void;
    onLogout: () => void;
}

export function Dashboard({ uid, theme, onToggleTheme, onLogout }: Props) {
    const [pairs, setPairs] = useState<Pair[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [active, setActive] = useState<Map<string, TransferState>>(new Map());
    const [items, setItems] = useState<Array<{ action: string; relPath: string }>>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [summary, setSummary] = useState<SyncSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [storage, setStorage] = useState<StorageInfo | null>(null);
    const [trashPair, setTrashPair] = useState<Pair | null>(null);
    const [paused, setPaused] = useState(false);
    const [showLogs, setShowLogs] = useState(false);

    const reload = useCallback(async () => {
        try {
            setPairs((await listPairs()).pairs);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    const loadStorage = useCallback(async () => {
        try {
            setStorage(await getStorage());
        } catch {
            /* storage is non-critical; leave it unset on failure */
        }
    }, []);

    const loadSyncStatus = useCallback(async () => {
        try {
            setPaused((await getSyncStatus()).paused);
        } catch {
            /* non-critical */
        }
    }, []);

    useEffect(() => {
        void reload();
        void loadStorage();
        void loadSyncStatus();
    }, [reload, loadStorage, loadSyncStatus]);

    useEffect(() => {
        const es = new EventSource('/api/events');
        es.onmessage = (e) => {
            let ev: SyncProgressEvent;
            try {
                ev = JSON.parse(e.data) as SyncProgressEvent;
            } catch {
                return;
            }
            switch (ev.type) {
                case 'sync-start':
                    setSyncing(true);
                    setError(null);
                    setSummary(null);
                    setItems([]);
                    setTotalItems(0);
                    setActive(new Map());
                    break;
                case 'transfer':
                    setActive((prev) => {
                        const next = new Map(prev);
                        next.set(ev.relPath, {
                            relPath: ev.relPath,
                            direction: ev.direction,
                            bytes: ev.bytes,
                            total: ev.total,
                            percent: ev.percent,
                            speedBps: ev.speedBps,
                        });
                        return next;
                    });
                    break;
                case 'item':
                    setTotalItems((t) => t + 1);
                    setItems((prev) => {
                        const next = [...prev, { action: ev.action, relPath: ev.relPath }];
                        return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
                    });
                    // A completed transfer should leave the progress area; it is
                    // now just a log line. Only files still transferring keep a bar.
                    setActive((prev) => {
                        if (!prev.has(ev.relPath)) return prev;
                        const next = new Map(prev);
                        next.delete(ev.relPath);
                        return next;
                    });
                    break;
                case 'sync-complete':
                    setSyncing(false);
                    setSummary(ev.summary);
                    setActive(new Map());
                    void loadStorage();
                    break;
                case 'sync-error':
                    setSyncing(false);
                    setError(ev.message);
                    setActive(new Map());
                    break;
                case 'sync-paused':
                    setPaused(true);
                    setSyncing(false);
                    setActive(new Map());
                    break;
                case 'sync-resumed':
                    setPaused(false);
                    break;
                case 'sync-stopped':
                    setSyncing(false);
                    setActive(new Map());
                    break;
            }
        };
        return () => es.close();
    }, [loadStorage]);

    async function onAdd(localDir: string, driveFolderName: string, settings: PairSettings) {
        setError(null);
        try {
            await addPair(localDir, driveFolderName, settings);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onRemove(id: string) {
        await removePair(id);
        await reload();
    }

    async function onSync(id: string) {
        setError(null);
        try {
            await startSync(id);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function togglePause() {
        setError(null);
        try {
            const res = await setSyncPaused(!paused);
            setPaused(res.paused);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onStop() {
        setError(null);
        try {
            await stopSync();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onUpdatePair(id: string, settings: PairSettings) {
        setError(null);
        try {
            await updatePair(id, settings);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onLogoutClick() {
        await logout();
        onLogout();
    }

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <div className="brand-mark">⇄</div>
                    <div>
                        <h1>Proton Drive NAS Sync</h1>
                        <p className="subtitle">Signed in as {storage?.displayName || storage?.email || uid || '…'}</p>
                    </div>
                </div>
                <div className="topbar-actions">
                    <button className={`btn ${paused ? 'btn-primary' : 'btn-ghost'}`} onClick={togglePause} title={paused ? 'Resume all syncing' : 'Pause all syncing'}>
                        {paused ? '▶ Resume' : '⏸ Pause'}
                    </button>
                    {syncing && (
                        <button className="btn btn-danger" onClick={onStop} title="Stop the current sync">
                            ⏹ Stop
                        </button>
                    )}
                    <button className="btn btn-ghost" onClick={() => setShowLogs(true)}>
                        Logs
                    </button>
                    <button className="btn btn-ghost" onClick={onToggleTheme} title="Toggle light/dark mode">
                        {theme === 'dark' ? '☀ Light' : '🌙 Dark'}
                    </button>
                    <button className="btn btn-ghost" onClick={onLogoutClick}>
                        Sign out
                    </button>
                </div>
            </header>

            <main className="layout">
                <section className="col col-main">
                    <div className="card">
                        <div className="card-head">
                            <h2>Sync activity</h2>
                            {syncing ? (
                                <span className="badge badge-live">
                                    <span className="pulse" /> Syncing…
                                </span>
                            ) : paused ? (
                                <span className="badge badge-paused">⏸ Paused</span>
                            ) : (
                                <span className="badge">Idle</span>
                            )}
                        </div>

                        {error && <div className="alert">{error}</div>}

                        {[...active.values()].map((t) => (
                            <ProgressBar key={t.relPath} {...t} />
                        ))}
                        {syncing && active.size === 0 && <div className="muted">Scanning for changes…</div>}

                        {summary && !syncing && (
                            <div className="summary">
                                <h3>Last sync</h3>
                                <div className="summary-grid">
                                    <Stat label="Uploaded" value={summary.uploaded} />
                                    <Stat label="Downloaded" value={summary.downloaded} />
                                    <Stat label="Skipped" value={summary.skipped} />
                                    <Stat label="Conflicts" value={summary.conflicts} />
                                    <Stat label="Trashed (Drive)" value={summary.driveTrashed} />
                                    <Stat label="Recycled (local)" value={summary.localRecycled} />
                                </div>
                            </div>
                        )}

                        {items.length > 0 && (
                            <details className="activity-log">
                                <summary>
                                    {totalItems > items.length
                                        ? `Activity log (last ${items.length} of ${totalItems})`
                                        : `Activity log (${items.length})`}
                                </summary>
                                <ul>
                                    {items
                                        .slice(-60)
                                        .reverse()
                                        .map((it, i) => (
                                            <li key={i}>
                                                <span className={`tag tag-${it.action}`}>{it.action}</span>
                                                <span className="log-path">{it.relPath}</span>
                                            </li>
                                        ))}
                                </ul>
                            </details>
                        )}
                    </div>
                </section>

                <section className="col col-side">
                    {storage && <StorageCard storage={storage} />}
                    <div className="card">
                        <h2>Folder pairs</h2>
                        <AddPairForm onAdd={onAdd} />
                        <ul className="pair-list">
                            {pairs.map((p) => (
                                <li key={p.id} className="pair">
                                    <div className="pair-main">
                                        <div className="pair-info">
                                            <div className="pair-name">
                                                {p.driveFolderName || 'My Files (root)'}
                                                {p.realTime && (
                                                    <span className="badge badge-live">
                                                        <span className="pulse" /> live
                                                    </span>
                                                )}
                                                {p.autoSync && p.intervalSeconds > 0 && (
                                                    <span className="badge">⏱ {intervalLabel(p.intervalSeconds)}</span>
                                                )}
                                            </div>
                                            <div className="pair-dir">{p.localDir}</div>
                                        </div>
                                        <div className="pair-actions">
                                            <button className="btn btn-primary btn-sm" onClick={() => onSync(p.id)} disabled={syncing || paused}>
                                                Sync
                                            </button>
                                            <button className="btn btn-ghost btn-sm" onClick={() => setTrashPair(p)}>
                                                Trash
                                            </button>
                                            <button className="btn btn-ghost btn-sm" onClick={() => onRemove(p.id)}>
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                    <div className="pair-settings">
                                        <Toggle label="Real-time" checked={p.realTime} onChange={(v) => onUpdatePair(p.id, { realTime: v })} />
                                        <Toggle
                                            label="Auto-sync"
                                            checked={p.autoSync}
                                            onChange={(v) => onUpdatePair(p.id, { autoSync: v, intervalSeconds: v ? p.intervalSeconds || 3600 : p.intervalSeconds })}
                                        />
                                        {p.autoSync && (
                                            <select className="select" value={p.intervalSeconds} onChange={(e) => onUpdatePair(p.id, { intervalSeconds: Number(e.target.value) })}>
                                                {AUTO_SYNC_INTERVALS.map((i) => (
                                                    <option key={i.value} value={i.value}>
                                                        {i.label}
                                                    </option>
                                                ))}
                                            </select>
                                        )}
                                    </div>
                                </li>
                            ))}
                            {pairs.length === 0 && <li className="muted">No pairs yet. Add one to start syncing.</li>}
                        </ul>
                    </div>
                </section>
            </main>

            <footer className="footer">Third-party application — not affiliated with, endorsed by, or supported by Proton AG.</footer>

            {trashPair && <TrashModal pair={trashPair} onClose={() => setTrashPair(null)} />}
            {showLogs && <LogsModal onClose={() => setShowLogs(false)} />}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className="stat">
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
        </div>
    );
}

function StorageCard({ storage }: { storage: StorageInfo }) {
    const max = storage.maxBytes;
    const pct = max > 0 ? Math.min(100, (storage.driveBytes / max) * 100) : 0;
    const showTotal = storage.usedBytes > 0 && storage.usedBytes !== storage.driveBytes;
    return (
        <div className="card">
            <h2>Storage</h2>
            <div className="storage-head">
                <span className="storage-nums">
                    {formatBytes(storage.driveBytes)} <span className="muted">of</span> {formatBytes(storage.maxBytes)}
                </span>
                <span className="pct">{pct.toFixed(1)}%</span>
            </div>
            <div className="progress-track">
                <div className="progress-fill fill-upload" style={{ width: `${pct}%` }} />
            </div>
            <div className="storage-sub">
                {storage.displayName || storage.email}
                {showTotal && <> · {formatBytes(storage.usedBytes)} used across all products</>}
            </div>
        </div>
    );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <label className="toggle">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span className="toggle-track">
                <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">{label}</span>
        </label>
    );
}

function TrashModal({ pair, onClose }: { pair: Pair; onClose: () => void }) {
    const [items, setItems] = useState<TrashItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setItems((await listTrash(pair.id)).items);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, [pair.id]);

    useEffect(() => {
        void reload();
    }, [reload]);

    async function restore(it: TrashItem) {
        setError(null);
        try {
            await restoreTrashItem(pair.id, it.ts, it.relPath);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function remove(it: TrashItem) {
        setError(null);
        try {
            await deleteTrashItem(pair.id, it.ts, it.relPath);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function clearAll() {
        if (!window.confirm('Permanently delete all recycled files for this pair?')) return;
        setError(null);
        try {
            await clearTrash(pair.id);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Trash — {pair.driveFolderName || 'My Files (root)'}</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <p className="muted">Recycled files from {pair.localDir}</p>
                {error && <div className="alert">{error}</div>}
                {loading ? (
                    <div className="muted">Loading…</div>
                ) : items.length === 0 ? (
                    <div className="muted">Trash is empty.</div>
                ) : (
                    <>
                        <ul className="trash-list">
                            {items.map((it) => (
                                <li key={`${it.ts}/${it.relPath}`} className="trash-item">
                                    <div className="trash-info">
                                        <div className="trash-name">{it.relPath}</div>
                                        <div className="trash-meta">
                                            {formatBytes(it.size)} · recycled {new Date(it.ts).toLocaleString()}
                                        </div>
                                    </div>
                                    <div className="trash-actions">
                                        <button className="btn btn-primary btn-sm" onClick={() => restore(it)}>
                                            Restore
                                        </button>
                                        <button className="btn btn-ghost btn-sm" onClick={() => remove(it)}>
                                            Delete
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                        <button className="btn btn-ghost btn-sm" onClick={clearAll}>
                            Clear all
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function AddPairForm({ onAdd }: { onAdd: (localDir: string, driveFolderName: string, settings: PairSettings) => Promise<void> }) {
    const [localDir, setLocalDir] = useState('');
    const [folder, setFolder] = useState('');
    const [realTime, setRealTime] = useState(false);
    const [autoSync, setAutoSync] = useState(false);
    const [intervalSeconds, setIntervalSeconds] = useState(3600);
    const [busy, setBusy] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!localDir) return;
        setBusy(true);
        try {
            await onAdd(localDir, folder, { realTime, autoSync, intervalSeconds: autoSync ? intervalSeconds : 0 });
            setLocalDir('');
            setFolder('');
            setRealTime(false);
            setAutoSync(false);
            setIntervalSeconds(3600);
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="add-form" onSubmit={submit}>
            <div className="field">
                <span>Local folder (NAS)</span>
                <FolderBrowser mode="local" value={localDir} onChange={setLocalDir} placeholder="/data" />
            </div>
            <div className="field">
                <span>Proton Drive folder</span>
                <FolderBrowser mode="drive" value={folder} onChange={setFolder} placeholder="My Files" />
            </div>
            <div className="field">
                <span>Sync schedule</span>
                <div className="toggle-row">
                    <Toggle label="Real-time (10s)" checked={realTime} onChange={setRealTime} />
                    <Toggle label="Auto-sync" checked={autoSync} onChange={setAutoSync} />
                </div>
                {autoSync && (
                    <select className="select" value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
                        {AUTO_SYNC_INTERVALS.map((i) => (
                            <option key={i.value} value={i.value}>
                                {i.label}
                            </option>
                        ))}
                    </select>
                )}
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || !localDir}>
                Add pair
            </button>
        </form>
    );
}
