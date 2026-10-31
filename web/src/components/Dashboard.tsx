import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { cancelDeletion, clearTrash, confirmDeletion, deleteTrashItem, getConflicts, getErrorLogStatus, getLocalStorage, getSettings, getStorage, getSyncStatus, hashMissing, listPairs, listTrash, removePair, restoreTrashItem, setSyncPaused, startSync, stopSync, updatePair, updateSettings, type PairSettings } from '../api';
import type { DeletionHold, ErrorLogStatus, LocalVolume, OverallState, Pair, StorageInfo, SyncProgressEvent, SyncSummary, TransferState, TrashItem } from '../types';
import { formatBytes, formatSpeed } from '../format';
import { ProgressBar } from './ProgressBar';
import { LogsModal } from './LogsModal';
import { ErrorLogModal } from './ErrorLogModal';
import { BackupModal } from './BackupModal';
import { DuplicatesModal } from './DuplicatesModal';
import { ConflictsModal } from './ConflictsModal';
import { CreatePairModal } from './CreatePairModal';
import { ActivityLogModal } from './ActivityLogModal';
import { SignOutModal } from './SignOutModal';
import { SYNC_FREQUENCIES, frequencyLabel, pairInterval } from '../schedule';

const MAX_LOG = 200;

interface Props {
    uid?: string;
    theme: 'dark' | 'light';
    onToggleTheme: () => void;
    onLogout: () => void;
    appAuthEnabled: boolean;
    onSetAppPassword: () => void;
    onLock: () => void;
}

export function Dashboard({ uid, theme, onToggleTheme, onLogout, appAuthEnabled, onSetAppPassword, onLock }: Props) {
    const [pairs, setPairs] = useState<Pair[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [active, setActive] = useState<Map<string, TransferState>>(new Map());
    const [items, setItems] = useState<Array<{ action: string; relPath: string }>>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [summary, setSummary] = useState<SyncSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [storage, setStorage] = useState<StorageInfo | null>(null);
    const [localVolumes, setLocalVolumes] = useState<LocalVolume[]>([]);
    const [trashPair, setTrashPair] = useState<Pair | null>(null);
    const [paused, setPaused] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [overall, setOverall] = useState<OverallState | null>(null);
    const [scanState, setScanState] = useState<{ side: 'local' | 'drive'; files: number; folders: number } | null>(null);
    const [deletionHold, setDeletionHold] = useState<DeletionHold | null>(null);
    const [showBackup, setShowBackup] = useState(false);
    const [dedupePair, setDedupePair] = useState<Pair | null>(null);
    const [conflictsPair, setConflictsPair] = useState<Pair | null>(null);
    const [conflictCounts, setConflictCounts] = useState<Record<string, number>>({});
    const [hashingPair, setHashingPair] = useState<{ pairId: string; done: number; total: number } | null>(null);
    const hashingRef = useRef(false);
    const pendingDedupePair = useRef<Pair | null>(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [transferConcurrency, setTransferConcurrency] = useState(3);
    const [showCreatePair, setShowCreatePair] = useState(false);
    const [showActivityLog, setShowActivityLog] = useState(false);
    const [showErrorLog, setShowErrorLog] = useState(false);
    const [showSignOut, setShowSignOut] = useState(false);
    const [errorLogStatus, setErrorLogStatus] = useState<ErrorLogStatus | null>(null);
    const [openMenu, setOpenMenu] = useState<'logs' | 'settings' | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const reload = useCallback(async () => {
        try {
            setPairs((await listPairs()).pairs);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    const openDedupe = useCallback(async (p: Pair) => {
        setError(null);
        pendingDedupePair.current = p;
        hashingRef.current = true;
        setHashingPair({ pairId: p.id, done: 0, total: 0 });
        try {
            await hashMissing(p.id);
        } catch (err) {
            pendingDedupePair.current = null;
            hashingRef.current = false;
            setHashingPair(null);
            setError((err as Error).message);
        }
    }, []);

    const loadConflicts = useCallback(async () => {
        try {
            const { pairs } = await listPairs();
            const counts: Record<string, number> = {};
            await Promise.all(
                pairs.map(async (p) => {
                    try {
                        counts[p.id] = (await getConflicts(p.id)).conflicts.length;
                    } catch {
                        counts[p.id] = 0;
                    }
                }),
            );
            setConflictCounts(counts);
        } catch {
            // non-fatal — conflict counts are best-effort
        }
    }, []);

    const loadStorage = useCallback(async () => {
        try {
            setStorage(await getStorage());
        } catch {
            /* storage is non-critical; leave it unset on failure */
        }
    }, []);

    const loadLocalStorage = useCallback(async () => {
        try {
            setLocalVolumes((await getLocalStorage()).volumes);
        } catch {
            /* non-critical */
        }
    }, []);

    const loadSyncStatus = useCallback(async () => {
        try {
            setPaused((await getSyncStatus()).paused);
        } catch {
            /* non-critical */
        }
    }, []);

    const loadSettings = useCallback(async () => {
        try {
            setTransferConcurrency((await getSettings()).transferConcurrency);
        } catch {
            /* non-critical */
        }
    }, []);

    const loadErrorStatus = useCallback(async () => {
        try {
            setErrorLogStatus(await getErrorLogStatus());
        } catch {
            /* non-critical */
        }
    }, []);

    useEffect(() => {
        void loadErrorStatus();
        const t = setInterval(() => void loadErrorStatus(), 15000);
        return () => clearInterval(t);
    }, [loadErrorStatus]);

    const hasUnseenErrors = (errorLogStatus?.unseenErrors ?? 0) > 0;
    const hasUnseenWarnings = ((errorLogStatus?.unseenConflicts ?? 0) + (errorLogStatus?.unseenWarnings ?? 0)) > 0;
    const logsButtonClass = hasUnseenErrors ? 'btn btn-ghost btn-logs-red' : hasUnseenWarnings ? 'btn btn-ghost btn-logs-yellow' : 'btn btn-ghost';

    useEffect(() => {
        void reload();
        void loadStorage();
        void loadLocalStorage();
        void loadSyncStatus();
        void loadSettings();
        void loadConflicts();
    }, [reload, loadStorage, loadLocalStorage, loadSyncStatus, loadSettings, loadConflicts]);

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
                    setOverall(null);
                    setDeletionHold(null);
                    setScanState(null);
                    break;
                case 'walk':
                    setScanState({ side: ev.side, files: ev.files, folders: ev.folders });
                    break;
                case 'sync-plan':
                    setOverall({ transferredBytes: 0, totalBytes: ev.totalBytes, percent: 0, speedBps: 0, filesDone: 0, totalFiles: ev.totalFiles });
                    break;
                case 'hash-progress':
                    if (hashingRef.current) setHashingPair({ pairId: ev.pairId, done: ev.done, total: ev.total });
                    break;
                case 'hash-complete':
                    if (hashingRef.current && ev.pairId === pendingDedupePair.current?.id) {
                        hashingRef.current = false;
                        setHashingPair(null);
                        const p = pendingDedupePair.current;
                        pendingDedupePair.current = null;
                        if (p) setDedupePair(p);
                    }
                    break;
                case 'hash-cancelled':
                    if (hashingRef.current && ev.pairId === pendingDedupePair.current?.id) {
                        hashingRef.current = false;
                        setHashingPair(null);
                        pendingDedupePair.current = null;
                        setError('Hashing was interrupted by a sync starting for this pair. Click Dedupe Scan again after it finishes.');
                    }
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
                        });
                        return next;
                    });
                    break;
                case 'overall':
                    setOverall({
                        transferredBytes: ev.transferredBytes,
                        totalBytes: ev.totalBytes,
                        percent: ev.percent,
                        speedBps: ev.speedBps,
                        filesDone: ev.filesDone,
                        totalFiles: ev.totalFiles,
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
                case 'log':
                    setTotalItems((t) => t + 1);
                    setItems((prev) => {
                        const next = [...prev, { action: 'info', relPath: ev.message }];
                        return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
                    });
                    break;
                case 'sync-complete':
                    setSyncing(false);
                    setSummary(ev.summary);
                    setActive(new Map());
                    setOverall(null);
                    void loadStorage();
                    void loadLocalStorage();
                    void loadErrorStatus();
                    void loadConflicts();
                    break;
                case 'sync-error':
                    setSyncing(false);
                    setError(ev.message);
                    setActive(new Map());
                    setOverall(null);
                    void loadErrorStatus();
                    break;
                case 'sync-paused':
                    setPaused(true);
                    setSyncing(false);
                    setActive(new Map());
                    setOverall(null);
                    break;
                case 'sync-resumed':
                    setPaused(false);
                    break;
                case 'sync-stopped':
                    setSyncing(false);
                    setActive(new Map());
                    setOverall(null);
                    break;
                case 'deletion-hold':
                    setSyncing(false);
                    setActive(new Map());
                    setOverall(null);
                    setDeletionHold({
                        pairId: ev.pairId,
                        totalTracked: ev.totalTracked,
                        deletions: ev.deletions,
                        pct: ev.pct,
                        thresholdPct: ev.thresholdPct,
                        driveTrash: ev.driveTrash,
                        localRecycle: ev.localRecycle,
                    });
                    break;
                case 'deletion-confirmed':
                case 'deletion-cancelled':
                    setDeletionHold(null);
                    break;
            }
        };
        es.onopen = () => {
            setReconnecting(false);
            // The stream may have dropped mid-sync; refresh local state so the
            // UI doesn't sit on a stale "syncing" forever.
            void reload();
            void loadStorage();
            void loadSyncStatus();
        };
        es.onerror = () => setReconnecting(true);
        return () => es.close();
    }, [reload, loadStorage, loadLocalStorage, loadSyncStatus]);

    // Close any open header dropdown when the user clicks outside it.
    useEffect(() => {
        function onMouseDown(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpenMenu(null);
            }
        }
        document.addEventListener('mousedown', onMouseDown);
        return () => document.removeEventListener('mousedown', onMouseDown);
    }, []);

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

    async function onConfirmDeletion(id: string) {
        setError(null);
        try {
            await confirmDeletion(id);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onCancelDeletion(id: string) {
        setError(null);
        try {
            await cancelDeletion(id);
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

    async function onTransferConcurrencyChange(value: number) {
        setError(null);
        try {
            const res = await updateSettings({ transferConcurrency: value });
            setTransferConcurrency(res.transferConcurrency);
        } catch (err) {
            setError((err as Error).message);
        }
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
                    <button className="btn btn-primary" onClick={() => setShowCreatePair(true)} title="Create a new sync pair">
                        ＋ Create Sync Pair
                    </button>
                    <div className="menu-group" ref={menuRef}>
                        <div className="menu-wrap">
                            <button className={logsButtonClass} onClick={() => setOpenMenu(openMenu === 'logs' ? null : 'logs')} title="Logs">
                                Logs ▾
                            </button>
                            {openMenu === 'logs' && (
                                <div className="menu">
                                    <button className="menu-item" onClick={() => { setShowLogs(true); setOpenMenu(null); }}>
                                        Sync log
                                    </button>
                                    <button className="menu-item" onClick={() => { setShowActivityLog(true); setOpenMenu(null); }}>
                                        Activity log
                                    </button>
                                    <button className="menu-item" onClick={() => { setShowErrorLog(true); setOpenMenu(null); }}>
                                        Error log
                                    </button>
                                </div>
                            )}
                        </div>
                        <div className="menu-wrap">
                            <button className="btn btn-ghost" onClick={() => setOpenMenu(openMenu === 'settings' ? null : 'settings')} title="Settings" aria-label="Settings">
                                ⚙
                            </button>
                            {openMenu === 'settings' && (
                                <div className="menu">
                                    <button className="menu-item" onClick={() => { setShowBackup(true); setOpenMenu(null); }}>
                                        💾 Backup
                                    </button>
                                    <button className="menu-item" onClick={() => { onSetAppPassword(); setOpenMenu(null); }}>
                                        {appAuthEnabled ? '🔒 App password' : '🔓 Set password'}
                                    </button>
                                    {appAuthEnabled && (
                                        <button className="menu-item" onClick={() => { onLock(); setOpenMenu(null); }}>
                                            🔐 Lock
                                        </button>
                                    )}
                                    <button className="menu-item" onClick={onToggleTheme}>
                                        {theme === 'dark' ? '☀ Light mode' : '🌙 Dark mode'}
                                    </button>
                                    <div className="menu-divider" />
                                    <div className="menu-field">
                                        <span className="menu-label">Max concurrent transfers</span>
                                        <select className="select" value={transferConcurrency} onChange={(e) => onTransferConcurrencyChange(Number(e.target.value))}>
                                            <option value={1}>1 — sequential</option>
                                            <option value={2}>2</option>
                                            <option value={3}>3 — default</option>
                                            <option value={4}>4</option>
                                        </select>
                                        <span className="menu-hint">Higher is faster for bulk syncs but uses more bandwidth.</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    <button className="btn btn-ghost" onClick={() => setShowSignOut(true)}>
                        Sign out
                    </button>
                </div>
            </header>

            {!appAuthEnabled && (
                <div className="app-password-banner">
                    <span aria-hidden="true">🔓</span>
                    <span className="app-password-msg">
                        No app password set — anyone who can reach this address can view this dashboard and watch live sync activity.{' '}
                        <span className="app-password-why" title="Your NAS is usually only reachable over Tailscale or your LAN, but an app password adds a second lock so that even someone on that network can't open the dashboard, see synced file names, or attempt a sign-in without it. The password is stored as a scrypt hash, never in plaintext.">
                            Why?
                        </span>
                    </span>
                    <button className="btn btn-primary btn-sm" onClick={onSetAppPassword}>
                        Set password
                    </button>
                </div>
            )}

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

                        {reconnecting && <div className="alert">Connection lost — reconnecting…</div>}

                        {deletionHold && (
                            <DeletionHoldCard
                                hold={deletionHold}
                                onConfirm={() => void onConfirmDeletion(deletionHold.pairId)}
                                onCancel={() => void onCancelDeletion(deletionHold.pairId)}
                            />
                        )}

                        {overall && (overall.totalFiles > 0 || overall.totalBytes > 0) && <OverallBar {...overall} />}

                        {[...active.values()].map((t) => (
                            <ProgressBar key={t.relPath} {...t} />
                        ))}
                        {syncing && overall == null && active.size === 0 && (
                            scanState ? (
                                <div className="muted">
                                    Scanning {scanState.side === 'local' ? 'local folder' : 'Proton Drive'} —{' '}
                                    {scanState.files.toLocaleString()} files · {scanState.folders.toLocaleString()} folders
                                </div>
                            ) : (
                                <div className="muted">Scanning for changes…</div>
                            )
                        )}

                        {summary && !syncing && (
                            <div className="summary">
                                <h3>Last sync</h3>
                                <div className="summary-grid">
                                    <Stat label="Uploaded" value={summary.uploaded} />
                                    <Stat label="Downloaded" value={summary.downloaded} />
                                    <Stat label="Skipped" value={summary.skipped} />
                                    <Stat label="Failed" value={summary.failed} />
                                    <Stat label="Conflicts" value={summary.conflicts} />
                                    <Stat label="Trashed (Drive)" value={summary.driveTrashed} />
                                    <Stat label="Recycled (local)" value={summary.localRecycled} />
                                </div>
                            </div>
                        )}
                    </div>
                </section>

                <section className="col col-side">
                    {localVolumes.length > 0 && <LocalStorageCard volumes={localVolumes} />}
                    {storage && <StorageCard storage={storage} />}
                    <div className="card">
                        <h2>Folder pairs</h2>
                        <ul className="pair-list">
                            {pairs.map((p) => {
                                const interval = pairInterval(p);
                                return (
                                    <li key={p.id} className="pair">
                                        <div className="pair-main">
                                            <div className="pair-info">
                                                <div className="pair-name">
                                                    {p.driveFolderName || 'My Files (root)'}
                                                    {interval !== null && (
                                                        <span className="badge">⏱ {frequencyLabel(interval)}</span>
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
                                            <Toggle
                                                label="Auto-sync"
                                                checked={interval !== null}
                                                onChange={(v) => onUpdatePair(p.id, { realTime: false, autoSync: v, intervalSeconds: v ? interval ?? 3600 : interval ?? 0 })}
                                            />
                                            {interval !== null && (
                                                <select className="select" value={interval} onChange={(e) => onUpdatePair(p.id, { realTime: false, autoSync: true, intervalSeconds: Number(e.target.value) })}>
                                                    {SYNC_FREQUENCIES.map((f) => (
                                                        <option key={f.value} value={f.value}>
                                                            {f.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            {hashingPair && hashingPair.pairId === p.id ? (
                                                <button className="btn btn-primary btn-sm" disabled>
                                                    Hashing… {hashingPair.total > 0 ? `${Math.round((hashingPair.done / hashingPair.total) * 100)}%` : ''}
                                                </button>
                                            ) : (
                                                <button className="btn btn-ghost btn-sm" onClick={() => void openDedupe(p)}>
                                                    Dedupe Scan
                                                </button>
                                            )}
                                            {(conflictCounts[p.id] ?? 0) > 0 && (
                                                <button className="btn btn-ghost btn-sm btn-conflicts" onClick={() => setConflictsPair(p)}>
                                                    Conflicts ({conflictCounts[p.id]})
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                            {pairs.length === 0 && <li className="muted">No pairs yet. Click "Create Sync Pair" in the top bar to add one.</li>}
                        </ul>
                    </div>
                </section>
            </main>

            <footer className="footer">Third-party application — not affiliated with, endorsed by, or supported by Proton AG.</footer>

            {trashPair && <TrashModal pair={trashPair} onClose={() => setTrashPair(null)} />}
            {showLogs && <LogsModal onClose={() => setShowLogs(false)} />}
            {showActivityLog && <ActivityLogModal items={items} totalItems={totalItems} onClose={() => setShowActivityLog(false)} />}
            {showErrorLog && <ErrorLogModal onClose={() => { setShowErrorLog(false); void loadErrorStatus(); }} />}
            {showCreatePair && <CreatePairModal volumes={localVolumes} onCreated={reload} onClose={() => setShowCreatePair(false)} />}
            {dedupePair && <DuplicatesModal pair={dedupePair} onClose={() => setDedupePair(null)} />}
            {conflictsPair && <ConflictsModal pair={conflictsPair} onClose={() => setConflictsPair(null)} onChanged={() => void loadConflicts()} />}
            {showBackup && <BackupModal onClose={() => setShowBackup(false)} />}
            {showSignOut && <SignOutModal pairCount={pairs.length} onClose={() => setShowSignOut(false)} onSignedOut={onLogout} />}
        </div>
    );
}

function DeletionHoldCard({ hold, onConfirm, onCancel }: { hold: DeletionHold; onConfirm: () => void; onCancel: () => void }) {
    const pct = hold.pct.toFixed(1);
    const driveCount = hold.driveTrash.length;
    const localCount = hold.localRecycle.length;
    const preview: Array<{ side: string; path: string }> = [
        ...hold.driveTrash.slice(0, 5).map((p) => ({ side: 'Drive → trash', path: p })),
        ...hold.localRecycle.slice(0, 5).map((p) => ({ side: 'Local → recycle', path: p })),
    ];
    const more = hold.deletions - preview.length;
    return (
        <div className="deletion-hold">
            <div className="dh-head">
                <span className="dh-title">⚠ Deletion requires confirmation</span>
                <span className="dh-pct">{pct}%</span>
            </div>
            <p className="dh-desc">
                This sync would delete <strong>{hold.deletions}</strong> of <strong>{hold.totalTracked}</strong> tracked files (
                {pct}%), which exceeds the {hold.thresholdPct}% safety threshold. This usually means a source went offline — but if
                you intentionally deleted these, confirm to proceed.
            </p>
            <div className="dh-breakdown">
                {driveCount > 0 && <span>{driveCount} would be trashed on Proton Drive</span>}
                {driveCount > 0 && localCount > 0 && <span className="dh-sep">·</span>}
                {localCount > 0 && <span>{localCount} would be recycled locally (.pdn-trash)</span>}
            </div>
            {preview.length > 0 && (
                <ul className="dh-preview">
                    {preview.map((p, i) => (
                        <li key={i}>
                            <span className="dh-side">{p.side}</span>
                            <span className="dh-path">{p.path}</span>
                        </li>
                    ))}
                    {more > 0 && <li className="dh-more">… and {more} more</li>}
                </ul>
            )}
            <div className="dh-actions">
                <button className="btn btn-danger" onClick={onConfirm}>
                    Confirm & proceed
                </button>
                <button className="btn btn-ghost" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </div>
    );
}

function OverallBar({ transferredBytes, totalBytes, percent, speedBps, filesDone, totalFiles }: OverallState) {
    const pct = Math.max(0, Math.min(100, percent));
    const hasTransfer = totalBytes > 0;
    return (
        <div className="overall">
            <div className="overall-head">
                <span className="overall-label">Overall sync</span>
                <span className="overall-meta">
                    {hasTransfer
                        ? `${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)} · ${formatSpeed(speedBps)}`
                        : 'Verifying files'}
                </span>
            </div>
            <div className="progress-track">
                <div className="progress-fill fill-overall" style={{ width: `${pct}%` }} />
            </div>
            <div className="overall-foot">
                <span>
                    {filesDone} / {totalFiles} files
                </span>
                <span className="pct">{pct.toFixed(1)}%</span>
            </div>
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

function LocalStorageCard({ volumes }: { volumes: LocalVolume[] }) {
    return (
        <div className="card">
            <h2>Local storage</h2>
            {volumes.map((v) => {
                const pct = v.totalBytes > 0 ? Math.min(100, (v.usedBytes / v.totalBytes) * 100) : 0;
                return (
                    <div key={v.path} className="storage-vol">
                        <div className="storage-path">{v.path}</div>
                        <div className="storage-head">
                            <span className="storage-nums">
                                {formatBytes(v.usedBytes)} <span className="muted">of</span> {formatBytes(v.totalBytes)}
                            </span>
                            <span className="pct">{pct.toFixed(1)}%</span>
                        </div>
                        <div className="progress-track">
                            <div className="progress-fill fill-upload" style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function StorageCard({ storage }: { storage: StorageInfo }) {
    const max = storage.maxBytes;
    const pct = max > 0 ? Math.min(100, (storage.driveBytes / max) * 100) : 0;
    const showTotal = storage.usedBytes > 0 && storage.usedBytes !== storage.driveBytes;

    // Bar colour shifts from the default accent to a warning yellow-orange past 80%,
    // getting progressively redder toward 90%, then solid red (with a message) above 90%.
    let fillStyle: CSSProperties = {};
    if (pct >= 90) {
        fillStyle.background = 'linear-gradient(90deg, color-mix(in srgb, var(--danger) 65%, var(--warning) 35%), var(--danger))';
    } else if (pct > 80) {
        const d = Math.round(((pct - 80) / 10) * 100);
        fillStyle.background = `linear-gradient(90deg, var(--warning), color-mix(in srgb, var(--warning) ${100 - d}%, var(--danger) ${d}%))`;
    }

    return (
        <div className="card">
            <h2>Proton Drive Storage</h2>
            <div className="storage-head">
                <span className="storage-nums">
                    {formatBytes(storage.driveBytes)} <span className="muted">of</span> {formatBytes(storage.maxBytes)}
                </span>
                <span className="pct">{pct.toFixed(1)}%</span>
            </div>
            <div className="progress-track">
                <div className={`progress-fill ${pct > 80 ? '' : 'fill-upload'}`} style={{ width: `${pct}%`, ...fillStyle }} />
            </div>
            {pct >= 90 && <div className="storage-warning">Warning: Drive space almost full</div>}
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