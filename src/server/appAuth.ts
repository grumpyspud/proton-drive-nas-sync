import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir } from '../crypto/keySource';
import { logger } from '../logger';

/**
 * App-level password gate (a second layer on top of the Proton Drive login).
 *
 * The UI and every /api route: including the live SSE progress stream: are
 * reachable by anyone who can hit the port (Tailscale peer, LAN host). This
 * module adds a single self-hosted password that, when set, gates all of that.
 *
 * The password is stored ONLY as a scrypt hash (salt + hash, never plaintext)
 * in `<configDir>/app-auth.json`, alongside a random `sessionKey` used to sign
 * session cookies (HMAC) so sessions survive restarts but are all invalidated
 * by a password change.
 *
 * `PDN_APP_PASSWORD` is a bootstrap: it seeds the hash on FIRST run only. Once
 * a hash exists, in-app password changes are the source of truth and the env
 * var is ignored.
 */

interface AppAuthFile {
    kdf: 'scrypt';
    salt: string; // hex
    hash: string; // hex
    sessionKey: string; // hex (32 bytes)
}

const KEY_LEN = 64;
const SESSION_KEY_LEN = 32;

export const MIN_APP_PASSWORD_LENGTH = 6;

function appAuthPath(): string {
    return path.join(configDir(), 'app-auth.json');
}

function derive(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, KEY_LEN);
}

function verify(password: string, cfg: AppAuthFile): boolean {
    const expected = Buffer.from(cfg.hash, 'hex');
    const actual = derive(password, Buffer.from(cfg.salt, 'hex'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function makeConfig(password: string): AppAuthFile {
    const salt = randomBytes(16);
    return {
        kdf: 'scrypt',
        salt: salt.toString('hex'),
        hash: derive(password, salt).toString('hex'),
        sessionKey: randomBytes(SESSION_KEY_LEN).toString('hex'),
    };
}

function persist(cfg: AppAuthFile): void {
    const p = appAuthPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

let current: AppAuthFile | null = null;

export function isAppAuthEnabled(): boolean {
    return current !== null;
}

export function loadAppAuth(): void {
    const p = appAuthPath();
    if (existsSync(p)) {
        try {
            current = JSON.parse(readFileSync(p, 'utf8')) as AppAuthFile;
            return;
        } catch (err) {
            logger.error('Failed to read app-auth.json', err);
            current = null;
            return;
        }
    }
    const env = process.env.PDN_APP_PASSWORD;
    if (env) {
        current = makeConfig(env);
        try {
            persist(current);
        } catch (err) {
            logger.error('Failed to persist app-auth.json', err);
        }
    }
}

export function verifyAppPassword(password: string): boolean {
    return current !== null && verify(password, current);
}

export function setAppPassword(
    currentPassword: string | undefined,
    newPassword: string | undefined,
): { ok: boolean; error?: string } {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_APP_PASSWORD_LENGTH) {
        return { ok: false, error: `Password must be at least ${MIN_APP_PASSWORD_LENGTH} characters` };
    }
    // When a password is already set, require the current one to change it.
    if (current) {
        if (!currentPassword || !verify(currentPassword, current)) {
            return { ok: false, error: 'Current password is incorrect' };
        }
    }
    current = makeConfig(newPassword);
    try {
        persist(current);
    } catch (err) {
        logger.error('Failed to persist app-auth.json', err);
    }
    return { ok: true };
}

function sign(tokenId: string): string {
    return createHmac('sha256', Buffer.from(current!.sessionKey, 'hex')).update(tokenId).digest('hex');
}

/** Returns `<tokenId>.<hmac>`: self-validating across restarts. */
export function issueSessionToken(): string {
    const tokenId = randomBytes(16).toString('hex');
    return `${tokenId}.${sign(tokenId)}`;
}

export function isValidSession(token: string | undefined): boolean {
    if (!current || !token) return false;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return false;
    const tokenId = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!tokenId || !sig) return false;
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(sign(tokenId), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}
