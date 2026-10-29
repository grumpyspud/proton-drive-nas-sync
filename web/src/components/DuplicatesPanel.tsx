import { useEffect, useState } from 'react';
import { getDuplicates, ignoreDuplicates, recycleDuplicates } from '../api';
import type { DuplicateGroup, Pair } from '../types';
import { formatBytes } from '../format';

interface PairDupes {
    pairId: string;
    pairName: string;
    groups: DuplicateGroup[];
}

interface Props {
    nonce: number;
    pairs: Pair[];
}

/**
 * Duplicate-file section rendered under "Sync activity". Scans each dedupe-enabled
 * pair for content-identical files (reusing the per-file SHA-1 the sync engine
 * already stores) and lets the user keep / recycle / ignore them. "Keep" is the
 * checked state; if nothing is checked, everything is kept (no way to remove all).
 */
export function DuplicatesPanel({ nonce, pairs }: Props) {
    const enabled = pairs.filter((p) => p.dedupeEnabled);
    const [data, setData] = useState<PairDupes[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    // "keep" checkboxes: key = `${pairId}\u0000${sha1}\u0000${relPath}`
    const [keep, setKeep] = useState<Record<string, boolean>>({});

    useEffect(() => {
        if (enabled.length === 0) {
            setData([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        Promise.all(
            enabled.map(async (p) => ({
                pairId: p.id,
                pairName: p.driveFolderName || 'My Files (root)',
                groups: (await getDuplicates(p.id)).groups,
            })),
        )
            .then((results) => {
                if (cancelled) return;
                setData(results.filter((r) => r.groups.length > 0));
                setKeep({});
            })
            .catch((err) => {
                if (!cancelled) setError((err as Error).message);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [nonce, pairs, refresh]);

    if (enabled.length === 0) return null;

    const totalGroups = data.reduce((n, d) => n + d.groups.length, 0);

    function keepKey(pairId: string, sha1: string, relPath: string): string {
        return `${pairId}\u0000${sha1}\u0000${relPath}`;
    }

    function toggleKeep(pairId: string, sha1: string, relPath: string) {
        const k = keepKey(pairId, sha1, relPath);
        setKeep((prev) => ({ ...prev, [k]: !prev[k] }));
    }

    function dismissGroup(pairId: string, sha1: string) {
        setData((prev) =>
            prev
                .map((pd) => (pd.pairId === pairId ? { ...pd, groups: pd.groups.filter((g) => g.sha1 !== sha1) } : pd))
                .filter((pd) => pd.groups.length > 0),
        );
    }

    async function doIgnore(pd: PairDupes, g: DuplicateGroup) {
        setBusy(`${pd.pairId}\u0000${g.sha1}`);
        setError(null);
        setNotice(null);
        try {
            await ignoreDuplicates(pd.pairId, g.files.map((f) => f.relPath));
            setRefresh((r) => r + 1);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    async function doRecycle(pd: PairDupes, g: DuplicateGroup) {
        const prefix = `${pd.pairId}\u0000${g.sha1}\u0000`;
        const unselected = g.files.filter((f) => !keep[prefix + f.relPath]).map((f) => f.relPath);
        if (unselected.length === 0) return;
        setBusy(`${pd.pairId}\u0000${g.sha1}`);
        setError(null);
        setNotice(null);
        try {
            const res = await recycleDuplicates(pd.pairId, unselected);
            setNotice(`Recycled ${res.recycled} file(s) locally — Drive copies will be trashed on the next sync.`);
            setRefresh((r) => r + 1);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="card">
            <div className="card-head">
                <h2>Duplicates</h2>
                <div className="dupe-tools">
                    {totalGroups > 0 && (
                        <span className="badge badge-paused">
                            {totalGroups} group{totalGroups === 1 ? '' : 's'}
                        </span>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => setRefresh((r) => r + 1)} disabled={loading}>
                        Check now
                    </button>
                </div>
            </div>

            <p className="dupe-hint">Check the copies you want to keep — unchecked copies are recycled. If none are checked, everything is kept.</p>

            {error && <div className="alert">{error}</div>}
            {notice && <div className="alert alert-ok">{notice}</div>}

            {loading ? (
                <div className="muted">Scanning for duplicates…</div>
            ) : data.length === 0 ? (
                <div className="muted">No duplicate files found.</div>
            ) : (
                data.map((pd) => (
                    <div key={pd.pairId} className="dupe-pair">
                        <div className="dupe-pair-name">{pd.pairName}</div>
                        {pd.groups.map((g) => {
                            const prefix = `${pd.pairId}\u0000${g.sha1}\u0000`;
                            const checkedCount = g.files.filter((f) => keep[prefix + f.relPath]).length;
                            const unselectedCount = g.files.length - checkedCount;
                            const canRecycle = checkedCount >= 1 && checkedCount < g.files.length;
                            const busyHere = busy === `${pd.pairId}\u0000${g.sha1}`;
                            return (
                                <div key={g.sha1} className="dupe-group">
                                    <div className="dupe-group-head">
                                        <span className="dupe-count">
                                            {g.files.length} identical copies
                                        </span>
                                        <span className="dupe-size">{formatBytes(g.size)} each</span>
                                    </div>
                                    <ul className="dupe-files">
                                        {g.files.map((f) => (
                                            <li key={f.relPath} className="dupe-file">
                                                <label className="dupe-check">
                                                    <input
                                                        type="checkbox"
                                                        checked={!!keep[prefix + f.relPath]}
                                                        onChange={() => toggleKeep(pd.pairId, g.sha1, f.relPath)}
                                                    />
                                                    <span>keep</span>
                                                </label>
                                                <span className="dupe-path">{f.relPath}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <div className="dupe-actions">
                                        <button className="btn btn-primary btn-sm" disabled={!canRecycle || !!busyHere} onClick={() => doRecycle(pd, g)}>
                                            Recycle {unselectedCount} unselected
                                        </button>
                                        <button className="btn btn-ghost btn-sm" disabled={!!busyHere} onClick={() => dismissGroup(pd.pairId, g.sha1)}>
                                            Keep all
                                        </button>
                                        <button className="btn btn-ghost btn-sm" disabled={!!busyHere} onClick={() => doIgnore(pd, g)}>
                                            Ignore
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))
            )}
        </section>
    );
}
