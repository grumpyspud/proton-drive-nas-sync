import { useEffect, useState } from 'react';
import { listDevices } from '../api';
import type { Device } from '../types';

interface Props {
    selected: string[];
    onChange: (uids: string[]) => void;
    /** Device uids already claimed by another device sync (rendered disabled). */
    disabledUids?: string[];
    /** Device uids already members of this sync (rendered disabled, "already added"). */
    memberUids?: string[];
}

/**
 * Lists the user's Proton Drive "Computers" devices with multi-select
 * checkboxes. Selecting a device means "sync to this device's root folder".
 * Fetches its own device list on mount; the parent owns the selection state.
 */
export function DevicePicker({ selected, onChange, disabledUids, memberUids }: Props) {
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
                const claimed = (disabledUids ?? []).includes(device.uid);
                const member = (memberUids ?? []).includes(device.uid);
                const disabled = claimed || member;
                const label = member ? 'already added' : claimed ? 'in use by another sync' : device.type;
                return (
                    <label key={device.uid} className={`device-row${checked ? ' selected' : ''}${disabled ? ' disabled' : ''}`}>
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(device.uid)} />
                        <span className="device-name">{device.name}</span>
                        <span className="device-type">{label}</span>
                    </label>
                );
            })}
        </div>
    );
}
