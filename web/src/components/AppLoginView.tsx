import { useState, type FormEvent } from 'react';
import { appLogin } from '../api';

interface Props {
    onUnlock: () => void;
    theme: 'dark' | 'light';
    onToggleTheme: () => void;
}

/** Layer-1 gate: unlock the app password before the Proton Drive login is reachable. */
export function AppLoginView({ onUnlock, theme, onToggleTheme }: Props) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await appLogin(password);
            onUnlock();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="auth-wrap">
            <button className="btn btn-ghost theme-toggle" onClick={onToggleTheme} title="Toggle light/dark mode">
                {theme === 'dark' ? '☀' : '🌙'}
            </button>
            <div className="card auth-card">
                <div className="brand">
                    <div className="brand-mark">⇄</div>
                    <div>
                        <h1>Proton Drive NAS Sync</h1>
                        <p className="subtitle">Unlock the app</p>
                    </div>
                </div>
                <form onSubmit={submit}>
                    <label className="field">
                        <span>App password</span>
                        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                    </label>
                    {error && <div className="alert">{error}</div>}
                    <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
                        {busy ? 'Unlocking…' : 'Unlock'}
                    </button>
                </form>
            </div>
        </div>
    );
}
