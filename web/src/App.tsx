import { useEffect, useState } from 'react';
import { getAuthStatus } from './api';
import { Dashboard } from './components/Dashboard';
import { LoginView } from './components/LoginView';

export type Theme = 'dark' | 'light';

export function App() {
    const [auth, setAuth] = useState<{ authenticated: boolean; uid?: string } | null>(null);
    const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') === 'light' ? 'light' : 'dark'));

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('theme', theme);
    }, [theme]);

    useEffect(() => {
        getAuthStatus()
            .then((s) => setAuth({ authenticated: s.authenticated, uid: s.uid }))
            .catch(() => setAuth({ authenticated: false }));
    }, []);

    const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

    if (auth === null) return <div className="splash">Loading…</div>;
    if (!auth.authenticated) {
        return <LoginView theme={theme} onToggleTheme={toggleTheme} onLogin={(uid) => setAuth({ authenticated: true, uid })} />;
    }
    return <Dashboard theme={theme} onToggleTheme={toggleTheme} uid={auth.uid} onLogout={() => setAuth({ authenticated: false })} />;
}
