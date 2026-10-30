import { useCallback, useEffect, useState } from 'react';
import { getDuplicates, ignoreDuplicates, recycleDuplicates } from '../api';
import type { DuplicateGroup, Pair } from '../types';
import { formatBytes } from '../format';

interface Props {
    pair: Pair;
    onClose: () => void;
}

/**
 * Duplicate-file scan for a single pair, shown as a pop-up overlay. Scans on open
 * (reusing the per-file SHA-1 the sync engine already stores) and lets the user
 * keep / recycle / ignore identical copies. "Keep" is the checked state; if nothing
 * is checked, everything is kept (no way to remove all).
 */
export function DuplicatesModal({ pair, onClose }: Props) {
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [keep, setKeep] = useState<Record<string, boolean>>({});

    const scan = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setGroups((await getDuplicates(pair.id)).groups);
            setKeep({});
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, [pair.id]);

    useEffect(() => {
        void scan();
    }, [scan]);

    const prefix = (sha1: string) => `${pair.id}\u0000${sha1}\u0000`;

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
            setNotice(`Recycled ${res.recycled} file(s) locally — Drive copies will be trashed on the next sync.`);
            await scan();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Duplicates — {pair.driveFolderName || 'My Files (root)'}</h2>
                    <div className="dupe-tools">
                        {!loading && groups.length > 0 && (
                            <span className="badge badge-paused">
                                {groups.length} group{groups.length === 1 ? '' : 's'}
                            </span>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => void scan()} disabled={loading}>
                            Rescan
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                            ✕
                        </button>
                    </div>
                </div>

                <p className="dupe-hint">Check the copies you want to keep — unchecked copies are recycled. If none are checked, everything is kept.</p>

                {error && <div className="alert">{error}</div>}
                {notice && <div className="alert alert-ok">{notice}</div>}

                {loading ? (
                    <div className="muted">Scanning for duplicates…</div>
                ) : groups.length === 0 ? (
                    <div className="muted">No duplicate files found.</div>
                ) : (
                    <div className="dupe-body">
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
                                        <button className="btn btn-primary btn-sm" disabled={!canRecycle || !!busyHere} onClick={() => void doRecycle(g)}>
                                            Recycle {unselectedCount} unselected
                                        </button>
                                        <button className="btn btn-ghost btn-sm" disabled={!!busyHere} onClick={() => void doIgnore(g)}>
                                            Ignore
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}