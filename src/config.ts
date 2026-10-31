export const APP_VERSION = process.env.PDN_APP_VERSION ?? 'external-drive@0.1.0';
export const BASE_URL = process.env.PROTON_DRIVE_BASE_URL ?? 'drive-api.proton.me';
export const SDK_VERSION = 'js@0.23.0';

/**
 * Which cache backend the Drive SDK uses for its entity cache:
 *   `memory` (default) - unbounded in-memory cache,
 *   `null`             - cache disabled (every scan is cold),
 *   `lru`              - bounded least-recently-used cache (see CACHE_LRU_MAX),
 *   `disk`             - persistent disk-backed cache (see CACHE_DIR), with an
 *                        in-memory LRU front sized by CACHE_LRU_MAX (0 = none).
 * The crypto cache stays in-memory in every mode except `null` (its values are
 * opaque crypto objects and it is small), so `disk` only persists entities.
 */
export const CACHE_MODE = (process.env.PDN_CACHE ?? 'memory').trim().toLowerCase();

/**
 * Max number of entries the LRU backend keeps (only used when CACHE_MODE is
 * `lru`). Drive entities average ~100 KB each, so 10_000 entries is roughly
 * 1 GB. Raise it on big-RAM hosts, lower it on constrained ones. When
 * CACHE_MODE is `disk`, this is the size of the in-memory LRU front (0 = skip
 * the front and read every entry straight from disk).
 */
export const CACHE_LRU_MAX = Number.parseInt(process.env.PDN_CACHE_LRU_MAX ?? '10000', 10);

/**
 * Directory for the disk-backed cache (only used when CACHE_MODE is `disk`).
 * Defaults to `<configDir>/cache` when unset. Mount fast storage (NVMe) here.
 */
export const CACHE_DIR = (process.env.PDN_CACHE_DIR ?? '').trim();
