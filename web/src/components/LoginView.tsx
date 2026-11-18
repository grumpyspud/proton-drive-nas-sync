import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cancelWebLogin, getWebLoginState, login, startWebLogin } from '../api';

const WEB_LOGIN_POLL_MS = 3000;

/**
 * Proton's human-verification (CAPTCHA) page posts the solved token back via
 * `window.parent.postMessage()`, which only works when embedded as an iframe ~
 * and verify.proton.me's CSP `frame-ancestors` only allows Proton's own origins.
 * So a third-party app cannot auto-receive it. This snippet, pasted into the
 * verification tab's devtools console BEFORE solving, captures the composite
 * token for manual entry.
 */
const CAPTURE_SNIPPET = `(function () {
  var done = false;
  function grab(t) {
    if (done || !t) return;
    done = true;
    console.log('PDN TOKEN (len ' + t.length + '):', t);
    try { navigator.clipboard.writeText(t); } catch (e) {}
    window.prompt('Your token (copy it):', t);
  }
  function read(data) {
    try {
      // verify.proton.me posts the envelope as a JSON STRING via JSON.stringify().
      var d = data;
      if (typeof d === 'string') d = JSON.parse(d);
      if (d && d.type === 'HUMAN_VERIFICATION_SUCCESS' && d.payload && d.payload.token) return d.payload.token;
      return null;
    } catch (e) { return null; }
  }
  window.addEventListener('message', function (e) { var t = read(e && e.data); if (t) grab(t); });
  try {
    var o = window.postMessage;
    window.postMessage = function (data) { var t = read(data); if (t) grab(t); return o.apply(this, arguments); };
  } catch (e) {}
})();`;

interface Props {
    onLogin: (uid?: string) => void;
    theme: 'dark' | 'light';
    onToggleTheme: () => void;
    appPasswordEnabled: boolean;
    onSetAppPassword: () => void;
    onRestore: () => void;
    authMethod: 'browser' | 'srp';
}

interface HvChallenge {
    webUrl?: string;
    originalToken?: string;
}

/**
 * Sign-in screen. Two modes, selected server-side by `PDN_AUTH_METHOD`:
 *   - `browser` (default): sign in on Proton's own website (account.proton.me);
 *     this app never sees the password, 2FA code or mailbox password.
 *   - `srp`: the original in-app username/password form (multi-step, with a
 *     CAPTCHA devtools-console step when Proton demands human verification).
 */
export function LoginView({ onLogin, theme, onToggleTheme, appPasswordEnabled, onSetAppPassword, onRestore, authMethod }: Props) {
    // ---- SRP form state ----
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
    const [needsMailbox, setNeedsMailbox] = useState(false);
    const [twoFactorCode, setTwoFactorCode] = useState('');
    const [mailboxPassword, setMailboxPassword] = useState('');
    const [hv, setHv] = useState<HvChallenge | null>(null);
    const [hvToken, setHvToken] = useState('');
    const [busy, setBusy] = useState(false);

    // ---- browser sign-in state ----
    const [webUrl, setWebUrl] = useState<string | null>(null);
    const [webBusy, setWebBusy] = useState(false);

    // ---- shared ----
    const [error, setError] = useState<string | null>(null);

    const onLoginRef = useRef(onLogin);
    onLoginRef.current = onLogin;

    // While a browser sign-in is pending, poll the server until Proton has
    // handed the app its session (or the link expired / was cancelled).
    useEffect(() => {
        if (!webUrl) return;
        let stopped = false;
        const tick = async () => {
            try {
                const state = await getWebLoginState();
                if (stopped) return;
                if (state.status === 'authenticated') {
                    stopped = true;
                    onLoginRef.current(state.uid);
                } else if (state.status !== 'pending') {
                    setWebUrl(null);
                    setError(
                        state.status === 'failed'
                            ? state.error === 'Authentication timed out'
                                ? 'The sign-in link expired. Start again.'
                                : (state.error ?? 'Sign-in failed')
                            : 'The sign-in was interrupted. Start again.',
                    );
                }
            } catch {
                /* transient network error: keep polling */
            }
        };
        const id = setInterval(() => void tick(), WEB_LOGIN_POLL_MS);
        return () => {
            stopped = true;
            clearInterval(id);
        };
    }, [webUrl]);

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
                setHv(null);
                setNeedsTwoFactor(true);
            } else if (result.mailboxPasswordRequired) {
                setHv(null);
                setNeedsTwoFactor(false);
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
            /* clipboard unavailable: user can select manually */
        }
    }

    async function startBrowserLogin() {
        setWebBusy(true);
        setError(null);
        try {
            const { signInUrl } = await startWebLogin();
            setWebUrl(signInUrl);
            // May be blocked as a popup; the "Open Proton sign-in" link is the fallback.
            window.open(signInUrl, '_blank', 'noopener,noreferrer');
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setWebBusy(false);
        }
    }

    async function stopBrowserLogin() {
        setWebUrl(null);
        try {
            await cancelWebLogin();
        } catch {
            /* the server drops it on its own after 10 minutes */
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

                {authMethod === 'srp' ? (
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
                                    <li>Solve the CAPTCHA: the snippet pops up your token.</li>
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
                ) : (
                    <div className="web-login">
                        <p className="web-login-intro">
                            Sign in on Proton&apos;s own website. Your password, two-factor code or security key, and mailbox
                            password are entered there, never in this app.
                        </p>
                        {webUrl ? (
                            <div className="hv-box">
                                <p>
                                    Finish signing in on the Proton page that opened. Keep this page open: it continues
                                    automatically. The link works for 10 minutes.
                                </p>
                                <p>
                                    Don&apos;t share the link: whoever signs in with it connects their Proton account to this app.
                                </p>
                                <div className="hv-actions">
                                    <a className="btn btn-primary" href={webUrl} target="_blank" rel="noopener noreferrer">
                                        Open Proton sign-in ↗
                                    </a>
                                    <button type="button" className="btn btn-ghost" onClick={() => void stopBrowserLogin()}>
                                        Cancel
                                    </button>
                                </div>
                                <p className="web-login-waiting">Waiting for Proton…</p>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="btn btn-primary btn-block"
                                onClick={() => void startBrowserLogin()}
                                disabled={webBusy}
                            >
                                {webBusy ? 'Preparing sign-in…' : 'Sign in with Proton ↗'}
                            </button>
                        )}
                        {error && <div className="alert web-login-error">{error}</div>}
                    </div>
                )}

                <div className="auth-secondary">
                    {appPasswordEnabled ? (
                        <button type="button" className="btn btn-ghost" onClick={onRestore}>
                            Restore config from backup
                        </button>
                    ) : (
                        <button type="button" className="btn btn-ghost" onClick={onSetAppPassword}>
                            Set app password
                        </button>
                    )}
                </div>

                <p className="disclaimer">
                    {authMethod === 'srp' ? (
                        <>Third-party application: not affiliated with, endorsed by, or supported by Proton AG. Your credentials are used only to authenticate with Proton Drive and are never stored in plaintext.</>
                    ) : (
                        <>Third-party application: not affiliated with, endorsed by, or supported by Proton AG. You sign in on Proton&apos;s own website; this app never sees your password.</>
                    )}
                </p>
            </div>
        </div>
    );
}
