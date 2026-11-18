import { useEffect, useRef, useState } from 'react';
import { cancelWebLogin, getWebLoginState, startWebLogin } from '../api';

const WEB_LOGIN_POLL_MS = 3000;

interface Props {
    onLogin: (uid?: string) => void;
    theme: 'dark' | 'light';
    onToggleTheme: () => void;
    appPasswordEnabled: boolean;
    onSetAppPassword: () => void;
    onRestore: () => void;
}

/**
 * Sign-in screen. Signing in happens only on Proton's own website
 * (account.proton.me): the server starts a browser sign-in ("session fork"),
 * this view opens the link and polls until Proton has handed the app its
 * session. The password, 2FA code and mailbox password never pass through
 * this app.
 */
export function LoginView({ onLogin, theme, onToggleTheme, appPasswordEnabled, onSetAppPassword, onRestore }: Props) {
    const [error, setError] = useState<string | null>(null);
    const [webUrl, setWebUrl] = useState<string | null>(null);
    const [webBusy, setWebBusy] = useState(false);

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
                    Third-party application: not affiliated with, endorsed by, or supported by Proton AG. You sign in on
                    Proton&apos;s own website; this app never sees your password.
                </p>
            </div>
        </div>
    );
}
