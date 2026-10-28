import type { DirListing, Pair, StorageInfo, SyncSummary, TrashItem } from './types';

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
    humanVerificationRequired?: boolean;
    webUrl?: string;
    humanVerificationToken?: string;
    methods?: string[];
    uid?: string;
    error?: string;
}

export function getAuthStatus(): Promise<AuthStatus> {
    return request<AuthStatus>('/api/auth/status');
}

export function login(username: string, password: string, twoFactorCode?: string, mailboxPassword?: string, humanVerificationToken?: string): Promise<LoginResult> {
    return request<LoginResult>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, twoFactorCode, mailboxPassword, humanVerificationToken }),
    });
}

export function logout(): Promise<{ ok: boolean }> {
    return request('/api/auth/logout', { method: 'POST' });
}

export function listPairs(): Promise<{ pairs: Pair[] }> {
    return request('/api/pairs');
}

export interface PairSettings {
    realTime?: boolean;
    autoSync?: boolean;
    intervalSeconds?: number;
}

export function addPair(localDir: string, driveFolderName: string, settings: PairSettings = {}): Promise<{ pair: Pair }> {
    return request('/api/pairs', { method: 'POST', body: JSON.stringify({ localDir, driveFolderName, ...settings }) });
}

export function updatePair(id: string, settings: PairSettings): Promise<{ pair: Pair }> {
    return request(`/api/pairs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(settings) });
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

export function mkdirLocal(parent: string, name: string): Promise<{ ok: boolean; path: string }> {
    return request<{ ok: boolean; path: string }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ parent, name }) });
}

export function listTrash(id: string): Promise<{ items: TrashItem[] }> {
    return request(`/api/pairs/${encodeURIComponent(id)}/trash`);
}

export function restoreTrashItem(id: string, ts: number, relPath: string): Promise<{ ok: boolean }> {
    return request(`/api/pairs/${encodeURIComponent(id)}/trash/restore`, { method: 'POST', body: JSON.stringify({ ts: String(ts), relPath }) });
}

export function deleteTrashItem(id: string, ts: number, relPath: string): Promise<{ ok: boolean }> {
    return request(`/api/pairs/${encodeURIComponent(id)}/trash/delete`, { method: 'POST', body: JSON.stringify({ ts: String(ts), relPath }) });
}

export function clearTrash(id: string): Promise<{ ok: boolean }> {
    return request(`/api/pairs/${encodeURIComponent(id)}/trash/clear`, { method: 'POST' });
}

export type { StorageInfo, SyncSummary };
