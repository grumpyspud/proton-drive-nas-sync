import { useEffect, useState } from 'react';
import { listDevices } from '../api';
import type { Device } from '../types';

interface Props {
    selected: string[];
    onChange: (uids: string[]) => void;
}

/**
 * Lists the user's Proton Drive "Computers" devices with multi-select
 * checkboxes. Selecting a device means "sync to this device's root folder".
 * Fetches its own device list on mount; the parent owns the selection state.
 */
export function DevicePicker({ selected, onChange }: Props) {
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

    function toggle(uid: string) {
        const next = selected.includes(uid) ? selected.filter((u) => u !== uid) : [...selected, uid];
        onChange(next);
    }

    if (loading) return <div className="muted">Loading devices…</div>;
    if (error) return <div className="alert">{error}</div>;
    if (devices.length === 0) {
        return (
            <div className="muted">
                No computers found. Install and sign in to the Proton Drive desktop app on a computer to add one.
            </div>
        );
    }

    return (
        <div className="device-list">
            {devices.map((device) => {
                const checked = selected.includes(device.uid);
                return (
                    <label key={device.uid} className={`device-row${checked ? ' selected' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggle(device.uid)} />
                        <span className="device-name">{device.name}</span>
                        <span className="device-type">{device.type}</span>
                    </label>
                );
            })}
        </div>
    );
}
