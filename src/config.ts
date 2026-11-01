export const APP_VERSION = process.env.PDN_APP_VERSION ?? 'external-drive@0.1.0';
export const BASE_URL = process.env.PROTON_DRIVE_BASE_URL ?? 'drive-api.proton.me';
export const SDK_VERSION = 'js@0.23.0';

/**
 * Which cache backend the Drive SDK uses for its entity cache:
 *   `disk` (default) - persistent disk-backed cache (see CACHE_DIR), with an
 *                      in-memory LRU front sized by CACHE_LRU_MAX (0 = none).
 *   `memory`         - unbounded in-memory cache,
 *   `lru`            - bounded least-recently-used cache (see CACHE_LRU_MAX),
 *   `null`           - cache disabled (every scan is cold).
 * The crypto cache stays in-memory in every mode except `null` (its values are
 * opaque crypto objects and it is small), so `disk` only persists entities.
 */
export const CACHE_MODE = (process.env.PDN_CACHE ?? 'disk').trim().toLowerCase();

/**
 * Max number of entries the LRU backend keeps (only used when CACHE_MODE is
 * `lru`), or the size of the in-memory LRU front when CACHE_MODE is `disk`
 * (0 = skip the front and read every entry straight from disk). Keep this
 * modest to bound RAM; raise it on big-RAM hosts, lower it on constrained ones.
 */
export const CACHE_LRU_MAX = Number.parseInt(process.env.PDN_CACHE_LRU_MAX ?? '2000', 10);

/**
 * Directory for the disk-backed cache (only used when CACHE_MODE is `disk`).
 * Defaults to `<configDir>/cache` when unset. Mount fast storage (NVMe) here.
 */
export const CACHE_DIR = (process.env.PDN_CACHE_DIR ?? '').trim();

/**
 * Real-time (check-then-sync) poll interval in seconds: how often the server
 * polls the Drive event feed and stat-scans local dirs to decide whether to
 * sync. Default 30; clamped to [10, 60]. Values below 10 become 10 (Proton
 * rate-limit + NAS I/O guard), values above 60 become 60 (past that it is no
 * longer "real-time", it is the scheduled auto-sync).
 */
const REALTIME_INTERVAL_RAW = Number.parseInt(process.env.PDN_REALTIME_INTERVAL ?? '30', 10);
export const REALTIME_INTERVAL_SECONDS = Number.isFinite(REALTIME_INTERVAL_RAW)
    ? Math.min(60, Math.max(10, REALTIME_INTERVAL_RAW))
    : 30;

/**
 * Feature flag for the event-driven delta sync (Phase 2+3). When 'off', the
 * scheduler falls back to today's behavior: any Drive change full-walks every
 * real-time pair. Default ON: map events to their pairs and full-walk only the
 * affected pairs (targeted per-node ops come in a later milestone). `off` is
 * the instant-rollback switch.
 */
export const DELTA_ENABLED = (process.env.PDN_DELTA ?? 'on').trim().toLowerCase() !== 'off';

/**
 * Whether to write per-file `[skip]` lines (unchanged files) to sync.log.
 * Default OFF: skipping them keeps sync.log small and speeds up reconciles on
 * large trees. Set to 'on' for full logging when troubleshooting.
 */
export const LOG_SKIPS = (process.env.PDN_LOG_SKIPS ?? 'off').trim().toLowerCase() === 'on';

/**
 * Whether to prune the local stat-scan with directory mtimes. When 'on'
 * (default), each tick stats only the directories and descends into the ones
 * whose mtime changed, catching add/remove/rename without stat-ing every file.
 * In-place content edits do NOT bump a directory's mtime, so a full file scan
 * still runs every FULL_SCAN_INTERVAL seconds to catch those. 'off' restores
 * the always-full scan (status-quo behavior).
 */
export const LOCAL_PRUNE = (process.env.PDN_LOCAL_PRUNE ?? 'on').trim().toLowerCase() !== 'off';

/**
 * Seconds between full local file scans while LOCAL_PRUNE is on. A full scan
 * re-stats every file, so it is the only thing that catches in-place content
 * edits (which directory mtimes miss). Default 300 (5 min); 0 disables the
 * periodic scan entirely (only add/remove/rename are detected).
 */
export const FULL_SCAN_INTERVAL = Math.max(0, Number.parseInt(process.env.PDN_FULL_SCAN_INTERVAL ?? '300', 10) || 0);
