import { APP_RELEASE_VERSION } from '../config';

/** Result of the "is a newer version available?" check, cached between polls. */
export interface VersionInfo {
    /** The running app's own release version (from package.json). */
    current: string;
    /** Latest published release version ('' when unknown). */
    latest: string;
    /** True when a newer release than `current` exists. */
    updateAvailable: boolean;
    /** URL of the latest release ('' when unknown). */
    releaseUrl: string;
    /** Epoch ms of the last successful check, or null if never checked. */
    checkedAt: number | null;
    /** Set when the last check failed (e.g. no internet); '' otherwise. */
    error?: string;
}

const UPDATE_CHECK_ENABLED = (process.env.PDN_UPDATE_CHECK ?? 'on').trim().toLowerCase() !== 'off';
const REPO = process.env.PDN_RELEASES_REPO ?? 'grumpyspud/proton-drive-nas-sync';
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const POLL_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const TIMEOUT_MS = 10_000;

let cached: VersionInfo = {
    current: APP_RELEASE_VERSION,
    latest: '',
    updateAvailable: false,
    releaseUrl: '',
    checkedAt: null,
};

/** Parse a `x.y.z` (optionally `v`-prefixed) version into numeric parts. */
function parseVersion(v: string): number[] {
    return v
        .replace(/^v/i, '')
        .split('.')
        .map((n) => {
            const p = Number.parseInt(n, 10);
            return Number.isFinite(p) ? p : 0;
        });
}

/** True when `a` is a newer semver than `b`. */
export function semverGt(a: string, b: string): boolean {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
    }
    return false;
}

/** Current cached version info (never fetches; always returns immediately). */
export function getVersionInfo(): VersionInfo {
    return cached;
}

/** Query GitHub for the latest release and refresh the cache. `force` bypasses
 *  the poll-interval guard (used by the periodic timer and the initial check). */
export async function checkForUpdates(force = false): Promise<VersionInfo> {
    if (!UPDATE_CHECK_ENABLED) return cached;
    const now = Date.now();
    if (!force && cached.checkedAt != null && now - cached.checkedAt < POLL_INTERVAL_MS) {
        return cached;
    }
    try {
        const res = await fetch(GITHUB_API, {
            headers: {
                'User-Agent': 'proton-drive-nas-sync',
                Accept: 'application/vnd.github+json',
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
        const data = (await res.json()) as { tag_name?: string; html_url?: string };
        const latest = (data.tag_name ?? '').replace(/^v/i, '');
        cached = {
            current: APP_RELEASE_VERSION,
            latest,
            updateAvailable: latest !== '' && semverGt(latest, APP_RELEASE_VERSION),
            releaseUrl: data.html_url ?? '',
            checkedAt: now,
        };
    } catch (err) {
        // No internet / GitHub down: keep the last known result, surface the
        // error so the UI can stay quiet rather than showing a false positive.
        cached = {
            current: APP_RELEASE_VERSION,
            latest: cached.latest,
            updateAvailable: cached.updateAvailable,
            releaseUrl: cached.releaseUrl,
            checkedAt: cached.checkedAt,
            error: (err as Error).message,
        };
    }
    return cached;
}

/** Kick off the initial check + the periodic background poll. Call once at
 *  server startup. Safe no-op when the update check is disabled. */
export function startUpdateCheck(intervalMs = POLL_INTERVAL_MS): void {
    if (!UPDATE_CHECK_ENABLED) return;
    void checkForUpdates(true);
    setInterval(() => void checkForUpdates(true), intervalMs).unref();
}
