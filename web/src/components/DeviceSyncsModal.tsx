import { useCallback, useEffect, useState } from 'react';
import { listDeviceSyncs, removeDeviceSync, removeDeviceFromSync, setDeviceSyncAuto } from '../api';
import type { DeviceSync, LocalVolume } from '../types';
import { CreateDeviceSyncModal } from './CreateDeviceSyncModal';
import { AddDevicesModal } from './AddDevicesModal';

interface Props {
    volumes: LocalVolume[];
    onClose: () => void;
}

export function DeviceSyncsModal({ volumes, onClose }: Props) {
    const [syncs, setSyncs] = useState<DeviceSync[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [addingTo, setAddingTo] = useState<DeviceSync | null>(null);

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setSyncs((await listDeviceSyncs()).syncs);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    async function onRemove(id: string) {
        setError(null);
        try {
            await removeDeviceSync(id);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onRemoveDevice(id: string, deviceUid: string) {
        setError(null);
        try {
            await removeDeviceFromSync(id, deviceUid);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onToggleAuto(id: string, autoAddRemove: boolean) {
        setError(null);
        try {
            await setDeviceSyncAuto(id, autoAddRemove);
            await reload();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    const claimedUids = syncs.flatMap((s) => s.devices.map((d) => d.deviceUid).filter((u): u is string => !!u));
    const autoAddTaken = syncs.some((s) => s.autoAddRemove);

    return (
        <>
            <div className="modal-overlay" onClick={onClose}>
                <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                    <div className="modal-head">
                        <h2>Device syncs</h2>
                        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                            ✕
                        </button>
                    </div>
                    <p className="muted">
                        Mirror a NAS folder to the root folder of one or more computers running the Proton Drive desktop app. Two-way sync.
                    </p>

                    {error && <div className="alert">{error}</div>}

                    {loading ? (
                        <div className="muted">Loading…</div>
                    ) : syncs.length === 0 ? (
                        <div className="muted">No device syncs yet. Create one to mirror a folder to your computers.</div>
                    ) : (
                        <ul className="pair-list">
                            {syncs.map((s) => {
                                const autoDisabled = !s.autoAddRemove && autoAddTaken;
                                return (
                                    <li key={s.id} className="pair">
                                        <div className="pair-main">
                                            <div className="pair-info">
                                                <div className="pair-name">
                                                    {s.devices.map((d) => d.name).join(', ') || 'No computers'}
                                                    {s.autoAddRemove && <span className="badge">auto add/remove</span>}
                                                </div>
                                                <div className="pair-dir">{s.localDir}</div>
                                            </div>
                                            <div className="pair-actions">
                                                <button className="btn btn-ghost btn-sm" onClick={() => setAddingTo(s)}>
                                                    Add computers
                                                </button>
                                                <button className="btn btn-ghost btn-sm" onClick={() => void onRemove(s.id)}>
                                                    Remove
                                                </button>
                                            </div>
                                        </div>
                                        <div className="device-sync-detail">
                                            <label className="device-toggle">
                                                <input
                                                    type="checkbox"
                                                    checked={s.autoAddRemove}
                                                    disabled={autoDisabled}
                                                    onChange={(e) => void onToggleAuto(s.id, e.target.checked)}
                                                />
                                                <span>Auto add/remove new computers</span>
                                            </label>
                                            {s.devices.length > 0 ? (
                                                <ul className="device-member-list">
                                                    {s.devices.map((d) => (
                                                        <li key={d.pairId} className="device-member">
                                                            <span className="device-member-name">{d.name}</span>
                                                            <button
                                                                className="btn btn-ghost btn-sm"
                                                                onClick={() => void onRemoveDevice(s.id, d.deviceUid!)}
                                                                aria-label={`Remove ${d.name}`}
                                                            >
                                                                ✕
                                                            </button>
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                <div className="muted">
                                                    {s.autoAddRemove
                                                        ? 'No computers yet - waiting for a computer to register.'
                                                        : 'No computers in this sync.'}
                                                </div>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    <div className="modal-actions">
                        <button className="btn btn-ghost" onClick={onClose}>
                            Close
                        </button>
                        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
                            ＋ Create device sync
                        </button>
                    </div>
                </div>
            </div>
            {showCreate && (
                <CreateDeviceSyncModal
                    volumes={volumes}
                    claimedUids={claimedUids}
                    autoAddTaken={autoAddTaken}
                    onCreated={reload}
                    onClose={() => setShowCreate(false)}
                />
            )}
            {addingTo && (
                <AddDevicesModal
                    sync={addingTo}
                    claimedUids={claimedUids}
                    onAdded={() => {
                        setAddingTo(null);
                        void reload();
                    }}
                    onClose={() => setAddingTo(null)}
                />
            )}
        </>
    );
}
