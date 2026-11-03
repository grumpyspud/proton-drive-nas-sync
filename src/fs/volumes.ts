import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../config';
import { configDir } from '../crypto/keySource';

// Pseudo/virtual filesystems we never want to surface as "storage".
const PSEUDO_FS = new Set([
    'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2',
    'mqueue', 'shm', 'autofs', 'nsfs', 'overlay', 'squashfs', 'debugfs',
    'tracefs', 'securityfs', 'pstore', 'hugetlbfs', 'configfs', 'binfmt_misc',
    'fusectl', 'efivarfs', 'ramfs',
]);

// Paths that belong to the container / app, not the user's NAS data.
const SYSTEM_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/etc', '/var', '/usr', '/lib', '/bin', '/sbin', '/tmp', '/root', '/home', '/opt', '/app'];

function unescapeMountField(s: string): string {
    return s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** The disk-cache directory (PDN_CACHE_DIR, else <configDir>/cache). */
function cacheDirPath(): string {
    return CACHE_DIR !== '' ? CACHE_DIR : path.join(configDir(), 'cache');
}

function isSystemMountPoint(mp: string): boolean {
    if (mp === '/' || mp === '/config') return true;
    const cacheDir = cacheDirPath();
    if (mp === cacheDir || mp.startsWith(`${cacheDir}${path.sep}`)) return true;
    return SYSTEM_MOUNT_PREFIXES.some((p) => mp === p || mp.startsWith(`${p}/`));
}

/** Parse /proc/self/mountinfo and return the bind-mounted data paths. */
function detectDataMountPaths(mountInfo: string): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const line of mountInfo.split('\n')) {
        if (!line) continue;
        const parts = line.split(' ');
        const sep = parts.indexOf('-');
        if (sep < 0 || sep + 1 >= parts.length) continue;
        const fstype = parts[sep + 1];
        if (!fstype || PSEUDO_FS.has(fstype)) continue;
        const mountField = parts[4];
        if (!mountField) continue;
        const mountPoint = unescapeMountField(mountField);
        if (!mountPoint) continue;
        if (isSystemMountPoint(mountPoint)) continue;
        if (seen.has(mountPoint)) continue;
        seen.add(mountPoint);
        paths.push(mountPoint);
    }
    if (paths.length === 0) paths.push('/data');
    return paths;
}

/**
 * Data volumes = every non-system, non-pseudo filesystem bind-mounted into the
 * container (e.g. /data, or NAS shares under /data/<name>). /config and the
 * container's own overlay/root are excluded. Falls back to /data if no mounts
 * are detected.
 */
export function dataMountPaths(): string[] {
    try {
        return detectDataMountPaths(readFileSync('/proc/self/mountinfo', 'utf8'));
    } catch {
        return ['/data'];
    }
}

/** The data mount that contains `abs`, or null if it is outside every mount. */
export function containingDataMount(abs: string): string | null {
    for (const r of dataMountPaths()) {
        const rAbs = path.resolve(r);
        if (abs === rAbs || abs.startsWith(`${rAbs}${path.sep}`)) return r;
    }
    return null;
}

/** True if `input` is equal to, or inside, a bind-mounted data volume. */
export function isSafeLocalPath(input: string): boolean {
    if (!input) return false;
    const abs = path.resolve(input);
    const cacheDir = path.resolve(cacheDirPath());
    if (abs === cacheDir || abs.startsWith(`${cacheDir}${path.sep}`)) return false;
    return containingDataMount(abs) !== null;
}
