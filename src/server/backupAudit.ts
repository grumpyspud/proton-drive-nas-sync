import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { configDir } from '../crypto/keySource';

/**
 * Append-only audit ledger for the backup file — who created it, who downloaded
 * it, and from which client. Stored SEPARATELY from the normal app log, and the
 * app only ever appends (never truncates/overwrites/deletes). It is intentionally
 * NOT part of the backup itself and is NOT touched by restore, so the evidence
 * trail survives a restore.
 */

export interface ClientFingerprint {
    ip: string;
    os: string;
    browser: string;
    browserVersion: string;
    deviceId: string;
}

export interface AuditEvent {
    event: 'created' | 'downloaded' | 'warning-acknowledged';
    ts: string; // ISO
    ip: string;
    ua: string;
    os: string;
    browser: string;
    browserVersion: string;
    deviceId: string;
    backupSha256?: string;
    backupSize?: number;
    mismatch?: boolean;
}

export interface BackupAuditState {
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

function auditPath(): string {
    return path.join(configDir(), 'backup-audit.log');
}

export function appendAuditEvent(ev: AuditEvent): void {
    const p = auditPath();
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(ev) + '\n', { mode: 0o600 });
}

export function readAuditEvents(): AuditEvent[] {
    const p = auditPath();
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const out: AuditEvent[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line) as AuditEvent);
        } catch {
            // skip a corrupt line rather than failing the whole read
        }
    }
    return out;
}

function parseUserAgent(ua: string): { os: string; browser: string; browserVersion: string } {
    let os = 'unknown';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    let browser = 'unknown';
    let browserVersion = 'unknown';
    if (/Edg\//.test(ua)) {
        browser = 'Edge';
        browserVersion = /Edg\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown';
    } else if (/OPR\//.test(ua)) {
        browser = 'Opera';
        browserVersion = /OPR\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown';
    } else if (/Chrome\//.test(ua)) {
        browser = 'Chrome';
        browserVersion = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown';
    } else if (/Firefox\//.test(ua)) {
        browser = 'Firefox';
        browserVersion = /Firefox\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown';
    } else if (/Version\//.test(ua) && /Safari\//.test(ua)) {
        browser = 'Safari';
        browserVersion = /Version\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown';
    }
    return { os, browser, browserVersion };
}

/** The device ID is a browser-generated UUID (a stand-in for a MAC address, which a web server cannot see). */
export function fingerprintFromRequest(req: Request): ClientFingerprint {
    const ua = req.headers['user-agent'] ?? '';
    const parsed = parseUserAgent(ua);
    return {
        ip: req.socket.remoteAddress ?? '',
        os: parsed.os,
        browser: parsed.browser,
        browserVersion: parsed.browserVersion,
        deviceId: (req.headers['x-pdn-device-id'] as string) ?? '',
    };
}

/** Identity used for mismatch detection — EXCLUDES browser version and time, per spec. */
export function fingerprintIdentity(fp: ClientFingerprint): string {
    return [fp.ip, fp.os, fp.browser, fp.deviceId].join('|');
}

export function computeAuditState(): BackupAuditState {
    const events = readAuditEvents();
    const state: BackupAuditState = {
        exists: false,
        createdAt: null,
        size: 0,
        sha256: '',
        creator: null,
        downloadCount: 0,
        lastDownload: null,
        lastDownloadAt: null,
        warningActive: false,
    };
    const createdIdx = events.reduce((acc, e, i) => (e.event === 'created' ? i : acc), -1);
    if (createdIdx < 0) return state;
    const created = events[createdIdx];
    if (!created) return state;

    state.exists = true;
    state.createdAt = created.ts;
    state.size = created.backupSize ?? 0;
    state.sha256 = created.backupSha256 ?? '';
    const creator: ClientFingerprint = {
        ip: created.ip,
        os: created.os,
        browser: created.browser,
        browserVersion: created.browserVersion,
        deviceId: created.deviceId,
    };
    state.creator = creator;
    const creatorId = fingerprintIdentity(creator);

    let warning = false;
    for (let i = createdIdx + 1; i < events.length; i++) {
        const e = events[i];
        if (!e) continue;
        if (e.event === 'downloaded') {
            state.downloadCount++;
            state.lastDownload = { ip: e.ip, os: e.os, browser: e.browser, browserVersion: e.browserVersion, deviceId: e.deviceId };
            state.lastDownloadAt = e.ts;
            warning = fingerprintIdentity(state.lastDownload) !== creatorId;
        } else if (e.event === 'warning-acknowledged') {
            if (fingerprintIdentity({ ip: e.ip, os: e.os, browser: e.browser, browserVersion: e.browserVersion, deviceId: e.deviceId }) === creatorId) {
                warning = false;
            }
        }
    }
    state.warningActive = warning;
    return state;
}
