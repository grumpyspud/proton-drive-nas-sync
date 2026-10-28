import { useEffect, useState, type FormEvent } from 'react';
import { acknowledgeBackupWarning, createBackup, downloadBackup, getBackupStatus, type BackupStatus } from '../api';

interface Props {
    onClose: () => void;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function BackupModal({ onClose }: Props) {
    const [status, setStatus] = useState<BackupStatus | null>(null);
    const [appPassword, setAppPassword] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [confirm, setConfirm] = useState('');
    const [overwrite, setOverwrite] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    function refresh() {
        getBackupStatus()
            .then(setStatus)
            .catch(() => setStatus(null));
    }

    useEffect(() => {
        refresh();
    }, []);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (passphrase !== confirm) {
            setError('Passphrases do not match');
            return;
        }
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const r = await createBackup(appPassword, passphrase, overwrite);
            setNotice(`Backup created (${formatBytes(r.size)})${r.hasSession ? '' : ' — no active Proton session was included'}.`);
            setPassphrase('');
            setConfirm('');
            setAppPassword('');
            setOverwrite(false);
            refresh();
        } catch (err) {
            const msg = (err as Error).message;
            if (msg.includes('already exists')) {
                setOverwrite(true);
                setError('A backup already exists — download the current one first, then click "Replace existing".');
            } else {
                setError(msg);
            }
        } finally {
            setBusy(false);
        }
    }

    async function onDownload() {
        setError(null);
        setNotice(null);
        try {
            await downloadBackup();
            setNotice('Download started.');
            setTimeout(refresh, 600);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function onAcknowledge() {
        setError(null);
        try {
            await acknowledgeBackupWarning();
            refresh();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Backup config</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>

                {status?.exists ? (
                    <div className="backup-summary">
                        <p>
                            Backup created <strong>{status.createdAt ? new Date(status.createdAt).toLocaleString() : ''}</strong> ·{' '}
                            {formatBytes(status.size)} · downloaded {status.downloadCount}×
                        </p>
                        <div className="backup-actions">
                            <button className="btn btn-primary" onClick={() => void onDownload()}>
                                Download backup
                            </button>
                        </div>
                    </div>
                ) : (
                    <p className="modal-hint">No backup created yet.</p>
                )}

                {status?.warningActive && (
                    <div className="alert">
                        <strong>Warning:</strong> this backup was downloaded from a different client
                        {status.lastDownload && (
                            <>
                                {' '}
                                (OS {status.lastDownload.os}, {status.lastDownload.browser}, IP {status.lastDownload.ip})
                            </>
                        )}{' '}
                        than the one that created it. If that wasn't you, change your Proton password and create a fresh backup.
                        <div className="backup-actions">
                            <button className="btn btn-ghost" onClick={() => void onAcknowledge()}>
                                This was me — clear warning
                            </button>
                        </div>
                    </div>
                )}

                <hr className="modal-divider" />

                <form onSubmit={submit}>
                    <h3 className="modal-subhead">{status?.exists ? 'Replace existing backup' : 'Create backup'}</h3>
                    <label className="field">
                        <span>Current app password</span>
                        <input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} autoComplete="current-password" />
                    </label>
                    <label className="field">
                        <span>Backup passphrase</span>
                        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
                    </label>
                    <label className="field">
                        <span>Confirm passphrase</span>
                        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                    </label>
                    <p className="modal-hint">
                        At least 12 characters with uppercase, lowercase, a number, and a symbol. You'll need the app password{' '}
                        <em>and</em> this passphrase to restore — keep the passphrase somewhere safe (a password manager).
                    </p>
                    {error && <div className="alert">{error}</div>}
                    {notice && <div className="alert alert-ok">{notice}</div>}
                    <div className="modal-actions">
                        <button type="button" className="btn btn-ghost" onClick={onClose}>
                            Close
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={busy}>
                            {busy ? 'Creating…' : overwrite ? 'Replace existing' : 'Create backup'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
