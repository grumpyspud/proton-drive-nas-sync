import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { appLogout, getAppAuthStatus, getAuthStatus, NetworkError, type AppAuthStatus } from './api';
import { Dashboard } from './components/Dashboard';
import { LoginView } from './components/LoginView';
import { AppLoginView } from './components/AppLoginView';
import { AppPasswordModal } from './components/AppPasswordModal';
import { RestoreModal } from './components/RestoreModal';

export type Theme = 'dark' | 'light';

interface AuthState {
    authenticated: boolean;
    uid?: string;
}

export function App() {
    const [appAuth, setAppAuth] = useState<AppAuthStatus | null>(null);
    const [auth, setAuth] = useState<AuthState | null>(null);
    const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') === 'light' ? 'light' : 'dark'));
    const [showSetPassword, setShowSetPassword] = useState(false);
    const [showRestore, setShowRestore] = useState(false);
    const [connectionError, setConnectionError] = useState(false);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('theme', theme);
    }, [theme]);

    const refreshAppAuth = useCallback(() => {
        getAppAuthStatus()
            .then((s) => setAppAuth({ enabled: s.enabled, authenticated: s.authenticated }))
            .catch(() => setAppAuth({ enabled: false, authenticated: true }));
    }, []);

    const refreshProtonAuth = useCallback(() => {
        getAuthStatus()
            .then((s) => {
                setConnectionError(false);
                setAuth({ authenticated: s.authenticated, uid: s.uid });
            })
            .catch((err) => {
                // A network failure is not a logout — don't drop the user to the
                // login screen just because the server was briefly unreachable.
                if (err instanceof NetworkError) {
                    setConnectionError(true);
                } else {
                    setAuth({ authenticated: false });
                }
            });
    }, []);

    useEffect(() => {
        refreshAppAuth();
        refreshProtonAuth();
    }, [refreshAppAuth, refreshProtonAuth]);

    const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

    let view: ReactNode;
    if (connectionError) {
        view = (
            <div className="splash">
                <p>Can't reach the server.</p>
                <p className="muted">Check your connection (e.g. Tailscale) and retry.</p>
                <button className="btn" onClick={() => { setConnectionError(false); refreshAppAuth(); refreshProtonAuth(); }}>Retry</button>
            </div>
        );
    } else if (appAuth === null || auth === null) {
        view = <div className="splash">Loading…</div>;
    } else if (appAuth.enabled && !appAuth.authenticated) {
        // Layer 1: app password set but not unlocked.
        view = (
            <AppLoginView
                theme={theme}
                onToggleTheme={toggleTheme}
                onUnlock={() => {
                    refreshAppAuth();
                    refreshProtonAuth();
                }}
                onRestore={() => setShowRestore(true)}
            />
        );
    } else if (!auth.authenticated) {
        // Layer 2: Proton login (set-password + restore available while logged out).
        view = (
            <LoginView
                theme={theme}
                onToggleTheme={toggleTheme}
                onLogin={(uid) => setAuth({ authenticated: true, uid })}
                appPasswordEnabled={appAuth.enabled}
                onSetAppPassword={() => setShowSetPassword(true)}
                onRestore={() => setShowRestore(true)}
            />
        );
    } else {
        view = (
            <Dashboard
                theme={theme}
                onToggleTheme={toggleTheme}
                uid={auth.uid}
                appAuthEnabled={appAuth.enabled}
                onSetAppPassword={() => setShowSetPassword(true)}
                onLock={async () => {
                    try {
                        await appLogout();
                    } catch {
                        /* cookie is cleared regardless of response */
                    }
                    refreshAppAuth();
                }}
                onLogout={() => setAuth({ authenticated: false })}
            />
        );
    }

    return (
        <>
            {view}
            {showSetPassword && (
                <AppPasswordModal hasPassword={appAuth?.enabled ?? false} onClose={() => setShowSetPassword(false)} onChanged={refreshAppAuth} />
            )}
            {showRestore && (
                <RestoreModal
                    onClose={() => setShowRestore(false)}
                    onRestored={() => {
                        setShowRestore(false);
                        refreshAppAuth();
                        refreshProtonAuth();
                    }}
                />
            )}
        </>
    );
}
