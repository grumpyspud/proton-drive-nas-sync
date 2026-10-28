import { useEffect, useState } from 'react';
import { getAuthStatus } from './api';
import { Dashboard } from './components/Dashboard';
import { LoginView } from './components/LoginView';

export function App() {
    const [auth, setAuth] = useState<{ authenticated: boolean; uid?: string } | null>(null);

    useEffect(() => {
        getAuthStatus()
            .then((s) => setAuth({ authenticated: s.authenticated, uid: s.uid }))
            .catch(() => setAuth({ authenticated: false }));
    }, []);

    if (auth === null) return <div className="splash">Loading…</div>;
    if (!auth.authenticated) return <LoginView onLogin={(uid) => setAuth({ authenticated: true, uid })} />;
    return <Dashboard uid={auth.uid} onLogout={() => setAuth({ authenticated: false })} />;
}
