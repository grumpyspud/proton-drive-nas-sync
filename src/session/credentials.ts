import { EventEmitter } from 'node:events';
import type { SessionCredentials, SessionInfo } from '../../vendor/proton-drive-sdk-account/sessionCredentials';

/**
 * In-memory session store for the M0 spike.
 *
 * Security note: for M0 nothing is persisted to disk — raw passwords are never
 * written, and the derived user key password lives only in process memory.
 * Encrypted-at-rest persistence (AES-256-GCM, keyed by a Docker secret) is the
 * M2 deliverable and will replace this class's `load()`/`setSessionInfo()`.
 */
export class InMemoryCredentials implements SessionCredentials {
    private readonly emitter = new EventEmitter();
    private _uid?: string;
    private _accessToken?: string;
    private _refreshToken?: string;
    private _userKeyPassword?: string;
    private _telemetryEnabled = true;

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
        // M0: no persistence. Replaced by encrypted session load in M2.
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this._userKeyPassword = userKeyPassword;
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this._uid = info.uid;
        this._accessToken = info.accessToken;
        this._refreshToken = info.refreshToken;
        this.emitter.emit('sessionInfoChanged');
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this._telemetryEnabled = enabled;
    }

    async signOut(): Promise<void> {
        this._uid = undefined;
        this._accessToken = undefined;
        this._refreshToken = undefined;
        this._userKeyPassword = undefined;
        this.emitter.emit('sessionInfoChanged');
    }
}
