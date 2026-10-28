import { useState, type FormEvent } from 'react';
import { setAppPassword } from '../api';

interface Props {
    hasPassword: boolean;
    onClose: () => void;
    onChanged: () => void;
}

/** Set (first time) or change (requires current password) the app password. */
export function AppPasswordModal({ hasPassword, onClose, onChanged }: Props) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (next.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }
        if (next !== confirm) {
            setError('New passwords do not match');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // When no password is set yet, leave current empty (the server accepts that).
            await setAppPassword(hasPassword ? current : '', next);
            onChanged();
            onClose();
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
                    <h2>{hasPassword ? 'Change app password' : 'Set app password'}</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <form onSubmit={submit}>
                    {hasPassword && (
                        <label className="field">
                            <span>Current password</span>
                            <input type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
                        </label>
                    )}
                    <label className="field">
                        <span>New password</span>
                        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" autoFocus={!hasPassword} />
                    </label>
                    <label className="field">
                        <span>Confirm new password</span>
                        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                    </label>
                    <p className="modal-hint">
                        {hasPassword
                            ? 'Changing the password signs out any other devices using this app.'
                            : 'Locks this UI behind a password. Stored as a hash, never plaintext.'}
                    </p>
                    {error && <div className="alert">{error}</div>}
                    <div className="modal-actions">
                        <button type="button" className="btn btn-ghost" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={busy}>
                            {busy ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
