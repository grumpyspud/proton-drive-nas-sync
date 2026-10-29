import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';
import { logger } from '../logger';
import { nodeEndpoint } from './comlinkNode';
import { createNodeWorkerPool } from './cryptoWorkerPool';

/** Upper bound on auto-detected workers — each worker loads the crypto package
 *  (~50–100 MB), so on a high-core NAS we cap rather than spawn a thread per core. */
const MAX_AUTO_WORKERS = 8;

/**
 * How many crypto worker threads to spin up (0 = disabled, run inline on the
 * main thread). Node decryption is CPU-bound and single-threaded inline, so
 * multiple workers parallelise the `decryptNode` work the SDK already issues
 * 30-at-a-time during a Drive walk.
 *
 * Default = the number of CPU cores available to the process (respects a
 * container CPU limit), capped at {@link MAX_AUTO_WORKERS}. Override with
 * `PDN_CRYPTO_WORKERS` (0 disables and falls back to inline single-threaded).
 * More workers than cores buys nothing and adds thread-switching overhead.
 */
function cryptoWorkerCount(): number {
    const raw = process.env.PDN_CRYPTO_WORKERS;
    if (raw === undefined) {
        return Math.max(0, Math.min(availableParallelism(), MAX_AUTO_WORKERS));
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        return Math.max(0, Math.min(availableParallelism(), MAX_AUTO_WORKERS));
    }
    return Math.max(0, Math.floor(n));
}

/**
 * Initialises the OpenPGP crypto endpoint and returns the SDK crypto module.
 *
 * Mirrors the reference CLI's `initOpenPGPCryptoModule()`, except that when
 * `PDN_CRYPTO_WORKERS >= 2` the crypto endpoint is a pool of `worker_threads`
 * (each running `./cryptoWorker.ts`) instead of the inline single-threaded
 * `Api` — parallelising the CPU-bound decrypt/sign/verify work.
 *
 * The crypto package keeps its endpoint in module-level state, so the endpoint
 * is initialised once and the same `CryptoProxy` singleton is shared with the
 * account module (address keyring unlock) and the Drive SDK.
 */
export async function initOpenPGPCryptoModule(): Promise<OpenPGPCryptoWithCryptoProxy> {
    const workers = cryptoWorkerCount();

    if (workers >= 2) {
        const pool = createNodeWorkerPool(() =>
            nodeEndpoint(new Worker(new URL('./cryptoWorker.ts', import.meta.url))),
        );
        CryptoProxy.setEndpoint(pool, (endpoint) => endpoint.clearKeyStore());
        await pool.init({ poolSize: workers });
        logger.info(`Crypto endpoint: worker pool of ${workers} threads`);
        return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
    }

    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    logger.info('Crypto endpoint: inline (single-threaded)');
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}