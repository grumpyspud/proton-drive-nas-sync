import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadMasterKey } from '../crypto/keySource';
import { DELTA_ENABLED, REALTIME_INTERVAL_SECONDS, FULL_SCAN_INTERVAL } from '../config';
import { listLocalDir, mkdirLocal } from '../fs/browse';
import { isReservedDirName } from '../fs/reserved';
import { dataMountPaths, isSafeLocalPath } from '../fs/volumes';
import { resolveTls, type TlsConfig } from './tls';
import { findFolder, findOrCreateFolderPath, mkdirDrive } from '../fs/folders';
import { nodeName } from '../fs/files';
import { listDevices } from '../fs/devices';
import { clearTrash, deleteTrashItem, listTrash, restoreTrashItem } from '../fs/trash';
import { NodeType } from '@protontech/drive-sdk';
import { syncOnce, SyncAbortedError, DEFAULT_TRANSFER_CONCURRENCY, MAX_TRANSFER_CONCURRENCY } from '../engine/sync';
import { syncDelta } from '../engine/delta';
import { diffLocal, localDiffEmpty, type LocalDiff } from '../engine/localDiff';
import { pollEvents } from '../proton/events';
import { mapEventsToTargets, type SyncTarget } from '../engine/mapping';
import { DeletionTripwireError } from '../engine/safety';
import { recycleDuplicates, scanDuplicates } from '../engine/duplicates';
import { resolveConflictKeep } from '../engine/conflicts';
import { sha1OfFile } from '../fs/files';
import type { ProgressHandler, SyncProgressEvent } from '../engine/progress';
import { logger } from '../logger';
import { SyncDB, type Pair } from '../state/syncDb';
import { authService } from './auth';
import { appendSyncLog, querySyncLog, syncLogPath } from './syncLog';
import { appendErrorLog, clearErrorLog, errorLogStatus, readErrorLog, setLastReset } from './errorLog';
import { isAppAuthEnabled, isValidSession, issueSessionToken, loadAppAuth, setAppPassword, verifyAppPassword } from './appAuth';
import { decryptBackup, describePassphrasePolicy, encryptBackup, isStrongPassphrase, type BackupPayload } from '../crypto/backup';
import { appendAuditEvent, computeAuditState, fingerprintFromRequest, fingerprintIdentity } from './backupAudit';
import { checkForUpdates, getVersionInfo, startUpdateCheck } from './versionCheck';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StorageUser {
    UsedSpace?: number;
    MaxSpace?: number;
    ProductUsedSpace?: { Drive?: number };
    Email?: string;
    DisplayName?: string | null;
    Name?: string | null;
}

interface PairBody {
    localDir?: string;
    driveFolderName?: string;
    dedupeEnabled?: boolean;
    dedupeMinBytes?: number;
}

function pairIdFor(localDir: string, driveFolderName: string): string {
    return createHash('sha256').update(`${localDir}\n${driveFolderName}`).digest('hex').slice(0, 16);
}

function devicePairId(localDir: string, deviceUid: string): string {
    return createHash('sha256').update(`device\n${localDir}\n${deviceUid}`).digest('hex').slice(0, 16);
}

function syncDbPath(): string {
    return process.env.PDN_STATE_DB ?? path.join(configDir(), 'sync.db');
}

function backupFilePath(): string {
    return path.join(configDir(), 'backup.pdnbak');
}

function writeFileAtomic(filePath: string, data: string | Buffer, mode = 0o600): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, filePath);
}

// ---- SSE broadcast: one sync at a time, many browser listeners ----
const listeners = new Set<Response>();
function broadcast(event: SyncProgressEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) {
        if (!res.destroyed && !res.writableEnded) res.write(data);
    }
    appendSyncLog(event);
    appendErrorLog(event);
}

// Per-file progress bars are only shown for files >= this size (bytes); 0 disables
// them entirely (the overall bar still shows). Overridable via PDN_PROGRESS_MIN_BYTES.
const PROGRESS_MIN_BYTES = (() => {
    const raw = process.env.PDN_PROGRESS_MIN_BYTES;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
})();

// Concurrent file transfers per sync cycle. Adjustable globally in the UI (persisted
// in the state DB settings table), seeded by PDN_TRANSFER_CONCURRENCY, defaulting to
// DEFAULT_TRANSFER_CONCURRENCY (3). Hard-capped at MAX_TRANSFER_CONCURRENCY (4) to stay
// clear of Proton rate-limiting.
const TRANSFER_CONCURRENCY_SETTING = 'transferConcurrency';

function clampTransferConcurrency(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(MAX_TRANSFER_CONCURRENCY, Math.max(1, Math.floor(n)));
}

const ENV_TRANSFER_CONCURRENCY = clampTransferConcurrency(process.env.PDN_TRANSFER_CONCURRENCY);

/** DB setting wins; then the env seed; then undefined (engine default 3). */
function getTransferConcurrency(db: SyncDB): number | undefined {
    const stored = db.getSetting(TRANSFER_CONCURRENCY_SETTING);
    if (stored !== null) return clampTransferConcurrency(stored) ?? ENV_TRANSFER_CONCURRENCY;
    return ENV_TRANSFER_CONCURRENCY;
}

const DEDUPE_MIN_BYTES_MIN = 1024;
const DEDUPE_MIN_BYTES_MAX = 10 * 1024 * 1024;

/** Clamp a user-supplied min-size for the duplicate scan: 0 = none, else 1 KB..10 MB. */
function clampDedupeMinBytes(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(DEDUPE_MIN_BYTES_MAX, Math.max(DEDUPE_MIN_BYTES_MIN, Math.round(value)));
}

let syncing = false;
let paused = false;
let stopRequested = false;
let syncingPairId: string | null = null;
/** Latch set by runSync when a sync does not complete cleanly (error/abort/tripwire). */
let lastSyncErrored = false;
const hashJobs = new Map<string, { total: number; done: number; hashed: number }>();

interface PendingDeletion {
    pairId: string;
    totalTracked: number;
    deletions: number;
    pct: number;
    thresholdPct: number;
    driveTrash: string[];
    localRecycle: string[];
}
let pendingDeletion: PendingDeletion | null = null;

/** Per-pair delta inputs assembled by the scheduler (Drive targets + local diff). */
interface DeltaInput {
    targets: SyncTarget[];
    localDiff: LocalDiff;
}

async function runSync(pairId: string, allowDeletions = false, delta: DeltaInput | null = null, restoreToDrive = false): Promise<boolean> {
    if (syncing || paused) return false;
    syncing = true;
    syncingPairId = pairId;
    stopRequested = false;
    pendingDeletion = null;
    const db = new SyncDB(syncDbPath());
    try {
        const pair = db.getPair(pairId);
        if (!pair) return false;

        const session = authService.getSession();
        // Re-resolve the Drive folder each cycle (robust against renames/recreates).
        // Device pairs point at a Computers device root folder (a stable uid that is
        // NOT under My Files), so they are never re-resolved: findOrCreateFolderPath
        // would create a bogus folder under My Files instead of the device folder.
        let driveFolderUid = pair.driveFolderUid;
        if (!pair.deviceUid) {
            const root = await session.sdk.getMyFilesRootFolder();
            driveFolderUid = await findOrCreateFolderPath(session.sdk, root.uid, pair.driveFolderName);
            db.upsertPair({ ...pair, driveFolderUid });
        }

        const onProgress: ProgressHandler = broadcast;
        const common = {
            sdk: session.sdk,
            pairId,
            localDir: pair.localDir,
            driveFolderUid,
            driveFolderName: pair.driveFolderName,
            db,
            onProgress,
            shouldAbort: () => paused || stopRequested,
            progressMinBytes: PROGRESS_MIN_BYTES,
            transferConcurrency: getTransferConcurrency(db),
            allowDeletions,
            restoreToDrive,
        };
        // Targeted delta first; fall back to the full walk when it can't resolve
        // every Drive target surgically (or no delta was supplied, e.g. manual
        // sync). A restore-to-drive always full-walks so it re-uploads the whole
        // local tree instead of only the delta's targeted subset.
        const summary = restoreToDrive
            ? await syncOnce(common)
            : delta
                ? ((await syncDelta({ ...common, targets: delta.targets, localDiff: delta.localDiff })) ?? (await syncOnce(common)))
                : await syncOnce(common);
        db.markSynced(pairId);
        broadcast({ type: 'sync-complete', pairId, summary });
        return true;
    } catch (error) {
        lastSyncErrored = true;
        if (error instanceof SyncAbortedError) {
            if (paused) broadcast({ type: 'sync-paused' });
            else broadcast({ type: 'sync-stopped' });
            return true;
        }
        if (error instanceof DeletionTripwireError) {
            pendingDeletion = { pairId, ...error.info };
            broadcast({ type: 'deletion-hold', pairId, ...error.info });
            return true;
        }
        logger.error('Sync failed', error);
        broadcast({ type: 'sync-error', message: (error as Error).message ?? String(error) });
        return true;
    } finally {
        syncing = false;
        syncingPairId = null;
        stopRequested = false;
        db.close();
    }
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// ---- app-level password gate helpers (cookies are parsed manually; no cookie-parser) ----
const SESSION_COOKIE = 'pdn_session';

function readCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            const raw = part.slice(i + 1).trim();
            try {
                return decodeURIComponent(raw);
            } catch {
                return raw;
            }
        }
    }
    return undefined;
}

function isSecureRequest(req: Request): boolean {
    const proto = req.headers['x-forwarded-proto'];
    return req.secure || (typeof proto === 'string' && proto === 'https');
}

function setSessionCookie(res: Response, token: string, req: Request): void {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=31536000'];
    if (isSecureRequest(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Response, req: Request): void {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (isSecureRequest(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function appAuthGate(req: Request, res: Response, next: NextFunction): void {
    if (!isAppAuthEnabled()) {
        next();
        return;
    }
    if (isValidSession(readCookie(req, SESSION_COOKIE))) {
        next();
        return;
    }
    res.status(401).json({ error: 'App authentication required' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- version / update check (unauthenticated; public release metadata only) ----
app.get('/api/version', (_req, res) => {
    const info = getVersionInfo();
    // Cold cache (first request before the startup check finished): kick a
    // background refresh so the next request reflects the latest release,
    // without blocking this one on a slow/offline GitHub API call.
    if (info.checkedAt == null) void checkForUpdates();
    res.json(info);
});

// ---- app password endpoints (unauthenticated; the gate itself is applied below) ----
loadAppAuth();

app.get('/api/app/status', (req, res) => {
    res.json({ enabled: isAppAuthEnabled(), authenticated: isValidSession(readCookie(req, SESSION_COOKIE)) });
});

app.post('/api/app/login', (req, res) => {
    if (!isAppAuthEnabled()) {
        res.json({ ok: true, enabled: false });
        return;
    }
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !verifyAppPassword(password)) {
        res.status(401).json({ error: 'Incorrect password' });
        return;
    }
    setSessionCookie(res, issueSessionToken(), req);
    res.json({ ok: true, enabled: true });
});

app.post('/api/app/logout', (req, res) => {
    clearSessionCookie(res, req);
    res.json({ ok: true });
});

app.post('/api/app/password', (req, res) => {
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const result = setAppPassword(currentPassword, newPassword);
    if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
    }
    setSessionCookie(res, issueSessionToken(), req);
    res.json({ ok: true, enabled: true });
});

// Restore is reachable while the app is locked / not yet Proton-logged-in, so it
// sits BEFORE the gate and self-validates from the appPassword + passphrase in the body.
app.post('/api/restore', async (req, res) => {
    if (!isAppAuthEnabled()) {
        res.status(400).json({ error: 'Set an app password before restoring' });
        return;
    }
    if (authService.isAuthenticated()) {
        res.status(409).json({ error: 'Sign out of Proton before restoring' });
        return;
    }
    const { appPassword, passphrase, backup } = (req.body ?? {}) as { appPassword?: string; passphrase?: string; backup?: string };
    if (!appPassword || !passphrase) {
        res.status(400).json({ error: 'appPassword and passphrase are required' });
        return;
    }
    if (!verifyAppPassword(appPassword)) {
        res.status(401).json({ error: 'Incorrect app password' });
        return;
    }
    let container: Buffer;
    if (backup) {
        try {
            container = Buffer.from(backup, 'base64');
        } catch {
            res.status(400).json({ error: 'Invalid backup data' });
            return;
        }
    } else {
        const p = backupFilePath();
        if (!existsSync(p)) {
            res.status(404).json({ error: 'No backup file on this server: upload one instead' });
            return;
        }
        container = readFileSync(p);
    }
    let payload: BackupPayload;
    try {
        payload = decryptBackup(container, appPassword, passphrase);
    } catch (err) {
        res.status(401).json({ error: (err as Error).message });
        return;
    }
    if (syncing) {
        res.status(409).json({ error: 'A sync is in progress: retry shortly' });
        return;
    }
    try {
        if (process.env.PDN_ENCRYPTION_KEY) {
            logger.warn('Restore wrote the backed-up master key to the keyfile, but PDN_ENCRYPTION_KEY is also set and will take precedence: ensure it matches the backed-up key.');
        }
        writeFileAtomic(path.join(configDir(), 'encryption.key'), payload.masterKey);
        const blobPath = path.join(configDir(), 'session.blob');
        if (payload.hasSession && payload.sessionBlob) {
            writeFileAtomic(blobPath, payload.sessionBlob);
        } else {
            rmSync(blobPath, { force: true });
        }
        writeFileAtomic(syncDbPath(), Buffer.from(payload.db, 'base64'));
        let resumed = false;
        if (payload.hasSession) {
            resumed = await authService.resume();
        }
        logger.info(`Restore complete (session ${resumed ? 'resumed' : 'not resumed'})`);
        res.json({ ok: true, resumed });
    } catch (err) {
        logger.error('Restore failed', err);
        res.status(500).json({ error: (err as Error).message });
    }
});

// Everything under /api registered after this point requires the app password
// (only when one is set; otherwise this is a no-op passthrough).
app.use('/api', appAuthGate);

app.get('/api/auth/status', async (_req, res) => {
    if (!authService.isAuthenticated()) await authService.resume();
    if (authService.isAuthenticated()) {
        res.json({ authenticated: true, uid: authService.getSession().credentials.uid });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const body = req.body ?? {};
    const { username, password, twoFactorCode, mailboxPassword, humanVerificationToken } = body as Record<string, string | undefined>;
    if (!username || !password) {
        res.status(400).json({ error: 'username and password are required' });
        return;
    }
    const result = await authService.login(username, password, twoFactorCode, mailboxPassword, humanVerificationToken);
    res.json(result);
});

class SyncBusyError extends Error {}

/**
 * Poll until no sync is running. Setting `stopRequested` makes an in-flight sync
 * throw at its next safe boundary (file / folder / deletion barrier), so this
 * normally resolves within seconds. Returns false if it is still running at the
 * deadline (e.g. a single very large file mid-transfer).
 */
function waitForSyncToStop(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            if (!syncing) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 100);
        };
        check();
    });
}

/**
 * Full sign-out. Stops all syncing, empties every pair's local `.pdn-trash`,
 * drops all pair/account sync state (pairs + nodes + dupe_ignored), then signs
 * out of Proton (which deletes the session blob and releases the crypto keys).
 *
 * The user's actual synced files are deliberately NOT touched: only the app's
 * own bookkeeping and its recycle bins. The `settings` table (a UI preference,
 * not account data) is preserved.
 */
async function signOutAndReset(): Promise<void> {
    // 1. Stop the scheduler and ask any in-flight sync to unwind at its next boundary.
    paused = true;
    stopRequested = true;
    const stopped = await waitForSyncToStop(30_000);
    if (!stopped) {
        // Don't wipe state underneath a running sync: restore and let the caller retry.
        paused = false;
        stopRequested = false;
        throw new SyncBusyError('A sync is still finishing: stop it and try again.');
    }

    // 2. Empty each pair's local trash, then drop its DB state.
    const db = new SyncDB(syncDbPath());
    try {
        for (const pair of db.listPairs()) {
            try {
                await clearTrash(pair.localDir);
            } catch (err) {
                // An unmounted/missing share must not block sign-out.
                logger.warn(`Sign out: could not clear local trash for ${pair.localDir}: ${(err as Error).message}`);
            }
            db.removePair(pair.id);
        }
        for (const ds of db.listDeviceSyncs()) db.removeDeviceSync(ds.id);
    } finally {
        db.close();
    }

    // 3. Sign out of Proton (releases the crypto keys), then make sure the
    //    persisted session blob is gone even if it was never resumed into memory
    //    (e.g. the server restarted and the UI never reloaded the session).
    await authService.logout();
    rmSync(path.join(configDir(), 'session.blob'), { force: true });

    // 4. Reset in-memory sync state so the next sign-in starts clean.
    paused = false;
    stopRequested = false;
    pendingDeletion = null;
    logger.info('Signed out: cleared all folder pairs and local trash');
}

// Sign out is destructive (it clears all pairs + trash), so require a live session
// like every other mutating route: an unauthenticated client must not be able to
// wipe sync state with a bare POST.
app.post('/api/auth/logout', requireAuth, async (_req, res) => {
    try {
        await signOutAndReset();
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof SyncBusyError) {
            res.status(409).json({ error: err.message });
            return;
        }
        logger.error('Sign out failed', err);
        res.status(500).json({ error: (err as Error).message });
    }
});

app.get('/api/storage', requireAuth, async (_req, res) => {
    try {
        const session = authService.getSession();
        const data = await session.accountApi.users();
        const user = (data as { User?: StorageUser }).User;
        if (!user) {
            res.status(502).json({ error: 'Storage info unavailable' });
            return;
        }
        const usedBytes = user.UsedSpace ?? 0;
        res.json({
            usedBytes,
            maxBytes: user.MaxSpace ?? 0,
            driveBytes: user.ProductUsedSpace?.Drive ?? usedBytes,
            email: user.Email ?? '',
            displayName: user.DisplayName ?? user.Name ?? '',
        });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to fetch storage' });
    }
});

// ---- local (NAS) storage usage: /data + any other mounted data volumes ----

interface LocalVolume {
    path: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
}

async function localVolumes(): Promise<LocalVolume[]> {
    const volumes: LocalVolume[] = [];
    for (const p of dataMountPaths()) {
        try {
            const st = await statfs(p);
            const total = st.blocks * st.bsize;
            if (total <= 0) continue;
            const free = st.bfree * st.bsize;
            volumes.push({ path: p, totalBytes: total, usedBytes: total - free, freeBytes: st.bavail * st.bsize });
        } catch {
            /* skip paths that aren't a real mount point or vanished */
        }
    }
    return volumes;
}

app.get('/api/storage/local', requireAuth, async (_req, res) => {
    try {
        res.json({ volumes: await localVolumes() });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to read local storage' });
    }
});

app.get('/api/fs/list', requireAuth, (req, res) => {
    const requested = (req.query.path as string) ?? '';
    try {
        res.json(listLocalDir(requested));
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

app.post('/api/fs/mkdir', requireAuth, (req, res) => {
    const { parent, name } = (req.body ?? {}) as { parent?: string; name?: string };
    try {
        res.json(mkdirLocal(parent ?? '', name ?? ''));
    } catch (error) {
        res.status(400).json({ error: (error as Error).message });
    }
});

app.get('/api/drive/list', requireAuth, async (req, res) => {
    try {
        const session = authService.getSession();
        const root = await session.sdk.getMyFilesRootFolder();
        const namePath = (req.query.path as string) ?? '';

        // Walk from My Files root to the folder at namePath.
        const segments = namePath.split('/').map((s) => s.trim()).filter(Boolean);
        let parentUid = root.uid;
        for (const segment of segments) {
            const uid = await findFolder(session.sdk, parentUid, segment);
            if (!uid) {
                res.status(404).json({ error: `Folder "${segment}" not found` });
                return;
            }
            parentUid = uid;
        }

        const folders: { name: string; path: string }[] = [];
        for await (const child of session.sdk.iterateFolderChildren(parentUid)) {
            if (child.type === NodeType.Folder) {
                const name = nodeName(child.name);
                if (isReservedDirName(name)) continue;
                folders.push({ name, path: segments.length ? `${namePath}/${name}` : name });
            }
        }
        folders.sort((a, b) => a.name.localeCompare(b.name));

        const parent = segments.length ? segments.slice(0, -1).join('/') : null;
        res.json({ path: namePath, root: 'My Files', parent, folders });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to list Drive folders' });
    }
});

app.post('/api/drive/mkdir', requireAuth, async (req, res) => {
    const { parent, name } = (req.body ?? {}) as { parent?: string; name?: string };
    try {
        const sdk = authService.getSession().sdk;
        res.json(await mkdirDrive(sdk, parent ?? '', name ?? ''));
    } catch (error) {
        res.status(400).json({ error: (error as Error).message ?? 'Failed to create folder' });
    }
});

app.get('/api/devices', requireAuth, async (_req, res) => {
    try {
        const sdk = authService.getSession().sdk;
        res.json({ devices: await listDevices(sdk) });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to list devices' });
    }
});

app.get('/api/drive/trash', requireAuth, async (_req, res) => {
    try {
        const sdk = authService.getSession().sdk;
        const items: Array<{ uid: string; name: string; kind: 'file' | 'folder'; size: number | null; trashedAt: number | null }> = [];
        // iterateTrashedNodes is deprecated but yields fully decrypted nodes (name, type, size) in one pass.
        for await (const node of sdk.iterateTrashedNodes()) {
            const kind = node.type === NodeType.Folder ? 'folder' : 'file';
            items.push({
                uid: node.uid,
                name: nodeName(node.name),
                kind,
                size: kind === 'file' ? (node.activeRevision?.claimedSize ?? node.totalStorageSize ?? null) : null,
                trashedAt: node.trashTime ? node.trashTime.getTime() : null,
            });
        }
        items.sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0) || a.name.localeCompare(b.name));
        res.json({ items });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to list Drive trash' });
    }
});

app.post('/api/drive/trash/restore', requireAuth, async (req, res) => {
    const uid = (req.body as { uid?: string } | undefined)?.uid;
    if (!uid) {
        res.status(400).json({ error: 'uid is required' });
        return;
    }
    try {
        const sdk = authService.getSession().sdk;
        for await (const result of sdk.restoreNodes([uid])) {
            if (!result.ok) {
                res.status(502).json({ error: (result as { error?: { message?: string } }).error?.message ?? 'Failed to restore item' });
                return;
            }
        }
        res.json({ ok: true });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to restore item' });
    }
});

app.post('/api/drive/trash/delete', requireAuth, async (req, res) => {
    const uid = (req.body as { uid?: string } | undefined)?.uid;
    if (!uid) {
        res.status(400).json({ error: 'uid is required' });
        return;
    }
    try {
        const sdk = authService.getSession().sdk;
        for await (const result of sdk.deleteNodes([uid])) {
            if (!result.ok) {
                res.status(502).json({ error: (result as { error?: { message?: string } }).error?.message ?? 'Failed to delete item' });
                return;
            }
        }
        res.json({ ok: true });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to delete item' });
    }
});

app.post('/api/drive/trash/clear', requireAuth, async (_req, res) => {
    try {
        await authService.getSession().sdk.emptyTrash();
        res.json({ ok: true });
    } catch (error) {
        res.status(502).json({ error: (error as Error).message ?? 'Failed to empty trash' });
    }
});

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!authService.isAuthenticated()) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    next();
}

app.get('/api/settings', requireAuth, (_req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        res.json({ transferConcurrency: getTransferConcurrency(db) ?? DEFAULT_TRANSFER_CONCURRENCY });
    } finally {
        db.close();
    }
});

app.put('/api/settings', requireAuth, (req, res) => {
    const raw = (req.body ?? {}).transferConcurrency;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TRANSFER_CONCURRENCY) {
        res.status(400).json({ error: `transferConcurrency must be an integer between 1 and ${MAX_TRANSFER_CONCURRENCY}` });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        db.setSetting(TRANSFER_CONCURRENCY_SETTING, String(n));
    } finally {
        db.close();
    }
    res.json({ transferConcurrency: n });
});

app.get('/api/pairs', requireAuth, (_req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        // Device pairs are surfaced under /api/device-syncs, not as folder pairs.
        res.json({ pairs: db.listPairs().filter((p) => p.deviceUid === null) });
    } finally {
        db.close();
    }
});

app.post('/api/pairs', requireAuth, async (req, res) => {
    const { localDir, driveFolderName, dedupeEnabled, dedupeMinBytes } = (req.body ?? {}) as PairBody;
    if (!localDir) {
        res.status(400).json({ error: 'localDir is required' });
        return;
    }
    if (!isSafeLocalPath(localDir)) {
        const vols = dataMountPaths().join(', ');
        res.status(400).json({ error: `Local folder must be inside a mounted volume (${vols}). "${localDir}" is inside the container and would be lost on rebuild.` });
        return;
    }
    const driveFolder = driveFolderName ?? '';
    const db = new SyncDB(syncDbPath());
    try {
        const session = authService.getSession();
        const root = await session.sdk.getMyFilesRootFolder();
        const driveFolderUid = await findOrCreateFolderPath(session.sdk, root.uid, driveFolder);
        const pair: Pair = {
            id: pairIdFor(localDir, driveFolder),
            localDir,
            driveFolderName: driveFolder,
            driveFolderUid,
            lastSyncAt: null,
            dedupeEnabled: !!dedupeEnabled,
            dedupeMinBytes: clampDedupeMinBytes(dedupeMinBytes),
            deviceUid: null,
            deviceSyncId: null,
        };
        db.upsertPair(pair);
        res.json({ pair });
    } finally {
        db.close();
    }
});

app.patch('/api/pairs/:id', requireAuth, (req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        const pair = db.getPair(req.params.id as string);
        if (!pair) {
            res.status(404).json({ error: 'Pair not found' });
            return;
        }
        const body = (req.body ?? {}) as PairBody;
        const updated: Pair = {
            ...pair,
            dedupeEnabled: typeof body.dedupeEnabled === 'boolean' ? body.dedupeEnabled : pair.dedupeEnabled,
            dedupeMinBytes: body.dedupeMinBytes !== undefined ? clampDedupeMinBytes(body.dedupeMinBytes) : pair.dedupeMinBytes,
        };
        db.upsertPair(updated);
        res.json({ pair: updated });
    } finally {
        db.close();
    }
});

app.delete('/api/pairs/:id', requireAuth, (req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        db.removePair(req.params.id as string);
        res.json({ ok: true });
    } finally {
        db.close();
    }
});

function getPairOrNull(id: string): Pair | undefined {
    const db = new SyncDB(syncDbPath());
    try {
        return db.getPair(id);
    } finally {
        db.close();
    }
}

interface DeviceSyncBody {
    localDir?: string;
    deviceUids?: string[];
    autoAddRemove?: boolean;
}

// ---- device syncs (a local folder mirrored to N Computers device root folders) ----

app.get('/api/device-syncs', requireAuth, (_req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        const syncs = db.listDeviceSyncs().map((s) => ({
            ...s,
            devices: db.listDeviceSyncPairs(s.id).map((p) => ({
                pairId: p.id,
                deviceUid: p.deviceUid,
                name: p.driveFolderName,
                lastSyncAt: p.lastSyncAt,
            })),
        }));
        res.json({ syncs });
    } finally {
        db.close();
    }
});

app.post('/api/device-syncs', requireAuth, async (req, res) => {
    const { localDir, deviceUids, autoAddRemove } = (req.body ?? {}) as DeviceSyncBody;
    if (!localDir || !isSafeLocalPath(localDir)) {
        const vols = dataMountPaths().join(', ');
        res.status(400).json({ error: `Local folder must be inside a mounted volume (${vols}).` });
        return;
    }
    const uids = [...new Set(deviceUids ?? [])];
    if (uids.length === 0) {
        res.status(400).json({ error: 'Select at least one device.' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const session = authService.getSession();
        const devices = await listDevices(session.sdk);
        const byUid = new Map(devices.map((d) => [d.uid, d]));
        const missing = uids.filter((u) => !byUid.has(u));
        if (missing.length > 0) {
            res.status(400).json({ error: `Unknown device(s): ${missing.join(', ')}` });
            return;
        }
        // A device may belong to at most one device sync.
        const claimed = db.listPairs().filter((p) => p.deviceUid && uids.includes(p.deviceUid));
        if (claimed.length > 0) {
            res.status(409).json({ error: `${claimed.length} selected device(s) already belong to another device sync.` });
            return;
        }
        // At most one device sync may enable auto add/remove.
        if (autoAddRemove && db.listDeviceSyncs().some((s) => s.autoAddRemove)) {
            res.status(409).json({ error: 'Another device sync already has auto add/remove enabled.' });
            return;
        }

        const syncId = randomUUID();
        for (const uid of uids) {
            const dev = byUid.get(uid)!;
            db.upsertPair({
                id: devicePairId(localDir, uid),
                localDir,
                driveFolderName: dev.name,
                driveFolderUid: dev.rootFolderUid,
                lastSyncAt: null,
                dedupeEnabled: false,
                dedupeMinBytes: 0,
                deviceUid: uid,
                deviceSyncId: syncId,
            });
        }
        const sync = { id: syncId, localDir, autoAddRemove: !!autoAddRemove, createdAt: Date.now() };
        db.upsertDeviceSync(sync);
        res.json({ sync });
    } finally {
        db.close();
    }
});

app.delete('/api/device-syncs/:id', requireAuth, (req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        db.removeDeviceSync(req.params.id as string);
        res.json({ ok: true });
    } finally {
        db.close();
    }
});

app.get('/api/pairs/:id/trash', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    try {
        res.json({ items: listTrash(pair.localDir) });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
});

app.post('/api/pairs/:id/trash/restore', requireAuth, async (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const { ts, relPath } = (req.body ?? {}) as { ts?: string; relPath?: string };
    if (!ts || !relPath) {
        res.status(400).json({ error: 'ts and relPath are required' });
        return;
    }
    try {
        const restoredTo = await restoreTrashItem(pair.localDir, ts, relPath);
        res.json({ ok: true, restoredTo });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
});

app.post('/api/pairs/:id/trash/delete', requireAuth, async (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const { ts, relPath } = (req.body ?? {}) as { ts?: string; relPath?: string };
    if (!ts || !relPath) {
        res.status(400).json({ error: 'ts and relPath are required' });
        return;
    }
    try {
        await deleteTrashItem(pair.localDir, ts, relPath);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
});

app.post('/api/pairs/:id/trash/clear', requireAuth, async (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    try {
        await clearTrash(pair.localDir);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
});

const DEDUPE_MIN_BYTES = new Set([0, 1024, 10240, 102400, 1048576, 10485760]);

app.get('/api/pairs/:id/duplicates', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    let minBytes = 0;
    if (req.query.minBytes !== undefined) {
        const raw = Number(req.query.minBytes);
        if (!Number.isInteger(raw) || !DEDUPE_MIN_BYTES.has(raw)) {
            res.status(400).json({ error: 'Invalid minBytes' });
            return;
        }
        minBytes = raw;
    }
    const db = new SyncDB(syncDbPath());
    try {
        res.json({ groups: scanDuplicates(db, pair.id, pair.localDir, minBytes) });
    } finally {
        db.close();
    }
});

// Backfill content hashes for files pulled from Drive before the streaming-hash
// change (local_sha1 NULL). Runs FIRE-AND-FORGET in the background when the user
// starts a dedupe scan: the POST returns immediately and the job streams
// `hash-progress`/`hash-complete`/`hash-cancelled` over SSE, so the button shows
// progress without holding the request open. A sync starting for the same pair
// cancels the job via the `syncingPairId` checks below: the sync re-hashes what it
// needs, and a concurrent backfill could otherwise write a stale hash over a
// freshly re-downloaded file.
async function runHashBackfill(pairId: string, localDir: string): Promise<void> {
    const db = new SyncDB(syncDbPath());
    try {
        const nodes = db.listNodesWithNullSha1(pairId);
        const job = { total: nodes.length, done: 0, hashed: 0 };
        hashJobs.set(pairId, job);
        for (const node of nodes) {
            if (syncingPairId === pairId) {
                broadcast({ type: 'hash-cancelled', pairId });
                return;
            }
            const absPath = path.join(localDir, node.relPath);
            let sha1: string | null = null;
            let size = 0;
            let mtimeMs = 0;
            try {
                const st = await stat(absPath);
                sha1 = await sha1OfFile(absPath);
                size = st.size;
                mtimeMs = st.mtimeMs;
            } catch {
                // missing or unreadable: leave its hash null; a later sync re-hashes it
            }
            if (syncingPairId === pairId) {
                broadcast({ type: 'hash-cancelled', pairId });
                return;
            }
            if (sha1 !== null) {
                db.upsertNode({ ...node, localSha1: sha1, localSize: size, localMtime: mtimeMs });
                job.hashed++;
            }
            job.done++;
            broadcast({ type: 'hash-progress', pairId, done: job.done, total: job.total });
        }
        broadcast({ type: 'hash-complete', pairId, hashed: job.hashed, total: job.total });
    } finally {
        hashJobs.delete(pairId);
        db.close();
    }
}

app.post('/api/pairs/:id/hash-missing', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    if (syncingPairId === pair.id) {
        res.status(409).json({ error: 'A sync is in progress for this pair: retry after it finishes.' });
        return;
    }
    if (hashJobs.has(pair.id)) {
        res.json({ total: hashJobs.get(pair.id)!.total, alreadyRunning: true });
        return;
    }
    void runHashBackfill(pair.id, pair.localDir);
    res.json({ started: true });
});

app.post('/api/pairs/:id/duplicates/ignore', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const { relPaths } = (req.body ?? {}) as { relPaths?: string[] };
    if (!Array.isArray(relPaths) || relPaths.length === 0) {
        res.status(400).json({ error: 'relPaths must be a non-empty array' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        db.ignorePaths(pair.id, relPaths);
        res.json({ ok: true, ignored: relPaths.length });
    } finally {
        db.close();
    }
});

app.get('/api/pairs/:id/duplicates/ignored', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        res.json({ groups: db.ignoredGroups(pair.id) });
    } finally {
        db.close();
    }
});

app.post('/api/pairs/:id/duplicates/unignore', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const { relPaths } = (req.body ?? {}) as { relPaths?: string[] };
    if (!Array.isArray(relPaths) || relPaths.length === 0) {
        res.status(400).json({ error: 'relPaths must be a non-empty array' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const n = db.unignorePaths(pair.id, relPaths);
        res.json({ ok: true, unignored: n });
    } finally {
        db.close();
    }
});

app.post('/api/pairs/:id/duplicates/ignored/reset', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const n = db.clearIgnoredPaths(pair.id);
        res.json({ ok: true, unignored: n });
    } finally {
        db.close();
    }
});

app.post('/api/pairs/:id/duplicates/recycle', requireAuth, async (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const { relPaths } = (req.body ?? {}) as { relPaths?: string[] };
    if (!Array.isArray(relPaths) || relPaths.length === 0) {
        res.status(400).json({ error: 'relPaths must be a non-empty array' });
        return;
    }
    if (syncing) {
        res.status(409).json({ error: 'A sync is in progress: wait for it to finish' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const recycled = await recycleDuplicates(db, pair.id, pair.localDir, relPaths);
        res.json({ ok: true, recycled });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    } finally {
        db.close();
    }
});

app.get('/api/pairs/:id/conflicts', requireAuth, (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const conflicts = db.listConflicts(pair.id).filter((c) => {
            if (existsSync(path.join(pair.localDir, c.conflictPath))) return true;
            db.removeConflict(pair.id, c.conflictPath); // stale copy gone: drop the record
            return false;
        });
        res.json({ conflicts });
    } finally {
        db.close();
    }
});

app.post('/api/pairs/:id/conflicts/resolve', requireAuth, async (req, res) => {
    const pair = getPairOrNull(req.params.id as string);
    if (!pair) {
        res.status(404).json({ error: 'Pair not found' });
        return;
    }
    const { conflictPath, keep } = (req.body ?? {}) as { conflictPath?: string; keep?: string };
    if (typeof conflictPath !== 'string' || (keep !== 'local' && keep !== 'drive')) {
        res.status(400).json({ error: 'conflictPath (string) and keep ("local" | "drive") are required' });
        return;
    }
    if (syncing) {
        res.status(409).json({ error: 'A sync is in progress: wait for it to finish' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const conflict = db.getConflict(pair.id, conflictPath);
        if (!conflict) {
            res.status(404).json({ error: 'Conflict not found' });
            return;
        }
        await resolveConflictKeep(db, authService.getSession().sdk, pair.id, pair.localDir, conflict, keep);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    } finally {
        db.close();
    }
});

app.get('/api/sync/status', requireAuth, (_req, res) => {
    res.json({ paused, syncing });
});

app.post('/api/sync/pause', requireAuth, (req, res) => {
    const next = !!((req.body ?? {}) as { paused?: boolean }).paused;
    if (next !== paused) {
        paused = next;
        broadcast({ type: next ? 'sync-paused' : 'sync-resumed' });
    }
    res.json({ paused });
});

app.post('/api/sync/stop', requireAuth, (_req, res) => {
    if (syncing) {
        stopRequested = true;
        res.json({ stopping: true });
    } else {
        res.json({ stopping: false });
    }
});

app.post('/api/sync/:id', requireAuth, async (req, res) => {
    if (paused) {
        res.status(409).json({ started: false, paused: true, error: 'Syncing is paused' });
        return;
    }
    const started = await runSync(req.params.id as string);
    if (!started) {
        res.status(409).json({ error: 'Sync already in progress or pair not found' });
        return;
    }
    res.json({ started: true });
});

app.post('/api/sync/:id/confirm-deletion', requireAuth, (req, res) => {
    const pd = pendingDeletion;
    if (!pd || pd.pairId !== req.params.id) {
        res.status(404).json({ error: 'No pending deletion to confirm' });
        return;
    }
    pendingDeletion = null;
    broadcast({ type: 'deletion-confirmed' });
    res.json({ ok: true });
    void runSync(req.params.id as string, true);
});

app.post('/api/sync/:id/cancel-deletion', requireAuth, (req, res) => {
    if (pendingDeletion && pendingDeletion.pairId === req.params.id) {
        pendingDeletion = null;
        broadcast({ type: 'deletion-cancelled' });
    }
    res.json({ ok: true });
});

app.post('/api/sync/:id/restore-to-drive', requireAuth, (req, res) => {
    const pd = pendingDeletion;
    if (!pd || pd.pairId !== req.params.id) {
        res.status(404).json({ error: 'No pending deletion to restore' });
        return;
    }
    pendingDeletion = null;
    broadcast({ type: 'deletion-restoring' });
    res.json({ ok: true });
    void runSync(req.params.id as string, false, null, true);
});

app.get('/api/logs', requireAuth, (req, res) => {
    const q = (req.query.q as string) ?? '';
    const limit = Number.parseInt((req.query.limit as string) ?? '500', 10);
    const offset = Number.parseInt((req.query.offset as string) ?? '0', 10);
    res.json(querySyncLog({ q, limit: Number.isFinite(limit) ? limit : 500, offset: Number.isFinite(offset) ? offset : 0 }));
});

app.get('/api/logs/download', requireAuth, (_req, res) => {
    const p = syncLogPath();
    if (!existsSync(p)) {
        res.status(404).json({ error: 'No log file yet' });
        return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sync.log"');
    createReadStream(p).pipe(res);
});

// ---- error log: errors / conflicts / warnings only (survives rotation) ----

app.get('/api/errorlog/status', requireAuth, (_req, res) => {
    res.json(errorLogStatus());
});

app.get('/api/errorlog', requireAuth, (_req, res) => {
    res.json({ entries: readErrorLog() });
});

app.post('/api/errorlog/reset', requireAuth, (_req, res) => {
    setLastReset(Date.now());
    res.json({ ok: true });
});

app.post('/api/errorlog/clear', requireAuth, (_req, res) => {
    clearErrorLog();
    res.json({ ok: true });
});

app.get('/api/errorlog/download', requireAuth, (_req, res) => {
    const entries = readErrorLog();
    const body = entries
        .map((e) => `[${new Date(e.ts).toISOString()}] [${e.severity.toUpperCase()}] ${e.message}`)
        .join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="error-log-${new Date().toISOString().slice(0, 10)}.txt"`);
    res.send(body);
});

// ---- encrypted backup config (create / download / status / acknowledge) ----

app.get('/api/backup/status', (_req, res) => {
    res.json(computeAuditState());
});

app.post('/api/backup/create', requireAuth, (req, res) => {
    const { appPassword, passphrase, overwrite } = (req.body ?? {}) as { appPassword?: string; passphrase?: string; overwrite?: boolean };
    if (!appPassword) {
        res.status(400).json({ error: 'Enter your current app password' });
        return;
    }
    if (!verifyAppPassword(appPassword)) {
        res.status(401).json({ error: 'Incorrect app password' });
        return;
    }
    if (!passphrase || !isStrongPassphrase(passphrase)) {
        res.status(400).json({ error: describePassphrasePolicy() });
        return;
    }
    const bp = backupFilePath();
    if (existsSync(bp) && !overwrite) {
        res.status(409).json({ error: 'A backup already exists', exists: true });
        return;
    }
    if (syncing) {
        res.status(409).json({ error: 'A sync is in progress: wait for it to finish' });
        return;
    }
    const dbPath = syncDbPath();
    const dbBytes = existsSync(dbPath) ? readFileSync(dbPath) : Buffer.alloc(0);
    const blobPath = path.join(configDir(), 'session.blob');
    const hasSession = existsSync(blobPath);
    const sessionBlob = hasSession ? readFileSync(blobPath, 'utf8') : null;
    const payload: BackupPayload = {
        version: 1,
        createdAt: new Date().toISOString(),
        hasSession,
        db: dbBytes.toString('base64'),
        sessionBlob,
        masterKey: loadMasterKey().toString('hex'),
    };
    const container = encryptBackup(payload, appPassword, passphrase);
    writeFileAtomic(bp, container);
    const sha = createHash('sha256').update(container).digest('hex');
    const fp = fingerprintFromRequest(req);
    appendAuditEvent({
        event: 'created',
        ts: new Date().toISOString(),
        ip: fp.ip,
        ua: req.headers['user-agent'] ?? '',
        os: fp.os,
        browser: fp.browser,
        browserVersion: fp.browserVersion,
        deviceId: fp.deviceId,
        backupSha256: sha,
        backupSize: container.length,
    });
    logger.info(`Backup created (${container.length} bytes, sha256 ${sha})`);
    res.json({ ok: true, createdAt: payload.createdAt, size: container.length, sha256: sha, hasSession });
});

app.get('/api/backup/download', (req, res) => {
    const bp = backupFilePath();
    if (!existsSync(bp)) {
        res.status(404).json({ error: 'No backup file yet' });
        return;
    }
    const state = computeAuditState();
    const fp = fingerprintFromRequest(req);
    const mismatch = state.creator ? fingerprintIdentity(fp) !== fingerprintIdentity(state.creator) : false;
    appendAuditEvent({
        event: 'downloaded',
        ts: new Date().toISOString(),
        ip: fp.ip,
        ua: req.headers['user-agent'] ?? '',
        os: fp.os,
        browser: fp.browser,
        browserVersion: fp.browserVersion,
        deviceId: fp.deviceId,
        mismatch,
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="proton-drive-nas-sync-backup.pdnbak"');
    createReadStream(bp).pipe(res);
});

app.post('/api/backup/acknowledge', (req, res) => {
    const state = computeAuditState();
    if (!state.creator) {
        res.status(404).json({ error: 'No backup exists' });
        return;
    }
    const fp = fingerprintFromRequest(req);
    if (fingerprintIdentity(fp) !== fingerprintIdentity(state.creator)) {
        res.status(403).json({ error: 'Only the client that created the backup can clear this warning' });
        return;
    }
    appendAuditEvent({
        event: 'warning-acknowledged',
        ts: new Date().toISOString(),
        ip: fp.ip,
        ua: req.headers['user-agent'] ?? '',
        os: fp.os,
        browser: fp.browser,
        browserVersion: fp.browserVersion,
        deviceId: fp.deviceId,
    });
    res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    listeners.add(res);
    // Keep-alive heartbeat: SSE comment frames prevent idle-timeout drops on
    // NAT/DERP links (a dropped stream surfaces in the browser as "NetworkError").
    const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
        clearInterval(heartbeat);
        listeners.delete(res);
    };
    req.on('close', cleanup);
});

// ---- static frontend (built via `npm run web:build` -> web/dist) ----
const dist = process.env.PDN_WEB_DIR ?? path.resolve(__dirname, '../../web/dist');
if (existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api')) {
            res.sendFile(path.join(dist, 'index.html'));
        } else {
            next();
        }
    });
}

// ---- error handler ----
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', err);
    res.status(500).json({ error: (err as Error).message ?? 'Internal error' });
});

// ---- background scheduler: check-then-sync loop ----
//
// Every REALTIME_INTERVAL_SECONDS we LOOK (not necessarily sync). Every folder
// pair is real-time; there are no auto-sync schedules. Each tick:
//   1. poll the Drive event feed once (volume-level, marks changed nodes stale
//      so the full walks below re-fetch them - correct for every cache backend),
//   2. check-then-sync each pair: sync when a mapped Drive event points at it,
//      when the feed is opaque (tree_refresh/fast_forward/tree_remove -> full
//      walk), or when the local stat-scan shows a diff; otherwise skip.
// The full three-way walk remains the workhorse; the delta mapping (M1) only
// narrows WHICH pair runs it, and keeps the cache fresh for everyone.

function lastEventIdKey(treeEventScopeId: string): string {
    return `lastEventId:${treeEventScopeId}`;
}

// Last full (un-pruned) local scan per pair. Pruning misses in-place content
// edits (directory mtime does not change on a content-only write), so a full
// scan re-stats every file every FULL_SCAN_INTERVAL seconds to catch those.
// Starts empty so the first tick after boot is always a full scan (catching
// any edits made while the app was down). In-memory only; a restart simply
// full-scans again, which is also what repopulates the pruning baseline.
const lastFullScanAt = new Map<string, number>();

async function schedulerTick(): Promise<void> {
    // Never auto-trigger while a sync is already running (manual or scheduled),
    // while paused, or while a deletion confirmation is awaiting the user.
    if (syncing || paused || pendingDeletion) return;

    // Self-heal the Proton session: a restart leaves the in-memory session empty
    // until a browser hits /api/auth/status. Try to resume once per tick; if it
    // still can't resume, stay silent rather than spamming "Not authenticated".
    if (!authService.isAuthenticated()) {
        const resumed = await authService.resume();
        if (!resumed) return;
    }

    const db = new SyncDB(syncDbPath());
    try {
        const all = db.listPairs();

        // No pairs at all: skip the whole tick.
        if (all.length === 0) return;

        // Poll the event feed once (all pairs share the one "My Files" scope).
        // Its job here is the stale-marking side effect: changed nodes get marked
        // stale so the full walks below re-fetch them from the API instead of
        // serving a stale cache entry. It also supplies the Drive-side change
        // signal that the delta mapping turns into a per-pair decision. We do NOT
        // persist the ID here - only after a clean sync.
        let forceFullWalk = false;
        const driveTargetsByPair = new Map<string, SyncTarget[]>();
        let scope: string | null = null;
        let savedId: string | null = null;
        let processedId: string | null = null;
        try {
            const sdk = authService.getSession().sdk;
            const root = await sdk.getMyFilesRootFolder();
            scope = root.treeEventScopeId;
            savedId = db.getSetting(lastEventIdKey(scope));
            const res = await pollEvents(sdk, scope, savedId);
            processedId = res.lastEventId;
            forceFullWalk = res.treeRefresh || res.fastForward || res.treeRemove;

            if (DELTA_ENABLED && !forceFullWalk && res.nodeEvents.length > 0) {
                const mapped = await mapEventsToTargets(sdk, res.nodeEvents, all, db);
                if (mapped.unmappable.length > 0) {
                    // Could not resolve every event to a pair - full-walk every
                    // pair rather than risk missing a change.
                    forceFullWalk = true;
                    logger.info(`delta: ${mapped.unmappable.length}/${res.nodeEvents.length} event(s) unmappable -> full walk`);
                } else {
                    for (const t of mapped.targets) {
                        const arr = driveTargetsByPair.get(t.pairId) ?? [];
                        arr.push(t);
                        driveTargetsByPair.set(t.pairId, arr);
                    }
                    logger.info(`delta: ${res.nodeEvents.length} event(s) -> pairs [${[...driveTargetsByPair.keys()].join(', ') || 'none'}]`);
                }
            } else if (forceFullWalk && res.nodeEvents.length > 0) {
                logger.info('delta: feed opaque (refresh/fast-forward/remove) -> full walk');
            }
        } catch (error) {
            logger.warn(`Event feed poll failed: ${(error as Error).message ?? error}`);
        }

        // Every pair is real-time. Sync on: an opaque feed (full walk), a mapped
        // Drive event, or a local stat-scan change. When the delta engine is on
        // and the feed is clean, assemble a surgical delta (Drive targets + local
        // diff); otherwise fall back to the full walk. Clean pairs are skipped.
        const toSync = new Set<string>();
        const deltas = new Map<string, DeltaInput>();
        for (const p of all) {
            if (forceFullWalk) {
                toSync.add(p.id);
                continue;
            }
            const targets = DELTA_ENABLED ? (driveTargetsByPair.get(p.id) ?? []) : [];
            let diff: LocalDiff;
            try {
                const now = Date.now();
                const lastFull = lastFullScanAt.get(p.id) ?? 0;
                const fullScan = FULL_SCAN_INTERVAL > 0 && now - lastFull >= FULL_SCAN_INTERVAL * 1000;
                diff = await diffLocal(db, p, { fullScan });
                if (fullScan) lastFullScanAt.set(p.id, now);
            } catch (error) {
                // A missing/erroring local dir is a real problem the full sync
                // surfaces properly (assertSourceAvailable); trigger it instead of
                // silently skipping the pair.
                logger.warn(`Local scan failed for pair ${p.id}: ${(error as Error).message ?? error}`);
                toSync.add(p.id);
                continue;
            }
            const dirty = !localDiffEmpty(diff);
            if (targets.length === 0 && !dirty) continue; // clean - next tick
            toSync.add(p.id);
            if (DELTA_ENABLED) {
                deltas.set(p.id, { targets, localDiff: diff });
                logger.info(`delta: pair ${p.id} -> ${targets.length} Drive target(s), +${diff.added.length} ~${diff.modified.length} -${diff.removed.length}`);
            }
        }

        // Run the syncs, tracking that every one completed cleanly. If any did
        // not (error, abort, tripwire, or an early break), keep the saved event
        // ID so the replayed events are re-processed next tick.
        lastSyncErrored = false;
        let allSynced = true;
        for (const id of toSync) {
            if (syncing || paused) {
                allSynced = false;
                break;
            }
            const started = await runSync(id, false, deltas.get(id) ?? null);
            if (!started || lastSyncErrored) {
                allSynced = false;
                break;
            }
        }

        // Persist the processed event ID only after every triggered sync ran
        // cleanly (or there were no syncs to run).
        if (allSynced && scope !== null && processedId !== null && processedId !== savedId) {
            db.setSetting(lastEventIdKey(scope), processedId);
        }
    } finally {
        db.close();
    }
}

setInterval(() => {
    void schedulerTick();
}, REALTIME_INTERVAL_SECONDS * 1000);

// Check for a newer release once at startup, then every 12h in the background.
startUpdateCheck();

const PORT = parseInt(process.env.PDN_PORT ?? '8787', 10);
void (async () => {
    let tls: TlsConfig;
    try {
        tls = await resolveTls();
    } catch (error) {
        logger.error(`TLS configuration error: ${(error as Error).message}`);
        process.exit(1);
    }
    const server = tls.mode === 'https'
        ? createHttpsServer({ key: tls.key, cert: tls.cert }, app)
        : createHttpServer(app);
    const protocol = tls.mode === 'https' ? 'https' : 'http';
    const certNote = tls.source === 'self-signed' ? ' (self-signed cert)' : tls.source === 'provided' ? ' (provided cert)' : '';
    server.listen(PORT, () => logger.info(`proton-drive-nas-sync server listening on ${protocol}://0.0.0.0:${PORT}${certNote}`));
})();
