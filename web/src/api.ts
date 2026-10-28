import type { DirListing, Pair, StorageInfo, SyncSummary } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
    }
    return data as T;
}

export interface AuthStatus {
    authenticated: boolean;
    uid?: string;
}

export interface LoginResult {
    authenticated: boolean;
    twoFactorRequired?: boolean;
    mailboxPasswordRequired?: boolean;
    uid?: string;
    error?: string;
}

export function getAuthStatus(): Promise<AuthStatus> {
    return request<AuthStatus>('/api/auth/status');
}

export function login(username: string, password: string, twoFactorCode?: string, mailboxPassword?: string): Promise<LoginResult> {
    return request<LoginResult>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, twoFactorCode, mailboxPassword }),
    });
}

export function logout(): Promise<{ ok: boolean }> {
    return request('/api/auth/logout', { method: 'POST' });
}

export function listPairs(): Promise<{ pairs: Pair[] }> {
    return request('/api/pairs');
}

export function addPair(localDir: string, driveFolderName: string): Promise<{ pair: Pair }> {
    return request('/api/pairs', { method: 'POST', body: JSON.stringify({ localDir, driveFolderName }) });
}

export function removePair(id: string): Promise<{ ok: boolean }> {
    return request(`/api/pairs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function startSync(id: string): Promise<{ started: boolean }> {
    return request(`/api/sync/${encodeURIComponent(id)}`, { method: 'POST' });
}

export function getStorage(): Promise<StorageInfo> {
    return request<StorageInfo>('/api/storage');
}

export function listLocalDir(path: string): Promise<DirListing> {
    return request<DirListing>(`/api/fs/list?path=${encodeURIComponent(path)}`);
}

export function listDriveDir(path: string): Promise<DirListing> {
    return request<DirListing>(`/api/drive/list?path=${encodeURIComponent(path)}`);
}

export type { StorageInfo, SyncSummary };
