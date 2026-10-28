import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../crypto/keySource';
import { listLocalDir, mkdirLocal } from '../fs/browse';
import { findFolder, findOrCreateFolderPath } from '../fs/folders';
import { nodeName } from '../fs/files';
import { clearTrash, deleteTrashItem, listTrash, restoreTrashItem } from '../fs/trash';
import { NodeType } from '@protontech/drive-sdk';
import { syncOnce, SyncAbortedError } from '../engine/sync';
import type { ProgressHandler, SyncProgressEvent } from '../engine/progress';
import { logger } from '../logger';
import { SyncDB, type Pair } from '../state/syncDb';
import { authService } from './auth';
import { appendSyncLog, querySyncLog, syncLogPath } from './syncLog';

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
    realTime?: boolean;
    autoSync?: boolean;
    intervalSeconds?: number;
}

function pairIdFor(localDir: string, driveFolderName: string): string {
    return createHash('sha256').update(`${localDir}\n${driveFolderName}`).digest('hex').slice(0, 16);
}

function syncDbPath(): string {
    return process.env.PDN_STATE_DB ?? path.join(configDir(), 'sync.db');
}

// ---- SSE broadcast: one sync at a time, many browser listeners ----
const listeners = new Set<Response>();
function broadcast(event: SyncProgressEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) res.write(data);
    appendSyncLog(event);
}

// Per-file progress bars are only shown for files >= this size (bytes); 0 disables
// them entirely (the overall bar still shows). Overridable via PDN_PROGRESS_MIN_BYTES.
const PROGRESS_MIN_BYTES = (() => {
    const raw = process.env.PDN_PROGRESS_MIN_BYTES;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
})();

let syncing = false;
let paused = false;
let stopRequested = false;

async function runSync(pairId: string): Promise<boolean> {
    if (syncing || paused) return false;
    syncing = true;
    stopRequested = false;
    const db = new SyncDB(syncDbPath());
    try {
        const pair = db.getPair(pairId);
        if (!pair) return false;

        const session = authService.getSession();
        // Re-resolve the Drive folder each cycle (robust against renames/recreates).
        const root = await session.sdk.getMyFilesRootFolder();
        const driveFolderUid = await findOrCreateFolderPath(session.sdk, root.uid, pair.driveFolderName);
        db.upsertPair({ ...pair, driveFolderUid });

        const onProgress: ProgressHandler = (event) => broadcast(event);
        const summary = await syncOnce({
            sdk: session.sdk,
            pairId,
            localDir: pair.localDir,
            driveFolderUid,
            driveFolderName: pair.driveFolderName,
            db,
            onProgress,
            shouldAbort: () => paused || stopRequested,
            progressMinBytes: PROGRESS_MIN_BYTES,
        });
        db.markSynced(pairId);
        broadcast({ type: 'sync-complete', summary });
        return true;
    } catch (error) {
        if (error instanceof SyncAbortedError) {
            if (paused) broadcast({ type: 'sync-paused' });
            else broadcast({ type: 'sync-stopped' });
            return true;
        }
        logger.error('Sync failed', error);
        broadcast({ type: 'sync-error', message: (error as Error).message ?? String(error) });
        return true;
    } finally {
        syncing = false;
        stopRequested = false;
        db.close();
    }
}

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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

app.post('/api/auth/logout', async (_req, res) => {
    await authService.logout();
    res.json({ ok: true });
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

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!authService.isAuthenticated()) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    next();
}

app.get('/api/pairs', requireAuth, (_req, res) => {
    const db = new SyncDB(syncDbPath());
    try {
        res.json({ pairs: db.listPairs() });
    } finally {
        db.close();
    }
});

app.post('/api/pairs', requireAuth, async (req, res) => {
    const { localDir, driveFolderName, realTime, autoSync, intervalSeconds } = (req.body ?? {}) as PairBody;
    if (!localDir) {
        res.status(400).json({ error: 'localDir is required' });
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
            realTime: !!realTime,
            autoSync: !!autoSync,
            intervalSeconds: typeof intervalSeconds === 'number' ? intervalSeconds : 0,
            lastSyncAt: null,
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
            realTime: typeof body.realTime === 'boolean' ? body.realTime : pair.realTime,
            autoSync: typeof body.autoSync === 'boolean' ? body.autoSync : pair.autoSync,
            intervalSeconds: typeof body.intervalSeconds === 'number' ? body.intervalSeconds : pair.intervalSeconds,
        };
        if (updated.autoSync && updated.intervalSeconds <= 0) updated.intervalSeconds = 3600;
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

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
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

// ---- background scheduler: real-time (fixed 10s poll) + auto-sync (interval) ----
const REAL_TIME_INTERVAL_MS = 10_000;

function duePairs(db: SyncDB): Pair[] {
    const now = Date.now();
    return db.listPairs().filter((p) => {
        if (p.realTime) return true;
        if (p.autoSync && p.intervalSeconds > 0) return now - (p.lastSyncAt ?? 0) >= p.intervalSeconds * 1000;
        return false;
    });
}

async function schedulerTick(): Promise<void> {
    if (syncing || paused) return;
    const ids: string[] = [];
    {
        const db = new SyncDB(syncDbPath());
        try {
            for (const p of duePairs(db)) ids.push(p.id);
        } finally {
            db.close();
        }
    }
    for (const id of ids) {
        const started = await runSync(id);
        if (!started) break;
    }
}

setInterval(() => {
    void schedulerTick();
}, REAL_TIME_INTERVAL_MS);

const PORT = parseInt(process.env.PDN_PORT ?? '8787', 10);
app.listen(PORT, () => logger.info(`proton-drive-nas-sync server listening on http://0.0.0.0:${PORT}`));
