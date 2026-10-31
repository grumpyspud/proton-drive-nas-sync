export const APP_VERSION = process.env.PDN_APP_VERSION ?? 'external-drive@0.1.0';
export const BASE_URL = process.env.PROTON_DRIVE_BASE_URL ?? 'drive-api.proton.me';
export const SDK_VERSION = 'js@0.23.0';

/**
 * Which cache backend the Drive SDK uses for its entity + crypto caches:
 *   `memory` (default) - unbounded in-memory cache,
 *   `null`             - cache disabled (every scan is cold),
 *   `lru`              - bounded least-recently-used cache (see CACHE_LRU_MAX).
 */
export const CACHE_MODE = (process.env.PDN_CACHE ?? 'memory').trim().toLowerCase();

/**
 * Max number of entries the LRU backend keeps (only used when CACHE_MODE is
 * `lru`). Drive entities average ~100 KB each, so 10_000 entries is roughly
 * 1 GB. Raise it on big-RAM hosts, lower it on constrained ones.
 */
export const CACHE_LRU_MAX = Number.parseInt(process.env.PDN_CACHE_LRU_MAX ?? '10000', 10);
