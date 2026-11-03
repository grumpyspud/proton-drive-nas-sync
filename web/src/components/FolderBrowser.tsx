import { useEffect, useState } from 'react';
import { listDriveDir, listLocalDir, mkdirDrive, mkdirLocal } from '../api';
import type { DirListing } from '../types';

interface Props {
    mode: 'local' | 'drive';
    value: string;
    placeholder?: string;
    onChange: (path: string) => void;
    /** Bind-mount paths the local picker can browse (unused in drive mode). */
    volumes?: string[];
}

/**
 * A typeable-path input with a browsable folder list underneath. Clicking a
 * folder fills the input (and drills into it); "Up one level" goes to the
 * parent. Local mode browses the filesystem (under the configured root);
 * drive mode browses Proton Drive by slash-separated name path.
 *
 * Drive mode adds a "My Files (entire drive)" row to select the root itself.
 * Both modes add a "New folder" action to create a subfolder of the current
 * path (on the local filesystem or on Drive, respectively).
 */
export function FolderBrowser({ mode, value, placeholder, onChange, volumes }: Props) {
    const [listing, setListing] = useState<DirListing | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showNew, setShowNew] = useState(false);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(() => {
            const fetch = mode === 'local' ? listLocalDir : listDriveDir;
            fetch(value)
                .then((l) => {
                    if (!cancelled) {
                        setListing(l);
                        setError(null);
                    }
                })
                .catch((e: Error) => {
                    if (!cancelled) {
                        setListing(null);
                        setError(e.message);
                    }
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            setLoading(false);
        };
    }, [value, mode, refreshKey]);

    async function createFolder() {
        const name = newName.trim();
        if (!name) return;
        setCreating(true);
        setError(null);
        try {
            if (mode === 'local') await mkdirLocal(value, name);
            else await mkdirDrive(value, name);
            setNewName('');
            setShowNew(false);
            // Re-list the current directory so the new folder appears in place.
            setRefreshKey((k) => k + 1);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setCreating(false);
        }
    }

    function currentVolume(): string {
        if (!volumes || volumes.length === 0) return '';
        for (const v of volumes) {
            const vp = v.endsWith('/') ? v.slice(0, -1) : v;
            if (value === vp || value.startsWith(`${vp}/`)) return v;
        }
        return volumes[0] ?? '';
    }

    return (
        <div className="browser">
            <input value={value} placeholder={placeholder} readOnly spellCheck={false} title="Navigate using the list below" />
            {mode === 'local' && volumes && volumes.length > 1 && (
                <select
                    className="browser-volume"
                    value={currentVolume()}
                    onChange={(e) => onChange(e.target.value)}
                    title="Select a mounted volume"
                >
                    {volumes.map((v) => (
                        <option key={v} value={v}>{v}</option>
                    ))}
                </select>
            )}
            {mode === 'drive' && (
                <button
                    type="button"
                    className={`browser-row browser-root${value === '' ? ' selected' : ''}`}
                    onClick={() => onChange('')}
                    title="Sync the entire My Files root"
                >
                    <span className="browser-icon">🏠</span>
                    <span className="browser-name">My Files (entire drive)</span>
                    {value === '' && <span className="browser-check">✓</span>}
                </button>
            )}
            {error && <div className="browser-note browser-error">{error}</div>}
            <div className="browser-list">
                {listing && listing.parent !== null && (
                    <button type="button" className="browser-row browser-up" onClick={() => onChange(listing.parent!)}>
                        <span className="browser-icon">↰</span>
                        <span className="browser-name">Up one level</span>
                    </button>
                )}
                {listing &&
                    listing.folders.map((f) => (
                        <button type="button" key={f.path} className="browser-row" onClick={() => onChange(f.path)}>
                            <span className="browser-icon">📁</span>
                            <span className="browser-name">{f.name}</span>
                        </button>
                    ))}
                {!loading && !error && listing && listing.folders.length === 0 && (
                    <div className="browser-note">No subfolders</div>
                )}
                {loading && <div className="browser-note">Loading…</div>}
            </div>
            {(showNew ? (
                    <div className="browser-new">
                        <input
                            autoFocus
                            value={newName}
                            placeholder="New folder name"
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void createFolder();
                                }
                            }}
                            spellCheck={false}
                        />
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void createFolder()} disabled={creating || !newName.trim()}>
                            Create
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                                setShowNew(false);
                                setNewName('');
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <button type="button" className="browser-row browser-new-btn" onClick={() => setShowNew(true)}>
                        <span className="browser-icon">＋</span>
                        <span className="browser-name">New folder</span>
                    </button>
                ))}
        </div>
    );
}
