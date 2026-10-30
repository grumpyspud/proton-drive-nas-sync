import { useState } from 'react';
import { logout } from '../api';

interface Props {
    pairCount: number;
    onClose: () => void;
    onSignedOut: () => void;
}

/**
 * Confirmation overlay for signing out. Signing out is a full reset of the app's
 * sync state — it removes every folder pair and each pair's local trash — so it
 * warns the user first. The user's actual synced files are left untouched.
 */
export function SignOutModal({ pairCount, onClose, onSignedOut }: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function confirm() {
        setBusy(true);
        setError(null);
        try {
            await logout();
            onSignedOut();
        } catch (err) {
            setError((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <div
            className="modal-overlay"
            onClick={() => {
                if (!busy) onClose();
            }}
        >
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Sign out of Proton?</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close" disabled={busy}>
                        ✕
                    </button>
                </div>
                <p>Signing out will:</p>
                <ul className="signout-list">
                    <li>Sign the app out of Proton.</li>
                    <li>Stop all syncs.</li>
                    <li>
                        Remove all folder pairs{pairCount > 0 ? ` (${pairCount})` : ''} and the local trash (<code>.pdn-trash</code>) for each.
                    </li>
                </ul>
                <p className="modal-hint">
                    No other data will be deleted — your synced files stay exactly where they are on your NAS and in Proton Drive. You'll need to sign in again
                    and recreate your folder pairs.
                </p>
                {error && <div className="alert">{error}</div>}
                <div className="modal-actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>
                        {busy ? 'Signing out…' : 'Sign out'}
                    </button>
                </div>
            </div>
        </div>
    );
}
