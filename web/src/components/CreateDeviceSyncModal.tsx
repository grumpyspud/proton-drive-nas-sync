import { useEffect, useState } from 'react';
import { createDeviceSync } from '../api';
import type { LocalVolume } from '../types';
import { FolderBrowser } from './FolderBrowser';
import { DevicePicker } from './DevicePicker';

interface Props {
    volumes: LocalVolume[];
    /** Device uids already claimed by another device sync (rendered disabled). */
    claimedUids: string[];
    /** True when another device sync already has auto add/remove enabled. */
    autoAddTaken: boolean;
    onCreated: () => Promise<void> | void;
    onClose: () => void;
}

export function CreateDeviceSyncModal({ volumes, claimedUids, autoAddTaken, onCreated, onClose }: Props) {
    const [localDir, setLocalDir] = useState('');
    const [selected, setSelected] = useState<string[]>([]);
    const [autoAdd, setAutoAdd] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const first = volumes[0];
        if (localDir === '' && first) setLocalDir(first.path);
    }, [volumes, localDir]);

    async function submit() {
        if (!localDir.trim()) {
            setError('Choose a NAS folder first.');
            return;
        }
        if (selected.length === 0) {
            setError('Select at least one computer.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await createDeviceSync(localDir.trim(), selected, autoAdd);
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
                    <h2>Create device sync</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>

                <div className="field">
                    <span>NAS / local folder</span>
                    <FolderBrowser mode="local" value={localDir} onChange={setLocalDir} placeholder="/data" volumes={volumes.map((v) => v.path)} />
                </div>

                <div className="field">
                    <span>Computers to sync</span>
                    <DevicePicker selected={selected} onChange={setSelected} disabledUids={claimedUids} />
                </div>

                <div className="field">
                    <label className="device-toggle">
                        <input type="checkbox" checked={autoAdd} disabled={autoAddTaken} onChange={(e) => setAutoAdd(e.target.checked)} />
                        <span>Auto add/remove new computers</span>
                    </label>
                    {autoAddTaken ? (
                        <div className="muted">Another device sync already has auto add/remove enabled.</div>
                    ) : (
                        <div className="muted">Automatically add newly registered computers to this sync and remove computers that disappear.</div>
                    )}
                </div>

                {error && <div className="alert">{error}</div>}

                <div className="modal-actions">
                    <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !localDir.trim() || selected.length === 0}>
                        Create device sync
                    </button>
                </div>
            </div>
        </div>
    );
}
