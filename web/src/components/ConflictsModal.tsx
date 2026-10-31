import { useEffect, useState } from 'react';
import { getConflicts, resolveConflict } from '../api';
import type { Conflict, Pair } from '../types';
import { formatBytes, formatDate } from '../format';

interface Props {
    pair: Pair;
    onClose: () => void;
    onChanged?: () => void;
}

function shortHash(h: string | null): string {
    return h ? `${h.slice(0, 10)}…` : '~';
}

/**
 * Pending-conflict resolver for a single pair. Each conflict shows the two
 * versions (local + the preserved Drive copy) with size/date/hash; pick which
 * to keep and hit "Keep selected". One conflict at a time: resolution recycles
 * the loser to .pdn-trash and, for "keep local", re-uploads to Drive.
 */
export function ConflictsModal({ pair, onClose, onChanged }: Props) {
    const [conflicts, setConflicts] = useState<Conflict[]>([]);
    const [keep, setKeep] = useState<Record<string, 'local' | 'drive'>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    async function load() {
        setError(null);
        try {
            setConflicts((await getConflicts(pair.id)).conflicts);
            setLoaded(true);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pair.id]);

    async function doKeep(c: Conflict) {
        const k = keep[c.conflictPath];
        if (!k) return;
        setBusy(c.conflictPath);
        setError(null);
        try {
            await resolveConflict(pair.id, c.conflictPath, k);
            setKeep((prev) => {
                const next = { ...prev };
                delete next[c.conflictPath];
                return next;
            });
            await load();
            onChanged?.();
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
                    <h2>Conflicts: {pair.driveFolderName || 'My Files (root)'}</h2>
                    <div className="dupe-tools">
                        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                            ✕
                        </button>
                    </div>
                </div>

                <p className="dupe-hint">
                    A file exists in both places with different contents. Choose which version to keep: the other is
                    recycled to .pdn-trash.
                </p>

                {error && <div className="alert">{error}</div>}

                {!loaded ? (
                    <div className="muted">Loading conflicts…</div>
                ) : conflicts.length === 0 ? (
                    <div className="muted">No conflicts to resolve.</div>
                ) : (
                    <div className="conflict-body">
                        {conflicts.map((c) => {
                            const busyHere = busy === c.conflictPath;
                            const selected = keep[c.conflictPath];
                            return (
                                <div key={c.conflictPath} className="conflict-group">
                                    <div className="conflict-path">{c.relPath}</div>
                                    <div className="conflict-versions">
                                        <VersionRow
                                            name={c.conflictPath}
                                            value="local"
                                            label="Local (NAS)"
                                            size={c.localSize}
                                            mtimeMs={c.localMtime}
                                            sha1={c.localSha1}
                                            checked={selected === 'local'}
                                            onSelect={() => setKeep((prev) => ({ ...prev, [c.conflictPath]: 'local' }))}
                                        />
                                        <VersionRow
                                            name={c.conflictPath}
                                            value="drive"
                                            label="Drive (Proton)"
                                            size={c.conflictSize}
                                            mtimeMs={c.conflictMtime}
                                            sha1={c.conflictSha1}
                                            checked={selected === 'drive'}
                                            onSelect={() => setKeep((prev) => ({ ...prev, [c.conflictPath]: 'drive' }))}
                                        />
                                    </div>
                                    <div className="conflict-actions">
                                        <button className="btn btn-primary btn-sm" disabled={!selected || !!busyHere} onClick={() => void doKeep(c)}>
                                            {busyHere ? 'Resolving…' : 'Keep selected'}
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

function VersionRow({
    name,
    value,
    label,
    size,
    mtimeMs,
    sha1,
    checked,
    onSelect,
}: {
    name: string;
    value: string;
    label: string;
    size: number | null;
    mtimeMs: number | null;
    sha1: string | null;
    checked: boolean;
    onSelect: () => void;
}) {
    return (
        <label className="conflict-version">
            <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} />
            <span className="conflict-vlabel">{label}</span>
            <span className="conflict-vmeta">
                {size != null ? formatBytes(size) : '~'}
                {' · '}
                {mtimeMs != null ? formatDate(mtimeMs) : '~'}
            </span>
            <span className="conflict-vhash" title={sha1 ?? undefined}>
                SHA-1 {shortHash(sha1)}
            </span>
        </label>
    );
}
