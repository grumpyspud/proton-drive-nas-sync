import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getAppAuthStatus, getAuthStatus, type AppAuthStatus } from './api';
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
            .then((s) => setAuth({ authenticated: s.authenticated, uid: s.uid }))
            .catch(() => setAuth({ authenticated: false }));
    }, []);

    useEffect(() => {
        refreshAppAuth();
        refreshProtonAuth();
    }, [refreshAppAuth, refreshProtonAuth]);

    const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

    let view: ReactNode;
    if (appAuth === null || auth === null) {
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
