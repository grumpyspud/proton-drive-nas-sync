/**
 * Crypto worker entry: runs the `@protontech/crypto` `Api` endpoint inside a
 * `node:worker_threads` Worker, exposed to the main thread via comlink.
 *
 * Mirrors the package's own browser `worker.ts`, but binds comlink to the node
 * `parentPort` instead of the browser `self` global.  Runs entirely under tsx
 * (the worker inherits the `--import tsx` loader from the main process, so it
 * can load the raw-TS crypto package directly).
 */
import { expose, transferHandlers } from 'comlink';
import { parentPort } from 'node:worker_threads';
import { Api as WorkerApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { workerTransferHandlers } from '@protontech/crypto/proxy/endpoint/workerPool/transferHandlers/index.ts';
import { nodeEndpoint } from './comlinkNode';

if (!parentPort) {
    throw new Error('cryptoWorker.ts must be spawned as a node:worker_threads Worker');
}

workerTransferHandlers.forEach(({ name, handler }) => transferHandlers.set(name, handler));

expose(WorkerApi, nodeEndpoint(parentPort));