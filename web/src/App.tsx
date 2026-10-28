import { useCallback, useEffect, useState } from 'react';
import { getAppAuthStatus, getAuthStatus, type AppAuthStatus } from './api';
import { Dashboard } from './components/Dashboard';
import { LoginView } from './components/LoginView';
import { AppLoginView } from './components/AppLoginView';

export type Theme = 'dark' | 'light';

interface AuthState {
    authenticated: boolean;
    uid?: string;
}

export function App() {
    const [appAuth, setAppAuth] = useState<AppAuthStatus | null>(null);
    const [auth, setAuth] = useState<AuthState | null>(null);
    const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') === 'light' ? 'light' : 'dark'));

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

    if (appAuth === null || auth === null) return <div className="splash">Loading…</div>;

    // Layer 1: the app password (when set) must be unlocked before anything else.
    if (appAuth.enabled && !appAuth.authenticated) {
        return (
            <AppLoginView
                theme={theme}
                onToggleTheme={toggleTheme}
                onUnlock={() => {
                    refreshAppAuth();
                    refreshProtonAuth();
                }}
            />
        );
    }

    // Layer 2: the Proton Drive login.
    if (!auth.authenticated) {
        return <LoginView theme={theme} onToggleTheme={toggleTheme} onLogin={(uid) => setAuth({ authenticated: true, uid })} />;
    }

    return (
        <Dashboard
            theme={theme}
            onToggleTheme={toggleTheme}
            uid={auth.uid}
            appAuthEnabled={appAuth.enabled}
            onAppAuthChanged={refreshAppAuth}
            onLogout={() => setAuth({ authenticated: false })}
        />
    );
}
