import { useState } from 'react';
import { addPair } from '../api';
import type { LocalVolume } from '../types';
import { FolderBrowser } from './FolderBrowser';

function normalizeAbs(p: string): string {
    const stack: string[] = [];
    for (const part of p.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { stack.pop(); continue; }
        stack.push(part);
    }
    return '/' + stack.join('/');
}

function isSafeLocalDir(localDir: string, volumes: LocalVolume[]): boolean {
    const raw = localDir.trim();
    if (!raw) return true;                  // nothing chosen yet
    if (!raw.startsWith('/')) return false; // relative path -> not a mounted volume
    if (volumes.length === 0) return true;  // volumes unknown -> let the server decide
    const abs = normalizeAbs(raw);
    return volumes.some((v) => {
        const vol = normalizeAbs(v.path);
        return abs === vol || abs.startsWith(`${vol}/`);
    });
}

interface Props {
    volumes: LocalVolume[];
    onCreated: () => Promise<void> | void;
    onClose: () => void;
}

export function CreatePairModal({ volumes, onCreated, onClose }: Props) {
    const [localDir, setLocalDir] = useState('');
    const [folder, setFolder] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const safe = isSafeLocalDir(localDir, volumes);

    async function submit() {
        if (!localDir.trim()) {
            setError('Choose a NAS folder first.');
            return;
        }
        if (!safe) {
            setError('Local folder must be inside a mounted volume.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await addPair(localDir.trim(), folder.trim());
            await onCreated();
            onClose();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Create sync pair</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>

                <div className="create-grid">
                    <div className="field">
                        <span>NAS / local folder</span>
                        <FolderBrowser mode="local" value={localDir} onChange={setLocalDir} placeholder="/data" />
                    </div>
                    <div className="field">
                        <span>Proton Drive folder</span>
                        <FolderBrowser mode="drive" value={folder} onChange={setFolder} placeholder="My Files" />
                    </div>
                </div>

                {!safe && (
                    <div className="alert-warn">
                        ⚠ This folder is not on a mounted volume. Files would be written inside the
                        container and lost on rebuild/update: not to your NAS. Choose a folder under a
                        mounted volume{volumes.length > 0 ? ` (${volumes.map((v) => v.path).join(', ')})` : ''}.
                    </div>
                )}

                {error && <div className="alert">{error}</div>}

                <div className="modal-actions">
                    <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !localDir.trim() || !safe}>
                        Create pair
                    </button>
                </div>
            </div>
        </div>
    );
}