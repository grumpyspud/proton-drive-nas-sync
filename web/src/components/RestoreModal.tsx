import { useState, type FormEvent } from 'react';
import { restoreBackup } from '../api';

interface Props {
    onClose: () => void;
    onRestored: () => void;
}

function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

export function RestoreModal({ onClose, onRestored }: Props) {
    const [appPassword, setAppPassword] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [fileName, setFileName] = useState<string | null>(null);
    const [backupB64, setBackupB64] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    async function onFile(file: File | undefined) {
        if (!file) {
            setFileName(null);
            setBackupB64(null);
            return;
        }
        setFileName(file.name);
        setBackupB64(toBase64(await file.arrayBuffer()));
    }

    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setResult(null);
        try {
            const r = await restoreBackup(appPassword, passphrase, backupB64 ?? undefined);
            setResult(
                r.resumed
                    ? 'Restore complete: your Proton session was resumed.'
                    : 'Restore complete, but the Proton session could not be resumed (the refresh token may have expired). Sign in again to reconnect.',
            );
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Restore config</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                {result ? (
                    <div>
                        <div className="alert alert-ok">{result}</div>
                        <div className="modal-actions">
                            <button className="btn btn-primary" onClick={onRestored}>
                                Done
                            </button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={submit}>
                        <label className="field">
                            <span>App password</span>
                            <input type="password" autoFocus value={appPassword} onChange={(e) => setAppPassword(e.target.value)} autoComplete="current-password" />
                        </label>
                        <label className="field">
                            <span>Backup passphrase</span>
                            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="current-password" />
                        </label>
                        <label className="field">
                            <span>
                                Backup file <em>(optional: uses the on-server copy if empty)</em>
                            </span>
                            <input type="file" onChange={(e) => void onFile(e.target.files?.[0])} />
                        </label>
                        {fileName && <p className="modal-hint">Selected: {fileName}</p>}
                        <p className="modal-hint">
                            This replaces the current pairs, session, and encryption key. It needs the app password <em>and</em>{' '}
                            passphrase that created the backup: if the app password has changed since, set it back to its
                            backup-time value first.
                        </p>
                        {error && <div className="alert">{error}</div>}
                        <div className="modal-actions">
                            <button type="button" className="btn btn-ghost" onClick={onClose}>
                                Cancel
                            </button>
                            <button type="submit" className="btn btn-primary" disabled={busy}>
                                {busy ? 'Restoring…' : 'Restore'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
