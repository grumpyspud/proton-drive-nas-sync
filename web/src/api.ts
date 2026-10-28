import type { DirListing, Pair, StorageInfo, SyncSummary, TrashItem } from './types';

function getDeviceId(): string {
    try {
        const key = 'pdn_device_id';
        let id = localStorage.getItem(key);
        if (!id) {
            id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            localStorage.setItem(key, id);
        }
        return id;
    } catch {
        return 'unknown';
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json', 'X-PDN-Device-Id': getDeviceId() },
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

export interface AppAuthStatus {
    enabled: boolean;
    authenticated: boolean;
}

export function getAppAuthStatus(): Promise<AppAuthStatus> {
    return request<AppAuthStatus>('/api/app/status');
}

export function appLogin(password: string): Promise<{ ok: boolean; enabled?: boolean }> {
    return request('/api/app/login', { method: 'POST', body: JSON.stringify({ password }) });
}

export function appLogout(): Promise<{ ok: boolean }> {
    return request('/api/app/logout', { method: 'POST' });
}

export function setAppPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; enabled?: boolean }> {
    return request('/api/app/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
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

export function getSyncStatus(): Promise<{ paused: boolean; syncing: boolean }> {
    return request('/api/sync/status');
}

export function setSyncPaused(paused: boolean): Promise<{ paused: boolean }> {
    return request('/api/sync/pause', { method: 'POST', body: JSON.stringify({ paused }) });
}

export function stopSync(): Promise<{ stopping: boolean }> {
    return request('/api/sync/stop', { method: 'POST' });
}

export function confirmDeletion(id: string): Promise<{ ok: boolean }> {
    return request(`/api/sync/${encodeURIComponent(id)}/confirm-deletion`, { method: 'POST' });
}

export function cancelDeletion(id: string): Promise<{ ok: boolean }> {
    return request(`/api/sync/${encodeURIComponent(id)}/cancel-deletion`, { method: 'POST' });
}

export interface LogQueryResult {
    lines: string[];
    total: number;
    truncated: boolean;
}

export function getLogs(q: string, limit: number, offset: number): Promise<LogQueryResult> {
    return request(`/api/logs?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`);
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

export interface ClientFingerprint {
    ip: string;
    os: string;
    browser: string;
    browserVersion: string;
    deviceId: string;
}

export interface BackupStatus {
    exists: boolean;
    createdAt: string | null;
    size: number;
    sha256: string;
    creator: ClientFingerprint | null;
    downloadCount: number;
    lastDownload: ClientFingerprint | null;
    lastDownloadAt: string | null;
    warningActive: boolean;
}

export function getBackupStatus(): Promise<BackupStatus> {
    return request<BackupStatus>('/api/backup/status');
}

export function createBackup(appPassword: string, passphrase: string, overwrite: boolean): Promise<{ ok: boolean; createdAt: string; size: number; sha256: string; hasSession: boolean }> {
    return request('/api/backup/create', { method: 'POST', body: JSON.stringify({ appPassword, passphrase, overwrite }) });
}

export async function downloadBackup(): Promise<void> {
    const res = await fetch('/api/backup/download', { headers: { 'X-PDN-Device-Id': getDeviceId() } });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'proton-drive-nas-sync-backup.pdnbak';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function acknowledgeBackupWarning(): Promise<{ ok: boolean }> {
    return request('/api/backup/acknowledge', { method: 'POST' });
}

export function restoreBackup(appPassword: string, passphrase: string, backup?: string): Promise<{ ok: boolean; resumed: boolean }> {
    return request('/api/restore', { method: 'POST', body: JSON.stringify({ appPassword, passphrase, backup }) });
}

export type { StorageInfo, SyncSummary };
