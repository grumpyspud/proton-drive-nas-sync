import { useState } from 'react';
import { addDevicesToSync } from '../api';
import type { DeviceSync } from '../types';
import { DevicePicker } from './DevicePicker';

interface Props {
    sync: DeviceSync;
    /** All device uids currently claimed by any sync (this one included). */
    claimedUids: string[];
    onAdded: () => void;
    onClose: () => void;
}

export function AddDevicesModal({ sync, claimedUids, onAdded, onClose }: Props) {
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const memberUids = sync.devices.map((d) => d.deviceUid).filter((u): u is string => u !== null);
    const claimedByOthers = claimedUids.filter((u) => !memberUids.includes(u));

    async function submit() {
        if (selected.length === 0) {
            setError('Select at least one computer.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await addDevicesToSync(sync.id, selected);
            onAdded();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Add computers</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <p className="muted">
                    Add computers to <strong>{sync.localDir}</strong>. Each one syncs to its own Proton Drive device folder.
                </p>

                {error && <div className="alert">{error}</div>}

                <div className="field">
                    <span>Computers to add</span>
                    <DevicePicker selected={selected} onChange={setSelected} disabledUids={claimedByOthers} memberUids={memberUids} />
                </div>

                <div className="modal-actions">
                    <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || selected.length === 0}>
                        Add
                    </button>
                </div>
            </div>
        </div>
    );
}
