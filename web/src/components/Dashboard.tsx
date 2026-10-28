import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { addPair, listPairs, logout, removePair, startSync } from '../api';
import type { Pair, SyncProgressEvent, SyncSummary, TransferState } from '../types';
import { ProgressBar } from './ProgressBar';

interface Props {
    uid?: string;
    onLogout: () => void;
}

export function Dashboard({ uid, onLogout }: Props) {
    const [pairs, setPairs] = useState<Pair[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [active, setActive] = useState<Map<string, TransferState>>(new Map());
    const [items, setItems] = useState<Array<{ action: string; relPath: string }>>([]);
    const [summary, setSummary] = useState<SyncSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            setPairs((await listPairs()).pairs);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

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
                    setItems((prev) => [...prev, { action: ev.action, relPath: ev.relPath }]);
                    break;
                case 'sync-complete':
                    setSyncing(false);
                    setSummary(ev.summary);
                    setActive(new Map());
                    break;
                case 'sync-error':
                    setSyncing(false);
                    setError(ev.message);
                    setActive(new Map());
                    break;
            }
        };
        return () => es.close();
    }, []);

    async function onAdd(localDir: string, driveFolderName: string) {
        setError(null);
        try {
            await addPair(localDir, driveFolderName);
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
                        <p className="subtitle">Signed in as {uid ?? '…'}</p>
                    </div>
                </div>
                <button className="btn btn-ghost" onClick={onLogoutClick}>
                    Sign out
                </button>
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
                                <summary>Activity log ({items.length})</summary>
                                <ul>
                                    {items
                                        .slice(-60)
                                        .reverse()
                                        .map((it, i) => (
                                            <li key={i}>
                                                <span className={`tag tag-${it.action}`}>{it.action}</span> {it.relPath}
                                            </li>
                                        ))}
                                </ul>
                            </details>
                        )}
                    </div>
                </section>

                <section className="col col-side">
                    <div className="card">
                        <h2>Folder pairs</h2>
                        <AddPairForm onAdd={onAdd} />
                        <ul className="pair-list">
                            {pairs.map((p) => (
                                <li key={p.id} className="pair">
                                    <div className="pair-info">
                                        <div className="pair-name">{p.driveFolderName}</div>
                                        <div className="pair-dir">{p.localDir}</div>
                                    </div>
                                    <div className="pair-actions">
                                        <button className="btn btn-primary btn-sm" onClick={() => onSync(p.id)} disabled={syncing}>
                                            Sync
                                        </button>
                                        <button className="btn btn-ghost btn-sm" onClick={() => onRemove(p.id)}>
                                            Remove
                                        </button>
                                    </div>
                                </li>
                            ))}
                            {pairs.length === 0 && <li className="muted">No pairs yet. Add one to start syncing.</li>}
                        </ul>
                    </div>
                </section>
            </main>

            <footer className="footer">Third-party application — not affiliated with, endorsed by, or supported by Proton AG.</footer>
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

function AddPairForm({ onAdd }: { onAdd: (localDir: string, driveFolderName: string) => Promise<void> }) {
    const [localDir, setLocalDir] = useState('');
    const [folder, setFolder] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!localDir || !folder) return;
        setBusy(true);
        try {
            await onAdd(localDir, folder);
            setLocalDir('');
            setFolder('');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="add-form" onSubmit={submit}>
            <input placeholder="Local folder, e.g. /mnt/nas/photos" value={localDir} onChange={(e) => setLocalDir(e.target.value)} />
            <input placeholder="Drive folder name" value={folder} onChange={(e) => setFolder(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={busy || !localDir || !folder}>
                Add pair
            </button>
        </form>
    );
}
