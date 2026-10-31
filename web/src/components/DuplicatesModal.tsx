import { useEffect, useState } from 'react';
import { getDuplicates, ignoreDuplicates, listIgnored, recycleDuplicates, resetIgnored, unignoreDuplicates } from '../api';
import type { DuplicateGroup, IgnoredGroup, Pair } from '../types';
import { formatBytes } from '../format';

const DEDUPE_MIN_OPTIONS: Array<{ label: string; value: number }> = [
    { label: 'No min size', value: 0 },
    { label: '1 KB', value: 1024 },
    { label: '10 KB', value: 10240 },
    { label: '100 KB', value: 102400 },
    { label: '1 MB', value: 1048576 },
    { label: '10 MB', value: 10485760 },
];

const SEP = String.fromCharCode(0);

interface Props {
    pair: Pair;
    onClose: () => void;
}

/**
 * Duplicate-file scan for a single pair, shown as a pop-up overlay. Does NOT scan
 * on open: the user picks a minimum file size and clicks Scan. Reuses the per-file
 * SHA-1 the sync engine already stores. "Keep" is the checked state; if nothing is
 * checked, everything is kept (no way to remove all).
 */
export function DuplicatesModal({ pair, onClose }: Props) {
    const [minBytes, setMinBytes] = useState(0);
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [scanned, setScanned] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [batchBusy, setBatchBusy] = useState(false);
    const [keep, setKeep] = useState<Record<string, boolean>>({});
    const [ignored, setIgnored] = useState<IgnoredGroup[]>([]);

    async function loadIgnored() {
        try {
            setIgnored((await listIgnored(pair.id)).groups);
        } catch {
            // non-fatal: the ignore list is best-effort
        }
    }

    useEffect(() => {
        void loadIgnored();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pair.id]);

    async function unignore(relPaths: string[]) {
        try {
            await unignoreDuplicates(pair.id, relPaths);
            await loadIgnored();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function resetAllIgnored() {
        try {
            await resetIgnored(pair.id);
            await loadIgnored();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function scan() {
        setLoading(true);
        setError(null);
        setNotice(null);
        try {
            setGroups((await getDuplicates(pair.id, minBytes)).groups);
            setKeep({});
            setScanned(true);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }

    const prefix = (sha1: string) => `${pair.id}${SEP}${sha1}${SEP}`;

    function toggleKeep(sha1: string, relPath: string) {
        const k = prefix(sha1) + relPath;
        setKeep((prev) => ({ ...prev, [k]: !prev[k] }));
    }

    async function doIgnore(g: DuplicateGroup) {
        setBusy(g.sha1);
        setError(null);
        setNotice(null);
        try {
            await ignoreDuplicates(pair.id, g.files.map((f) => f.relPath));
            await loadIgnored();
            await scan();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    async function doRecycle(g: DuplicateGroup) {
        const p = prefix(g.sha1);
        const unselected = g.files.filter((f) => !keep[p + f.relPath]).map((f) => f.relPath);
        if (unselected.length === 0) return;
        setBusy(g.sha1);
        setError(null);
        setNotice(null);
        try {
            const res = await recycleDuplicates(pair.id, unselected);
            setNotice(`Recycled ${res.recycled} file(s) locally: Drive copies will be trashed on the next sync.`);
            await scan();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    // Groups with a partial "keep" selection (1..n-1 checked) contribute their
    // unchecked files to one batch recycle. Zero-checked and all-checked groups
    // are skipped (everything in them is kept).
    const batchRelPaths = groups.flatMap((g) => {
        const p = prefix(g.sha1);
        const checked = g.files.filter((f) => keep[p + f.relPath]).length;
        if (checked < 1 || checked >= g.files.length) return [];
        return g.files.filter((f) => !keep[p + f.relPath]).map((f) => f.relPath);
    });

    async function doRecycleAll() {
        if (batchRelPaths.length === 0) return;
        setBatchBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = await recycleDuplicates(pair.id, batchRelPaths);
            setNotice(`Recycled ${res.recycled} file(s) locally: Drive copies will be trashed on the next sync.`);
            await scan();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBatchBusy(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Duplicates: {pair.driveFolderName || 'My Files (root)'}</h2>
                    <div className="dupe-tools">
                        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                            ✕
                        </button>
                    </div>
                </div>

                <div className="dupe-controls">
                    <label className="dupe-filter">
                        <span>Min file size</span>
                        <select className="select" value={minBytes} onChange={(e) => setMinBytes(Number(e.target.value))}>
                            {DEDUPE_MIN_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button className="btn btn-primary btn-sm" onClick={() => void scan()} disabled={loading}>
                        {loading ? 'Scanning…' : 'Scan'}
                    </button>
                </div>

                <p className="dupe-hint">Check the copies you want to keep: unchecked copies are recycled. If none are checked, everything is kept.</p>

                {error && <div className="alert">{error}</div>}
                {notice && <div className="alert alert-ok">{notice}</div>}

                {loading ? (
                    <div className="muted">Scanning for duplicates…</div>
                ) : !scanned ? (
                    <div className="muted">Pick a minimum file size and click Scan to find duplicates.</div>
                ) : groups.length === 0 ? (
                    <div className="muted">No duplicate files found.</div>
                ) : (
                    <div className="dupe-body">
                        <div className="dupe-batch">
                            <button
                                className="btn btn-primary"
                                disabled={batchRelPaths.length === 0 || batchBusy || !!busy}
                                onClick={() => void doRecycleAll()}
                            >
                                {batchBusy ? 'Recycling…' : `Recycle all unselected (${batchRelPaths.length})`}
                            </button>
                        </div>
                        {groups.map((g) => {
                            const p = prefix(g.sha1);
                            const checkedCount = g.files.filter((f) => keep[p + f.relPath]).length;
                            const unselectedCount = g.files.length - checkedCount;
                            const canRecycle = checkedCount >= 1 && checkedCount < g.files.length;
                            const busyHere = busy === g.sha1;
                            return (
                                <div key={g.sha1} className="dupe-group">
                                    <div className="dupe-group-head">
                                        <span className="dupe-count">{g.files.length} identical copies</span>
                                        <span className="dupe-size">{formatBytes(g.size)} each</span>
                                    </div>
                                    <ul className="dupe-files">
                                        {g.files.map((f) => (
                                            <li key={f.relPath} className="dupe-file">
                                                <label className="dupe-check">
                                                    <input type="checkbox" checked={!!keep[p + f.relPath]} onChange={() => toggleKeep(g.sha1, f.relPath)} />
                                                    <span>keep</span>
                                                </label>
                                                <span className="dupe-path">{f.relPath}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <div className="dupe-actions">
                                        <button className="btn btn-primary btn-sm" disabled={!canRecycle || !!busyHere || batchBusy} onClick={() => void doRecycle(g)}>
                                            Recycle {unselectedCount} unselected
                                        </button>
                                        <button className="btn btn-ghost btn-sm" disabled={!!busyHere || batchBusy} onClick={() => void doIgnore(g)}>
                                            Ignore
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="dupe-ignored">
                    <div className="dupe-ignored-head">
                        <h3>Ignored files{ignored.length > 0 ? ` (${ignored.reduce((n, g) => n + g.files.length, 0)})` : ''}</h3>
                        {ignored.length > 0 && (
                            <button className="btn btn-ghost btn-sm" onClick={() => void resetAllIgnored()}>
                                Reset all
                            </button>
                        )}
                    </div>
                    {ignored.length === 0 ? (
                        <div className="muted">No files are currently ignored for this folder.</div>
                    ) : (
                        <ul className="dupe-ignored-list">
                            {ignored.map((g) => (
                                <li key={g.sha1 ?? g.files[0]} className="dupe-ignored-item">
                                    <div className="dupe-ignored-info">
                                        <span className="dupe-ignored-meta">
                                            {g.files.length} file{g.files.length === 1 ? '' : 's'}
                                            {g.size != null && ` · ${formatBytes(g.size)} each`}
                                        </span>
                                        {g.files.map((rp) => (
                                            <span key={rp} className="dupe-path">{rp}</span>
                                        ))}
                                    </div>
                                    <button className="btn btn-ghost btn-sm" onClick={() => void unignore(g.files)}>
                                        Reset
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}