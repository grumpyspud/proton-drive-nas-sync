import { useState, type FormEvent } from 'react';
import { login } from '../api';

interface Props {
    onLogin: (uid?: string) => void;
    theme: 'dark' | 'light';
    onToggleTheme: () => void;
}

interface HvChallenge {
    webUrl?: string;
    originalToken?: string;
}

/**
 * Proton's human-verification (CAPTCHA) page posts the solved token back via
 * `window.parent.postMessage()`, which only works when embedded as an iframe —
 * and verify.proton.me's CSP `frame-ancestors` only allows Proton's own origins.
 * So a third-party app cannot auto-receive it. This snippet, pasted into the
 * verification tab's devtools console BEFORE solving, captures the composite
 * token for manual entry.
 */
const CAPTURE_SNIPPET = `window.addEventListener('message', function (e) {
  var d = e.data || {};
  var t = (d.payload && d.payload.token) ? d.payload.token : d.token;
  if (t) { console.log('PDN TOKEN:', t); alert('PDN TOKEN:\\n\\n' + t); }
});`;

export function LoginView({ onLogin, theme, onToggleTheme }: Props) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
    const [needsMailbox, setNeedsMailbox] = useState(false);
    const [twoFactorCode, setTwoFactorCode] = useState('');
    const [mailboxPassword, setMailboxPassword] = useState('');
    const [hv, setHv] = useState<HvChallenge | null>(null);
    const [hvToken, setHvToken] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function doLogin(
        twoFactor: string | undefined,
        mailbox: string | undefined,
        humanVerificationToken: string | undefined,
    ) {
        setBusy(true);
        setError(null);
        try {
            const result = await login(username, password, twoFactor, mailbox, humanVerificationToken);
            if (result.authenticated) {
                onLogin(result.uid);
                return;
            }
            if (result.humanVerificationRequired) {
                setHv({ webUrl: result.webUrl, originalToken: result.humanVerificationToken });
                setHvToken('');
            } else if (result.twoFactorRequired) {
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

    function submit(e: FormEvent) {
        e.preventDefault();
        void doLogin(
            needsTwoFactor ? twoFactorCode : undefined,
            needsMailbox ? mailboxPassword : undefined,
            hvToken || undefined,
        );
    }

    async function copySnippet() {
        try {
            await navigator.clipboard.writeText(CAPTURE_SNIPPET);
        } catch {
            /* clipboard unavailable — user can select manually */
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
                    {hv && (
                        <div className="hv-box">
                            <p>
                                Proton flagged this sign-in and needs a quick human-verification (CAPTCHA). This is a
                                one-time step per account.
                            </p>
                            <ol className="hv-steps">
                                <li>
                                    Click <strong>Open verification</strong> below to open the CAPTCHA page.
                                </li>
                                <li>
                                    In that tab, open DevTools (<code>F12</code>) → <strong>Console</strong> and paste the
                                    snippet below <em>before</em> solving.
                                </li>
                                <li>Solve the CAPTCHA — the snippet pops up your token.</li>
                                <li>Paste the token back here and press <strong>Sign in</strong>.</li>
                            </ol>
                            <div className="hv-actions">
                                <button type="button" className="btn btn-primary" onClick={() => hv.webUrl && window.open(hv.webUrl, '_blank')}>
                                    Open verification ↗
                                </button>
                                <button type="button" className="btn btn-ghost" onClick={copySnippet}>
                                    Copy snippet
                                </button>
                            </div>
                            <pre className="hv-snippet">{CAPTURE_SNIPPET}</pre>
                            <label className="field">
                                <span>Verification token</span>
                                <input value={hvToken} onChange={(e) => setHvToken(e.target.value)} placeholder="paste the token from the verification tab" />
                            </label>
                        </div>
                    )}
                    {error && <div className="alert">{error}</div>}
                    <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
                        {busy ? 'Signing in…' : hv ? 'Continue' : 'Sign in'}
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
