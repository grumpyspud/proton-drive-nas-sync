import { useEffect, useState } from 'react';
import { listDriveDir, listLocalDir } from '../api';
import type { DirListing } from '../types';

interface Props {
    mode: 'local' | 'drive';
    value: string;
    placeholder?: string;
    onChange: (path: string) => void;
}

/**
 * A typeable-path input with a browsable folder list underneath. Clicking a
 * folder fills the input (and drills into it); "Up one level" goes to the
 * parent. Local mode browses the filesystem (under the configured root);
 * drive mode browses Proton Drive by slash-separated name path.
 */
export function FolderBrowser({ mode, value, placeholder, onChange }: Props) {
    const [listing, setListing] = useState<DirListing | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
    }, [value, mode]);

    return (
        <div className="browser">
            <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
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
        </div>
    );
}
