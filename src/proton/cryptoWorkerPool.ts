/**
 * Node worker-pool wrapper around the `@protontech/crypto` `Api`.
 *
 * This is a vendored + node-adapted copy of the package's own
 * `getWorkerPoolInstance()` (`src/proxy/endpoint/workerPool/getWorkerPool.ts`),
 * which is NOT reachable through the package's `exports` map.  The only
 * behaviour changes vs. upstream:
 *   - `createWorker` returns a comlink `Endpoint` (from `./comlinkNode`)
 *     instead of a browser `Worker`, so each worker is a `node:worker_threads`
 *     running `./cryptoWorker.ts`.
 *   - `poolSize` has no `navigator.hardwareConcurrency` default (Node has no
 *     `navigator`); callers pass it explicitly.
 *
 * Everything else (round-robin balancing, the "broadcast import/import/generate
 * to every worker" logic, and the one-way transfer handlers) is kept verbatim.
 */
import { releaseProxy, transferHandlers, wrap } from 'comlink';
import type { Endpoint, Remote } from 'comlink';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import type { ApiInterface as CryptoApiInterface } from '@protontech/crypto/proxy/endpoint/api.ts';
import { mainThreadTransferHandlers } from '@protontech/crypto/proxy/endpoint/workerPool/transferHandlers/index.ts';

/** The upstream `InitOptions` is an empty interface. */
type InitOptions = Record<string, never>;
type WorkerInitOptions = InitOptions;
type SentryLogger = (message: string, context?: unknown) => void;

export interface WorkerPoolInitOptions {
    poolSize: number;
    openpgpConfigOptions?: WorkerInitOptions;
    sentryLogger?: SentryLogger | null;
}

export interface WorkerPoolInterface extends CryptoApiInterface {
    init(options: WorkerPoolInitOptions): Promise<void>;
    destroy(): Promise<void>;
}

type OneOrMore<T> = [T, ...T[]];

export function createNodeWorkerPool(createWorker: () => Endpoint): WorkerPoolInterface {
    let workerPoolPromise: Promise<OneOrMore<Remote<CryptoApi>>> | null = null;
    let i = -1;
    let sentryLogger: SentryLogger | null = null;

    const initWorker = async (openpgpConfigOptions: WorkerInitOptions) => {
        const RemoteApi = wrap<typeof CryptoApi>(createWorker());
        await RemoteApi.init(openpgpConfigOptions);
        const worker = await new RemoteApi();
        return worker;
    };

    const destroyWorker = async (worker: Remote<CryptoApi>) => {
        await worker?.clearKeyStore();
        worker?.[releaseProxy]();
    };

    const getWorker = async (fixed = false): Promise<Remote<CryptoApi>> => {
        if (workerPoolPromise === null) throw new Error('Uninitialised worker pool');
        const workerPool = await workerPoolPromise;
        if (fixed) return workerPool[0];
        i = (i + 1) % workerPool.length;
        return workerPool[i]!;
    };

    const getAllWorkers = async (): Promise<OneOrMore<CryptoApi>> => {
        if (workerPoolPromise === null) throw new Error('Uninitialised worker pool');
        const workerPool = await workerPoolPromise;
        return workerPool as unknown as OneOrMore<CryptoApi>;
    };

    const errorReporter = (err: Error) => {
        if (err.name === 'NetworkError' || err.message?.toLowerCase() === 'network error') {
            sentryLogger?.('Network error in crypto worker', { level: 'info', extra: { message: err.message } });
        }
        throw err;
    };

    return {
        init: async ({ poolSize, openpgpConfigOptions = {}, sentryLogger: logger }) => {
            if (workerPoolPromise !== null) throw new Error('worker pool already initialised');
            sentryLogger = logger ?? null;

            workerPoolPromise = (async () => {
                let workerPool: OneOrMore<Remote<CryptoApi>> = [await initWorker(openpgpConfigOptions)];
                if (poolSize > 1) {
                    workerPool = workerPool.concat(
                        await Promise.all(new Array(poolSize - 1).fill(null).map(() => initWorker(openpgpConfigOptions))),
                    ) as OneOrMore<Remote<CryptoApi>>;
                }
                mainThreadTransferHandlers.forEach(({ name, handler }) => transferHandlers.set(name, handler));
                return workerPool;
            })();

            await workerPoolPromise;
        },
        destroy: async () => {
            if (workerPoolPromise) {
                const workerPool = await workerPoolPromise;
                await Promise.all(workerPool.map(destroyWorker));
                workerPoolPromise = null;
            }
        },
        encryptMessage: async (opts) =>
            // @ts-expect-error: Remote<Api> marks the overloaded method non-callable
            (await getWorker()).encryptMessage(opts).catch(errorReporter),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        encryptMessageStream: async (opts: any) => (await getWorker()).encryptMessageStream(opts).catch(errorReporter),
        decryptMessage: async (opts) => (await getWorker()).decryptMessage(opts).catch(errorReporter),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        decryptMessageStream: async (opts: any) => (await getWorker()).decryptMessageStream(opts).catch(errorReporter),
        signMessage: async (opts) =>
            // @ts-expect-error: Remote<Api> marks the overloaded method non-callable
            (await getWorker()).signMessage(opts).catch(errorReporter),
        // @ts-expect-error: Remote<Api> marks the overloaded method non-callable
        verifyMessage: async (opts) => (await getWorker()).verifyMessage(opts),
        verifyCleartextMessage: async (opts) => (await getWorker()).verifyCleartextMessage(opts).catch(errorReporter),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        processMIME: async (opts: any) => (await getWorker()).processMIME(opts).catch(errorReporter),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        computeHash: async (opts: any) => (await getWorker()).computeHash(opts).catch(errorReporter),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        computeHashStream: async (opts: any) => (await getWorker()).computeHashStream(opts).catch(errorReporter),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        computeArgon2: async (opts: any) => (await getWorker(true)).computeArgon2(opts).catch(errorReporter),

        generateSessionKey: async (opts) => (await getWorker()).generateSessionKey(opts).catch(errorReporter),
        generateSessionKeyForAlgorithm: async (opts) =>
            (await getWorker()).generateSessionKeyForAlgorithm(opts).catch(errorReporter),
        encryptSessionKey: async (opts) => (await getWorker()).encryptSessionKey(opts).catch(errorReporter),
        decryptSessionKey: async (opts) => (await getWorker()).decryptSessionKey(opts).catch(errorReporter),
        importPrivateKey: async (opts) => {
            const [first, ...rest] = await getAllWorkers();
            const result = await first.importPrivateKey(opts).catch(errorReporter);
            await Promise.all(rest.map((worker) => worker.importPrivateKey(opts, result._idx)));
            return result;
        },
        importPublicKey: async (opts) => {
            const [first, ...rest] = await getAllWorkers();
            const result = await first.importPublicKey(opts).catch(errorReporter);
            await Promise.all(rest.map((worker) => worker.importPublicKey(opts, result._idx)));
            return result;
        },
        generateKey: async (opts) => {
            const [first, ...rest] = await getAllWorkers();
            const keyReference = await first.generateKey(opts).catch(errorReporter);
            const key = await first.exportPrivateKey({ privateKey: keyReference, passphrase: null, format: 'binary' });
            await Promise.all(rest.map((worker) => worker.importPrivateKey({ binaryKey: key, passphrase: null }, keyReference._idx)));
            return keyReference;
        },
        reformatKey: async (opts) => {
            const [first, ...rest] = await getAllWorkers();
            const keyReference = await first.reformatKey(opts).catch(errorReporter);
            const key = await first.exportPrivateKey({ privateKey: keyReference, passphrase: null, format: 'binary' });
            await Promise.all(rest.map((worker) => worker.importPrivateKey({ binaryKey: key, passphrase: null }, keyReference._idx)));
            return keyReference;
        },
        generateE2EEForwardingMaterial: async (opts) =>
            (await getWorker()).generateE2EEForwardingMaterial(opts).catch(errorReporter),
        doesKeySupportE2EEForwarding: async (opts) =>
            (await getWorker()).doesKeySupportE2EEForwarding(opts).catch(errorReporter),
        isE2EEForwardingKey: async (opts) => (await getWorker()).isE2EEForwardingKey(opts).catch(errorReporter),

        replaceUserIDs: async (opts) => {
            await Promise.all((await getAllWorkers()).map((worker) => worker.replaceUserIDs(opts)));
        },
        cloneKeyAndChangeUserIDs: async (opts) => {
            const [first, ...rest] = await getAllWorkers();
            const keyReference = await first.cloneKeyAndChangeUserIDs(opts).catch(errorReporter);
            const key = await first.exportPrivateKey({ privateKey: keyReference, passphrase: null, format: 'binary' });
            await Promise.all(rest.map((worker) => worker.importPrivateKey({ binaryKey: key, passphrase: null }, keyReference._idx)));
            return keyReference;
        },
        exportPublicKey: async (opts) => (await getWorker()).exportPublicKey(opts).catch(errorReporter),
        exportPrivateKey: async (opts) => (await getWorker()).exportPrivateKey(opts).catch(errorReporter),
        clearKeyStore: async () => {
            await Promise.all((await getAllWorkers()).map((worker) => worker.clearKeyStore()));
        },
        clearKey: async (opts) => {
            await Promise.all((await getAllWorkers()).map((worker) => worker.clearKey(opts)));
        },

        isExpiredKey: async (opts) => (await getWorker()).isExpiredKey(opts).catch(errorReporter),
        isRevokedKey: async (opts) => (await getWorker()).isRevokedKey(opts).catch(errorReporter),
        canKeyEncrypt: async (opts) => (await getWorker()).canKeyEncrypt(opts).catch(errorReporter),
        getMessageInfo: async (opts) => (await getWorker()).getMessageInfo(opts).catch(errorReporter),
        getKeyInfo: async (opts) => (await getWorker()).getKeyInfo(opts).catch(errorReporter),
        getSignatureInfo: async (opts) => (await getWorker()).getSignatureInfo(opts).catch(errorReporter),
        getArmoredKeys: async (opts) => (await getWorker()).getArmoredKeys(opts),
        getArmoredSignature: async (opts) => (await getWorker()).getArmoredSignature(opts),
        getArmoredMessage: async (opts) => (await getWorker()).getArmoredMessage(opts),
    } as WorkerPoolInterface;
}