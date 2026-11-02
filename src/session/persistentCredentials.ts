import { EventEmitter } from 'node:events';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionCredentials, SessionInfo } from '../../vendor/proton-drive-sdk-account/sessionCredentials';
import type { SecretBox } from '../crypto/secret';

export interface PersistentCredentialsOptions {
    filePath: string;
    secretBox: SecretBox;
}

interface PersistedSession {
    version: 1;
    uid: string;
    refreshToken?: string;
    userKeyPassword?: string;
    telemetryEnabled: boolean;
}

/**
 * SessionCredentials implementation that persists the session to an
 * AES-256-GCM encrypted blob. Raw login/2FA/mailbox passwords are NEVER stored
 * (they exist only in memory during sign-in); what persists is the derived
 * session state (refresh token + user key password) needed to resume.
 *
 * The access token is intentionally NOT persisted: it is short-lived and is
 * re-issued from the refresh token on resume.
 */
export class PersistentCredentials implements SessionCredentials {
    private readonly emitter = new EventEmitter();
    private _uid?: string;
    private _accessToken?: string;
    private _refreshToken?: string;
    private _userKeyPassword?: string;
    private _telemetryEnabled = true;
    // Persistence stays OFF until the user key password is set (login fully
    // completed) or a full session is loaded from disk. This keeps the scoped
    // pre-2FA refresh token off disk.
    private _persistEnabled = false;

    constructor(private readonly options: PersistentCredentialsOptions) {}

    get uid(): string | undefined {
        return this._uid;
    }

    get accessToken(): string | undefined {
        return this._accessToken;
    }

    get refreshToken(): string | undefined {
        return this._refreshToken;
    }

    on(event: 'sessionInfoChanged', callback: () => void): void {
        this.emitter.on(event, callback);
    }

    isLoggedIn(): boolean {
        return !!this._accessToken;
    }

    isTelemetryEnabled(): boolean {
        return this._telemetryEnabled;
    }

    getUserKeyPassword(): string | undefined {
        return this._userKeyPassword;
    }

    async load(): Promise<void> {
        try {
            const raw = await readFile(this.options.filePath, 'utf8');
            const decrypted = this.options.secretBox.decrypt(raw);
            const data = JSON.parse(decrypted) as PersistedSession;
            if (data.version !== 1) {
                throw new Error(`Unsupported session version: ${data.version}`);
            }
            this._uid = data.uid;
            this._refreshToken = data.refreshToken;
            this._userKeyPassword = data.userKeyPassword;
            this._telemetryEnabled = data.telemetryEnabled;
            this._persistEnabled = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return; // no persisted session: not an error
            }
            throw error;
        }
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this._userKeyPassword = userKeyPassword;
        // Login is now fully complete (2FA + key derivation done): arm persistence.
        this._persistEnabled = true;
        await this.persist();
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this._uid = info.uid;
        this._accessToken = info.accessToken;
        if (info.refreshToken !== undefined) {
            this._refreshToken = info.refreshToken;
        }
        this.emitter.emit('sessionInfoChanged');
        await this.persist();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this._telemetryEnabled = enabled;
        await this.persist();
    }

    async signOut(): Promise<void> {
        this._uid = undefined;
        this._accessToken = undefined;
        this._refreshToken = undefined;
        this._userKeyPassword = undefined;
        this.emitter.emit('sessionInfoChanged');
        await unlink(this.options.filePath).catch(() => {});
    }

    private async persist(): Promise<void> {
        if (!this._persistEnabled) {
            return; // not armed: a scoped pre-2FA session must never hit disk
        }
        if (!this._uid || !this._refreshToken) {
            return; // nothing durable to persist yet
        }
        const data: PersistedSession = {
            version: 1,
            uid: this._uid,
            refreshToken: this._refreshToken,
            userKeyPassword: this._userKeyPassword,
            telemetryEnabled: this._telemetryEnabled,
        };
        const encrypted = this.options.secretBox.encrypt(JSON.stringify(data));
        await mkdir(path.dirname(this.options.filePath), { recursive: true });
        await writeFile(this.options.filePath, encrypted, { mode: 0o600 });
    }
}
