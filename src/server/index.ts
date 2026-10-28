import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '../crypto/keySource';
import { findOrCreateFolder } from '../fs/folders';
import { syncOnce } from '../engine/sync';
import type { ProgressHandler, SyncProgressEvent } from '../engine/progress';
import { logger } from '../logger';
import { SyncDB } from '../state/syncDb';
import { authService } from './auth';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
}

let syncing = false;

async function runSync(pairId: string): Promise<boolean> {
    if (syncing) return false;
    syncing = true;
    const db = new SyncDB(syncDbPath());
    try {
        const pair = db.getPair(pairId);
        if (!pair) return false;

        const session = authService.getSession();
        // Re-resolve the Drive folder each cycle (robust against renames/recreates).
        const root = await session.sdk.getMyFilesRootFolder();
        const driveFolderUid = await findOrCreateFolder(session.sdk, root.uid, pair.driveFolderName);
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
        });
        broadcast({ type: 'sync-complete', summary });
        return true;
    } catch (error) {
        logger.error('Sync failed', error);
        broadcast({ type: 'sync-error', message: (error as Error).message ?? String(error) });
        return true;
    } finally {
        syncing = false;
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
    const { username, password, twoFactorCode, mailboxPassword } = body as Record<string, string | undefined>;
    if (!username || !password) {
        res.status(400).json({ error: 'username and password are required' });
        return;
    }
    const result = await authService.login(username, password, twoFactorCode, mailboxPassword);
    res.json(result);
});

app.post('/api/auth/logout', async (_req, res) => {
    await authService.logout();
    res.json({ ok: true });
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
    const body = req.body ?? {};
    const { localDir, driveFolderName } = body as Record<string, string | undefined>;
    if (!localDir || !driveFolderName) {
        res.status(400).json({ error: 'localDir and driveFolderName are required' });
        return;
    }
    const db = new SyncDB(syncDbPath());
    try {
        const session = authService.getSession();
        const root = await session.sdk.getMyFilesRootFolder();
        const driveFolderUid = await findOrCreateFolder(session.sdk, root.uid, driveFolderName);
        const pair = { id: pairIdFor(localDir, driveFolderName), localDir, driveFolderName, driveFolderUid };
        db.upsertPair(pair);
        res.json({ pair });
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

app.post('/api/sync/:id', requireAuth, async (req, res) => {
    const started = await runSync(req.params.id as string);
    if (!started) {
        res.status(409).json({ error: 'Sync already in progress or pair not found' });
        return;
    }
    res.json({ started: true });
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

const PORT = parseInt(process.env.PDN_PORT ?? '8787', 10);
app.listen(PORT, () => logger.info(`proton-drive-nas-sync server listening on http://0.0.0.0:${PORT}`));
