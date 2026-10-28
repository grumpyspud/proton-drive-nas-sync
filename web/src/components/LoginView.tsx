import { useState, type FormEvent } from 'react';
import { login } from '../api';

interface Props {
    onLogin: (uid?: string) => void;
}

export function LoginView({ onLogin }: Props) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
    const [needsMailbox, setNeedsMailbox] = useState(false);
    const [twoFactorCode, setTwoFactorCode] = useState('');
    const [mailboxPassword, setMailboxPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const result = await login(
                username,
                password,
                needsTwoFactor ? twoFactorCode : undefined,
                needsMailbox ? mailboxPassword : undefined,
            );
            if (result.authenticated) {
                onLogin(result.uid);
                return;
            }
            if (result.twoFactorRequired) {
                setNeedsTwoFactor(true);
            } else if (result.mailboxPasswordRequired) {
                setNeedsMailbox(true);
            } else {
                setError(result.error ?? 'Login failed');
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="auth-wrap">
            <div className="card auth-card">
                <div className="brand">
                    <div className="brand-mark">⇄</div>
                    <div>
                        <h1>Proton Drive NAS Sync</h1>
                        <p className="subtitle">Back up &amp; sync folders between your NAS and Proton Drive</p>
                    </div>
                </div>

                <form onSubmit={submit}>
                    <label className="field">
                        <span>Username</span>
                        <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                    </label>
                    {needsTwoFactor && (
                        <label className="field">
                            <span>Two-factor code</span>
                            <input value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" />
                        </label>
                    )}
                    {needsMailbox && (
                        <label className="field">
                            <span>Mailbox password</span>
                            <input type="password" value={mailboxPassword} onChange={(e) => setMailboxPassword(e.target.value)} />
                        </label>
                    )}
                    {error && <div className="alert">{error}</div>}
                    <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>

                <p className="disclaimer">
                    Third-party application — not affiliated with, endorsed by, or supported by Proton AG. Your credentials are
                    used only to authenticate with Proton Drive and are never stored in plaintext.
                </p>
            </div>
        </div>
    );
}
