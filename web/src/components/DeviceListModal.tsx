import { useEffect, useState } from 'react';
import { listDevices } from '../api';
import type { Device } from '../types';

interface Props {
    onClose: () => void;
}

/**
 * Read-only list of the user's Proton Drive "Computers" devices (desktop app
 * installs). This is the verification surface for the device-sync feature: it
 * shows exactly what `iterateDevices()` returns for the account.
 */
export function DeviceListModal({ onClose }: Props) {
    const [devices, setDevices] = useState<Device[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        listDevices()
            .then(({ devices }) => {
                if (!cancelled) setDevices(devices);
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
    }, []);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Computers</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <p className="modal-hint">
                    Computers with the Proton Drive desktop app installed and signed in to this account.
                </p>
                {loading && <div className="muted">Loading devices…</div>}
                {error && <div className="alert">{error}</div>}
                {!loading && !error && devices.length === 0 && (
                    <div className="muted">No computers found.</div>
                )}
                {!loading && !error && devices.length > 0 && (
                    <div className="device-list">
                        {devices.map((d) => (
                            <div key={d.uid} className="device-row">
                                <span className="device-name">{d.name}</span>
                                <span className="device-type">{d.type}</span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="modal-actions">
                    <button className="btn btn-ghost" onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
